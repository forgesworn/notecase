import {afterEach, describe, expect, it} from 'vitest'
import {createMockMint} from 'lnurlcash-conformance/mock-mint'
import {AmbiguousMintError, PendingNoteError, ProtocolError, hashK1} from 'lnurlcash-kit'
import {fakeBolt11} from '@forgesworn/moneyer'
import {InsufficientFundsError, Wallet} from '../src/wallet.ts'
import type {PendingMint, WalletData} from '../src/types.ts'
import {freshK1, makeWallet, waitMs} from './helpers.ts'

// The wallet against the adversarial mock mint: every misbehaviour a
// holder must survive, driven through the real client stack. The mock is
// the conformance suite's - the same one every other implementation in the
// programme is graded against.

type Mint = Awaited<ReturnType<typeof createMockMint>>
let mint: Mint | null = null
const start = async (options: Record<string, unknown> = {}): Promise<Mint> => {
  mint = await createMockMint(options)
  return mint
}
afterEach(async () => {
  await mint?.close()
  mint = null
})

const fund = (theMint: Mint, amountMsat: number): {k1: string; url: string} => {
  const k1 = freshK1()
  theMint.state.creditNote(k1, amountMsat)
  return {k1, url: `${theMint.url}/w?k1=${k1}&amount=${amountMsat}`}
}

describe('receiving', () => {
  it('rotates on receive, pins the mint key, and keeps the signature', async () => {
    const theMint = await start()
    const {wallet, data} = makeWallet()
    const note = fund(theMint, 21_000)

    const result = await wallet.receive(note.url)
    expect(result.warnings).toEqual([])
    expect(result.note.state).toBe('live')
    expect(result.note.amountMsat).toBe(21_000)
    expect(result.note.k1).not.toBe(note.k1)
    expect(result.note.signature).toBeDefined()
    expect(theMint.state.noteState(note.k1)).toBe('burned')
    expect(data.pubkeyPins[new URL(theMint.url).host]).toBe(theMint.state.pubkey)
    expect(wallet.balanceMsat()).toBe(21_000)
  })

  it('warns when the URL claims a different amount than the mint reports', async () => {
    const theMint = await start()
    const {wallet} = makeWallet()
    const {k1} = fund(theMint, 21_000)
    const result = await wallet.receive(`${theMint.url}/w?k1=${k1}&amount=999999`)
    expect(result.warnings.some(warning => warning.includes('authoritative'))).toBe(true)
    expect(result.note.amountMsat).toBe(21_000)
  })

  it('stores nothing when the mint echoes back a different k1', async () => {
    const theMint = await start({echoWrongK1: true})
    const {wallet, data} = makeWallet()
    const note = fund(theMint, 21_000)
    await expect(wallet.receive(note.url)).rejects.toThrow(ProtocolError)
    expect(data.notes).toHaveLength(0)
  })
})

describe('sending', () => {
  it('splits a larger note and keeps the change', async () => {
    const theMint = await start()
    const {wallet} = makeWallet()
    await wallet.receive(fund(theMint, 100_000).url)

    const sent = await wallet.send(30_000)
    expect(sent.amountMsat).toBe(30_000)
    expect(sent.state).toBe('sent')
    expect(wallet.balanceMsat()).toBe(70_000)
    // and the sent note really is spendable by its recipient
    const {wallet: recipient} = makeWallet()
    const received = await recipient.receive(wallet.noteUrlFor(sent))
    expect(received.note.amountMsat).toBe(30_000)
  })

  it('gathers several notes in one request when none is big enough', async () => {
    const theMint = await start()
    const {wallet} = makeWallet()
    await wallet.receive(fund(theMint, 10_000).url)
    await wallet.receive(fund(theMint, 8_000).url)
    await wallet.receive(fund(theMint, 5_000).url)

    const sent = await wallet.send(15_000)
    expect(sent.amountMsat).toBe(15_000)
    expect(wallet.balanceMsat()).toBe(8_000)
  })

  it('refuses politely when funds are short', async () => {
    const theMint = await start()
    const {wallet} = makeWallet()
    await wallet.receive(fund(theMint, 5_000).url)
    await expect(wallet.send(21_000)).rejects.toThrow(InsufficientFundsError)
  })
})

