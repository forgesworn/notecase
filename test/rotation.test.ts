import {afterEach, describe, expect, it} from 'vitest'
import {createMockMint} from 'lnurlcash-conformance/mock-mint'
import {PinMismatchError, Wallet} from '../src/wallet.ts'
import {freshK1, makeWallet} from './helpers.ts'

// A mint rotating its signing key. Every outstanding signature stops
// verifying against the pin at once, and a wallet that treats that as an
// attack tells its holder their mint has been replaced when it has simply
// changed a key and said so.

type Mint = Awaited<ReturnType<typeof createMockMint>>
const open: Mint[] = []
const start = async (options: Record<string, unknown> = {}): Promise<Mint> => {
  const mint = await createMockMint(options)
  open.push(mint)
  return mint
}
afterEach(async () => {
  for (const mint of open.splice(0)) await mint.close()
})

const hostOf = (mint: Mint): string => new URL(mint.url).host

// The mint's key changes to `newKey`, and its discovery says (or does not
// say) that the old one is retired. Everything else answers as before, so
// the notes it already signed are signed by the OLD key - which is the
// whole situation a rotation puts a wallet in.
const rotatedTo = (mint: Mint, newKey: string, options: {publishOldKey: boolean}) => {
  const oldKey = mint.state.pubkey
  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url)
    const response = await fetch(input, init)
    if (url.pathname === '/w' && url.searchParams.has('k1')) {
      const body = (await response.json()) as Record<string, unknown>
      return Response.json({...body, mintPubkey: newKey})
    }
    if (url.pathname.startsWith('/.well-known/lnurlw/')) {
      const body = (await response.json()) as Record<string, unknown>
      return Response.json({
        ...body,
        mintPubkey: newKey,
        ...(options.publishOldKey ? {previousPubkeys: [oldKey]} : {})
      })
    }
    return response
  }
  return fetchImpl
}

const fund = (mint: Mint, amountMsat: number): string => {
  const k1 = freshK1()
  mint.state.creditNote(k1, amountMsat)
  return `${mint.url}/w?k1=${k1}&amount=${amountMsat}`
}