describe('the crash window', () => {
  it('survives a mutation whose outcome is destroyed mid-flight', async () => {
    const theMint = await start({dropAfterMutation: true})
    const {wallet, data, saves} = makeWallet()
    const note = fund(theMint, 21_000)

    // The receive's rotate lands at the mint but the answer never arrives.
    await expect(wallet.receive(note.url)).rejects.toThrow(AmbiguousMintError)
    const staged = data.notes.find(record => record.state === 'ambiguous' && record.replaces?.length)
    expect(staged).toBeDefined()
    expect(saves()).toBeGreaterThanOrEqual(2)
    expect(wallet.balanceMsat()).toBe(0)

    // Connectivity returns; reconcile learns the burn landed and that the
    // staged secret is the only copy of the money.
    theMint.state.opts.dropAfterMutation = false
    const events = await wallet.reconcile()
    expect(events.some(event => event.kind === 'output-recovered')).toBe(true)
    expect(wallet.balanceMsat()).toBe(21_000)
    const recovered = data.notes.find(record => record.id === staged!.id)
    expect(recovered?.state).toBe('live')
  })

  it('unwinds cleanly when the mutation never landed at all', async () => {
    const theMint = await start()
    const {wallet, data} = makeWallet()
    const received = await wallet.receive(fund(theMint, 21_000).url)

    // A split that never reaches the mint: the callback points at a dead
    // port, so the request fails ambiguously with nothing applied.
    const note = data.notes.find(record => record.id === received.note.id)!
    const realCallback = note.callback
    note.callback = 'http://127.0.0.1:1/w/cb'
    await expect(wallet.send(9_000)).rejects.toThrow(AmbiguousMintError)
    expect(wallet.balanceMsat()).toBe(0)
    const staged = data.notes.filter(record => record.state === 'ambiguous' && record.replaces?.length)
    expect(staged.length).toBeGreaterThan(0)

    // Connectivity returns; the probe finds the input alive, so the staged
    // outputs minted nothing and are discarded.
    note.callback = realCallback
    const events = await wallet.reconcile()
    expect(events.some(event => event.kind === 'mutation-unwound')).toBe(true)
    expect(wallet.balanceMsat()).toBe(21_000)
    expect(wallet.noteById(received.note.id)?.state).toBe('live')
  })
})

describe('melting', () => {
  it('confirms a settled melt through LUD-21 verify', async () => {
    const theMint = await start()
    const {wallet, data} = makeWallet()
    await wallet.receive(fund(theMint, 21_000).url)

    const {melt} = await wallet.melt(fakeBolt11({amountMsat: 21_000, paymentHashHex: hashK1(freshK1())}), 'invoice')
    expect(melt.state).toBe('in-flight')
    expect(wallet.balanceMsat()).toBe(0)

    await waitMs(50) // the mock settles its melts asynchronously
    const events = await wallet.reconcile()
    expect(events.some(event => event.kind === 'melt-settled')).toBe(true)
    expect(data.melts[0]!.state).toBe('settled')
    expect(wallet.noteById(melt.noteId)?.state).toBe('spent')
  })

  it('recovers the note under a fresh secret when the melt fails', async () => {
    const theMint = await start({meltAlwaysFails: true})
    const {wallet, data} = makeWallet()
    await wallet.receive(fund(theMint, 21_000).url)

    const {melt} = await wallet.melt(fakeBolt11({amountMsat: 21_000, paymentHashHex: hashK1(freshK1())}), 'invoice')
    await waitMs(50) // the mock restores the note asynchronously
    const events = await wallet.reconcile()
    expect(events.some(event => event.kind === 'melt-returned')).toBe(true)
    expect(data.melts[0]!.state).toBe('returned')
    expect(wallet.balanceMsat()).toBe(21_000)
    // recovered under a NEW secret, never the one the melt disclosed
    const live = wallet.liveNotes()[0]!
    expect(live.id).not.toBe(melt.noteId)
  })

  it('holds steady while a melt never settles, and locks the note', async () => {
    const theMint = await start({meltNeverSettles: true})
    const {wallet} = makeWallet()
    const received = await wallet.receive(fund(theMint, 21_000).url)

    await wallet.melt(fakeBolt11({amountMsat: 21_000, paymentHashHex: hashK1(freshK1())}), 'invoice')
    const events = await wallet.reconcile()
    expect(events.some(event => event.kind === 'melt-pending')).toBe(true)
    expect(wallet.noteById(received.note.id)?.state).toBe('melting')
    // the locked note refuses everything else with the spec's reason
    await expect(wallet.send(21_000)).rejects.toThrow(InsufficientFundsError)
  })

})

describe('mint fees', () => {
  // LUD-25: a fee-advertising mint takes base_fee_msat out of every
  // split's change and refunds (n - 1) of them on a merge of n. The
  // wallet prices its own mutations off the cached advertisement.
  const feeMint = () => start({baseFeeMsat: 1000, feePpm: 0})

  it('prices a split with the advertised fee', async () => {
    const theMint = await feeMint()
    const {wallet} = makeWallet()
    await wallet.addMint(`mint@${new URL(theMint.url).host}`)
    await wallet.receive(fund(theMint, 21_000).url)

    const sent = await wallet.send(8_000)
    expect(sent.amountMsat).toBe(8_000)
    expect(wallet.balanceMsat()).toBe(12_000)
    // and the mint's own books agree
    const change = wallet.liveNotes()[0]!
    expect(theMint.state.notes.get(change.id)?.amountMsat).toBe(12_000)
  })

  it('gathers several notes with fee-aware change', async () => {
    const theMint = await feeMint()
    const {wallet} = makeWallet()
    await wallet.addMint(`mint@${new URL(theMint.url).host}`)
    await wallet.receive(fund(theMint, 10_000).url)
    await wallet.receive(fund(theMint, 8_000).url)

    const sent = await wallet.send(14_000)
    expect(sent.amountMsat).toBe(14_000)
    expect(wallet.balanceMsat()).toBe(3_000)
  })

  it('refuses politely when the change cannot cover the split fee', async () => {
    const theMint = await feeMint()
    const {wallet} = makeWallet()
    await wallet.addMint(`mint@${new URL(theMint.url).host}`)
    await wallet.receive(fund(theMint, 10_000).url)
    await expect(wallet.send(9_500)).rejects.toThrow(InsufficientFundsError)
    expect(wallet.balanceMsat()).toBe(10_000)
  })

  it('corrects amounts from the mint when the fee was never advertised to us', async () => {
    // no addMint: the host's fee is unknown, so the wallet prices
    // fee-free and then asks the mint what the outputs are really worth
    const theMint = await feeMint()
    const {wallet} = makeWallet()
    await wallet.receive(fund(theMint, 21_000).url)
    await wallet.send(8_000)
    expect(wallet.balanceMsat()).toBe(12_000)
  })
})

describe('pending lockout', () => {
  it('surfaces the pending state on a mutation racing a melt', async () => {
    const theMint = await start({meltNeverSettles: true})
    const {wallet, data} = makeWallet()
    const received = await wallet.receive(fund(theMint, 21_000).url)

    await wallet.melt(fakeBolt11({amountMsat: 21_000, paymentHashHex: hashK1(freshK1())}), 'invoice')
    // force a mutation on the melting note, as a buggy caller might - a
    // split has to go to the wire, and the mint answers "pending"
    const note = data.notes.find(record => record.id === received.note.id)!
    note.state = 'live'
    await expect(wallet.send(9_000)).rejects.toThrow(PendingNoteError)
    // nothing was staged permanently by the refusal
    expect(data.notes.filter(record => record.state === 'staged')).toHaveLength(0)
  })
})

describe('sent notes', () => {
  it('reclaims an unclaimed sent note under a fresh secret', async () => {
    const theMint = await start()
    const {wallet} = makeWallet()
    await wallet.receive(fund(theMint, 50_000).url)
    const sent = await wallet.send(20_000)
    expect(wallet.sentNotes()).toHaveLength(1)
    expect(wallet.balanceMsat()).toBe(30_000)

    const result = await wallet.reclaim(sent)
    expect(result.note.state).toBe('live')
    expect(result.note.k1).not.toBe(sent.k1)
    expect(wallet.sentNotes()).toHaveLength(0)
    expect(wallet.balanceMsat()).toBe(50_000)
    // the old secret is dead to whoever saw it
    expect(theMint.state.noteState(sent.k1)).toBe('burned')
  })

  it('cannot reclaim a note the recipient already took, and markTaken resolves it', async () => {
    const theMint = await start()
    const {wallet} = makeWallet()
    await wallet.receive(fund(theMint, 50_000).url)
    const sent = await wallet.send(20_000)

    const {wallet: recipient} = makeWallet()
    await recipient.receive(wallet.noteUrlFor(sent))

    await expect(wallet.reclaim(sent)).rejects.toThrow()
    expect(sent.state).toBe('sent')
    await wallet.markTaken(sent)
    expect(sent.state).toBe('spent')
    expect(wallet.sentNotes()).toHaveLength(0)
  })

  it('refuses to reclaim or mark anything that is not sent', async () => {
    const theMint = await start()
    const {wallet} = makeWallet()
    const {note} = await wallet.receive(fund(theMint, 21_000).url)
    await expect(wallet.reclaim(note)).rejects.toThrow('Only a sent note')
    await expect(wallet.markTaken(note)).rejects.toThrow('Only a sent note')
  })
})