describe('a mint that rotates its signing key', () => {
  const pinnedWallet = async (mint: Mint) => {
    const wallet = makeWallet()
    await wallet.wallet.addMint(`mint@${hostOf(mint)}`)
    await wallet.wallet.receive(fund(mint, 21_000))
    expect(wallet.data.pubkeyPins[hostOf(mint)]).toBe(mint.state.pubkey)
    return wallet
  }

  it('is accepted when the mint publishes the old key as retired', async () => {
    const mint = await start()
    // any other valid mint key: the mock derives one from a private key
    const other = await start({privateKey: freshK1()})
    const oldKey = mint.state.pubkey
    const wallet = await pinnedWallet(mint)

    // the same wallet, now seeing the rotated mint
    const rotated = new Wallet(wallet.data, async () => {}, {
      timeoutMs: 3_000,
      fetch: rotatedTo(mint, other.state.pubkey, {publishOldKey: true})
    })
    const received = await rotated.receive(fund(mint, 5_000))

    expect(wallet.data.pubkeyPins[hostOf(mint)]).toBe(other.state.pubkey)
    expect(rotated.pubkeyHistoryFor(hostOf(mint))).toEqual([oldKey])
    expect(received.warnings.some(warning => warning.includes('rotated its signing key'))).toBe(true)
    expect(rotated.balanceMsat()).toBe(26_000)

    // and it is said once, plainly, on the next reconcile
    const events = await rotated.reconcile()
    expect(events.some(event => event.kind === 'mint-key-rotated')).toBe(true)
    const again = await rotated.reconcile()
    expect(again.some(event => event.kind === 'mint-key-rotated')).toBe(false)
  })

  // A wallet that has only ever RECEIVED notes from a mint - the ordinary
  // case for a bearer-note wallet, and the one the escape hatch could not
  // reach. The pin is created by the receive itself, from the note alone.
  // Finding the key history needed the mint's pay URL out of the wallet's
  // mint list, and there is no entry, so the history came back empty and
  // empty means refuse: the same receive that created the pin could never
  // create what was needed to move it. The note's own `payLink` closes it.
  describe('for a mint known only from notes', () => {
    const noteOnlyWallet = async (mint: Mint) => {
      const wallet = makeWallet()
      await wallet.wallet.receive(fund(mint, 21_000))
      expect(wallet.data.pubkeyPins[hostOf(mint)]).toBe(mint.state.pubkey)
      // The point of the fixture: nothing in the directory to look up.
      expect(wallet.data.mints).toEqual([])
      return wallet
    }

    it('accepts an announced rotation, the same as a mint in the directory', async () => {
      const mint = await start()
      const other = await start({privateKey: freshK1()})
      const oldKey = mint.state.pubkey
      const wallet = await noteOnlyWallet(mint)

      const rotated = new Wallet(wallet.data, async () => {}, {
        timeoutMs: 3_000,
        fetch: rotatedTo(mint, other.state.pubkey, {publishOldKey: true})
      })
      const received = await rotated.receive(fund(mint, 5_000))

      expect(wallet.data.pubkeyPins[hostOf(mint)]).toBe(other.state.pubkey)
      expect(rotated.pubkeyHistoryFor(hostOf(mint))).toEqual([oldKey])
      expect(received.warnings.some(warning => warning.includes('rotated its signing key'))).toBe(true)
      expect(rotated.balanceMsat()).toBe(26_000)
    })

    it('still refuses a rotation the mint has not announced', async () => {
      const mint = await start()
      const other = await start({privateKey: freshK1()})
      const wallet = await noteOnlyWallet(mint)
      const oldKey = mint.state.pubkey

      const rotated = new Wallet(wallet.data, async () => {}, {
        timeoutMs: 3_000,
        fetch: rotatedTo(mint, other.state.pubkey, {publishOldKey: false})
      })
      await expect(rotated.receive(fund(mint, 5_000))).rejects.toThrow(PinMismatchError)
      expect(wallet.data.pubkeyPins[hostOf(mint)]).toBe(oldKey)
    })

    it('still refuses when the mint publishes no way home at all', async () => {
      // A mint that does not serve payLink leaves a note-only wallet exactly
      // where it was: no route to the history, and silence is not permission.
      const mint = await start({noteInfoPayLink: false})
      const other = await start({privateKey: freshK1()})
      const wallet = await noteOnlyWallet(mint)

      const rotated = new Wallet(wallet.data, async () => {}, {
        timeoutMs: 3_000,
        fetch: rotatedTo(mint, other.state.pubkey, {publishOldKey: true})
      })
      await expect(rotated.receive(fund(mint, 5_000))).rejects.toThrow(PinMismatchError)
    })

    it('will not read a key history off another host, even from its own file', async () => {
      // The wallet file is on disk. A tampered `mints[].payUrl` pointing at
      // an attacker's host would otherwise let them nominate who vouches
      // for this mint's keys - the same hole as an off-origin payLink, but
      // arriving from local state rather than the wire, where the kit's
      // check cannot help.
      const mint = await start()
      const other = await start({privateKey: freshK1()})
      const wallet = await noteOnlyWallet(mint)
      wallet.data.mints.push({
        host: hostOf(mint),
        payUrl: `${other.url}/.well-known/lnurlp/mint`,
        addedAt: Date.now()
      } as (typeof wallet.data.mints)[number])

      const rotated = new Wallet(wallet.data, async () => {}, {
        timeoutMs: 3_000,
        fetch: rotatedTo(mint, other.state.pubkey, {publishOldKey: true})
      })
      await expect(rotated.receive(fund(mint, 5_000))).rejects.toThrow(PinMismatchError)
    })

    it('will not follow a way home that points at somebody else', async () => {
      // A mint nominating a third party to vouch for its key history. The
      // kit drops an off-origin payLink before the wallet ever sees it, and
      // the wallet checks the host again on its own account.
      const mint = await start({payLinkOffOrigin: true})
      const other = await start({privateKey: freshK1()})
      const wallet = await noteOnlyWallet(mint)

      const rotated = new Wallet(wallet.data, async () => {}, {
        timeoutMs: 3_000,
        fetch: rotatedTo(mint, other.state.pubkey, {publishOldKey: true})
      })
      await expect(rotated.receive(fund(mint, 5_000))).rejects.toThrow(PinMismatchError)
    })
  })

  it('is refused when the mint says nothing about the old key', async () => {
    const mint = await start()
    const other = await start({privateKey: freshK1()})
    const wallet = await pinnedWallet(mint)
    const oldKey = mint.state.pubkey

    const rotated = new Wallet(wallet.data, async () => {}, {
      timeoutMs: 3_000,
      fetch: rotatedTo(mint, other.state.pubkey, {publishOldKey: false})
    })
    await expect(rotated.receive(fund(mint, 5_000))).rejects.toThrow(PinMismatchError)
    expect(wallet.data.pubkeyPins[hostOf(mint)]).toBe(oldKey)
    expect(rotated.pubkeyHistoryFor(hostOf(mint))).toEqual([])
  })

  it('keeps verifying notes the retired key signed, offline and in the sweep', async () => {
    const mint = await start()
    const other = await start({privateKey: freshK1()})
    const wallet = await pinnedWallet(mint)
    const held = wallet.wallet.liveNotes()[0]!

    const rotated = new Wallet(wallet.data, async () => {}, {
      timeoutMs: 3_000,
      fetch: rotatedTo(mint, other.state.pubkey, {publishOldKey: true})
    })
    await rotated.receive(fund(mint, 5_000))

    // the note it already holds was signed by the key now retired
    const verdict = rotated.verifyNoteOffline(rotated.noteUrlFor(held))
    expect(verdict.valid).toBe(true)
    expect(verdict.reason).toContain('retired')

    // and the sweep offers to re-sign it under the key in use now, which
    // a rotate does for nothing
    const report = await rotated.checkNotes()
    expect(report.staleSignature.map(note => note.id)).toContain(held.id)
    expect(report.spent).toEqual([])
  })

  it('reports nothing stale while the mint is still using the key it pinned', async () => {
    const mint = await start()
    const wallet = await pinnedWallet(mint)
    const report = await wallet.wallet.checkNotes()
    expect(report.staleSignature).toEqual([])
    expect(wallet.wallet.verifyNoteOffline(wallet.wallet.noteUrlFor(wallet.wallet.liveNotes()[0]!)).reason).toContain(
      'pinned key'
    )
  })
})