describe('the mints directory', () => {
  it('sets the default and refuses unknown hosts', async () => {
    const theMint = await start()
    const {wallet, data} = makeWallet()
    await wallet.addMint(`mint@${new URL(theMint.url).host}`)
    const host = new URL(theMint.url).host
    await wallet.setDefaultMint(host)
    expect(data.settings.defaultMintHost).toBe(host)
    await expect(wallet.setDefaultMint('nowhere.example')).rejects.toThrow('No mint known')
  })

  it('refuses to remove a mint still holding notes, allows it once empty', async () => {
    const theMint = await start()
    const {wallet, data} = makeWallet()
    await wallet.addMint(`mint@${new URL(theMint.url).host}`)
    const host = new URL(theMint.url).host
    const {note} = await wallet.receive(fund(theMint, 21_000).url)

    await expect(wallet.removeMint(host)).rejects.toThrow('still live')

    // hand it over and mark it taken - nothing left at the mint
    const sent = await wallet.send(21_000)
    await wallet.markTaken(sent)
    expect(note.state).toBe('spent')
    await wallet.removeMint(host)
    expect(data.mints).toHaveLength(0)
    expect(data.settings.defaultMintHost).toBeUndefined()
    // the pubkey pin survives removal on purpose
    expect(data.pubkeyPins[host]).toBeDefined()
  })
})

describe('mint claims', () => {
  // The mock mint's invoices are unfundable fakes, so a settled claim is
  // staged by hand: the preimage IS the note's k1, exactly what an NWC pay
  // result or LUD-21 verify would hand claimMint.
  const stageClaim = (theMint: Mint, data: WalletData, amountMsat: number): {pending: PendingMint; preimage: string} => {
    const preimage = freshK1()
    theMint.state.creditNote(preimage, amountMsat)
    const pending: PendingMint = {
      id: hashK1(preimage),
      mintHost: new URL(theMint.url).host,
      baseUrl: `${theMint.url}/w`,
      pr: 'lnbc1staged',
      grossMsat: amountMsat,
      expectedNetMsat: amountMsat,
      state: 'awaiting',
      createdAt: 1,
      updatedAt: 1
    }
    data.pendingMints.push(pending)
    return {pending, preimage}
  }

  // A fetch that drops note-info GETs until healed - the flaky moment
  // between a claim persisting and its receive landing.
  const droppingFetch = () => {
    let down = true
    const fetchImpl: typeof fetch = (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url)
      if (down && url.pathname === '/w' && url.searchParams.has('k1')) {
        return Promise.reject(new Error('connection reset'))
      }
      return fetch(input, init)
    }
    return {fetchImpl, heal: () => (down = false)}
  }

  it('recovers a paid mint whose receive failed after the claim persisted', async () => {
    const theMint = await start()
    const {fetchImpl, heal} = droppingFetch()
    const {wallet, data} = makeWallet({fetch: fetchImpl})
    const {pending, preimage} = stageClaim(theMint, data, 21_000)

    // the invoice is paid but the note-info GET fails between the claim
    // persisting and the receive landing
    await expect(wallet.claimMint(pending, preimage)).rejects.toThrow('Failed to reach the service')
    expect(pending.state).toBe('claimed')
    expect(pending.preimageHex).toBe(preimage)
    expect(wallet.balanceMsat()).toBe(0)
    expect(wallet.needsReconcile()).toBe(true)

    // connectivity returns; reconcile re-drives the receive from the
    // persisted preimage and the note lands live, rotated to a fresh secret
    heal()
    const events = await wallet.reconcile()
    expect(events.some(event => event.kind === 'mint-claimed')).toBe(true)
    expect(pending.preimageHex).toBeUndefined()
    expect(wallet.balanceMsat()).toBe(21_000)
    const live = wallet.liveNotes()
    expect(live).toHaveLength(1)
    expect(live[0]!.amountMsat).toBe(21_000)
    expect(live[0]!.k1).not.toBe(preimage)
    expect(wallet.needsReconcile()).toBe(false)
  })

  it('survives a crash between the claim and the receive landing', async () => {
    const theMint = await start()
    const {fetchImpl, heal} = droppingFetch()
    const first = makeWallet({fetch: fetchImpl})
    const {pending, preimage} = stageClaim(theMint, first.data, 21_000)
    await expect(first.wallet.claimMint(pending, preimage)).rejects.toThrow('Failed to reach the service')

    // the process dies here; the next start rebuilds the wallet over the
    // same persisted data and reconcile finishes the claim
    heal()
    const restarted = new Wallet(first.data, async () => {}, {timeoutMs: 3_000})
    const events = await restarted.reconcile()
    expect(events.some(event => event.kind === 'mint-claimed')).toBe(true)
    expect(pending.preimageHex).toBeUndefined()
    expect(restarted.balanceMsat()).toBe(21_000)
  })

  it('drops the held preimage when the note is already in the wallet', async () => {
    // the crash came after receive() persisted but before claimMint cleaned
    // up: the note is in the wallet, the pending still holds the preimage
    const theMint = await start()
    const {wallet, data} = makeWallet()
    const {pending, preimage} = stageClaim(theMint, data, 21_000)
    await wallet.claimMint(pending, preimage)
    expect(pending.preimageHex).toBeUndefined()

    pending.preimageHex = preimage // what that crash would have left behind
    const events = await wallet.reconcile()
    expect(pending.preimageHex).toBeUndefined()
    expect(events.some(event => event.kind === 'mint-claim-retry')).toBe(false)
    // and nothing was received twice
    expect(wallet.balanceMsat()).toBe(21_000)
    expect(wallet.liveNotes()).toHaveLength(1)
  })

  it('keeps the held preimage when the mint still cannot answer', async () => {
    const theMint = await start()
    const {fetchImpl} = droppingFetch()
    const {wallet, data} = makeWallet({fetch: fetchImpl})
    const {pending, preimage} = stageClaim(theMint, data, 21_000)
    await expect(wallet.claimMint(pending, preimage)).rejects.toThrow('Failed to reach the service')

    const events = await wallet.reconcile()
    expect(events.some(event => event.kind === 'mint-claim-retry')).toBe(true)
    expect(pending.preimageHex).toBe(preimage)
    expect(wallet.balanceMsat()).toBe(0)
  })
})

// The mint fee band. LUD-25 does not say whether the fee rounds, so a
// note landing anywhere between the msat-exact formula and the same fee
// ceilinged to a whole sat is the mint keeping its word. Only outside
// that is worth telling the holder about. These are the numbers
// mint.forgesworn.dev actually credited on 2026-08-21: 40_000 gross, a
// 1000 + 1000ppm fee, and 38_000 rather than the formula's 38_960.
describe('the mint fee band', () => {
  // As stageClaim above: the mock's invoices are unfundable fakes, so the
  // claim is staged by hand. creditNote decides what the mint credited,
  // which is the whole point here.
  const claimCrediting = async (creditedMsat: number) => {
    const theMint = await start()
    {
      const {wallet, data} = makeWallet()
      const preimage = freshK1()
      theMint.state.creditNote(preimage, creditedMsat)
      const pending: PendingMint = {
        id: hashK1(preimage),
        mintHost: new URL(theMint.url).host,
        baseUrl: `${theMint.url}/w`,
        pr: 'lnbc1staged',
        grossMsat: 40_000,
        expectedNetMsat: 38_960,
        minNetMsat: 38_000,
        state: 'awaiting',
        createdAt: 1,
        updatedAt: 1
      }
      data.pendingMints.push(pending)
      return await wallet.claimMint(pending, preimage)
    }
  }

  it('says nothing when a mint ceilings its fee, as the reference does', async () => {
    expect((await claimCrediting(38_000)).warnings).toEqual([])
  })

  it('says nothing at the msat-exact edge either', async () => {
    expect((await claimCrediting(38_960)).warnings).toEqual([])
  })

  it('names the band when a mint takes more than either reading allows', async () => {
    expect((await claimCrediting(37_999)).warnings).toEqual([
      'expected 38000-38960 msat net but the mint credited 37999 msat'
    ])
  })

  it('names the band when a mint credits more than it advertised', async () => {
    expect((await claimCrediting(38_961)).warnings).toEqual([
      'expected 38000-38960 msat net but the mint credited 38961 msat'
    ])
  })
})
