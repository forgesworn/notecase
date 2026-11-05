import {afterEach, describe, expect, it} from 'vitest'
import {createMockMint} from 'lnurlcash-conformance/mock-mint'
import {
  deriveCashRoot,
  deriveCashSecret,
  deriveNoteKey,
  deriveNoteRoot,
  deriveNoteSecret,
  deriveServiceRoot,
  isCk1,
  noteIdOf
} from '../src/lnurlcash.js'
import {HDKey} from '@scure/bip32'
import {bytesToHex, hexToBytes} from '@noble/hashes/utils.js'
import {Wallet, WalletUsageError} from '../src/wallet.ts'
import {newMnemonic, seedFromMnemonic} from '../src/store.ts'
import {emptyWallet} from '../src/types.ts'
import {freshK1} from './helpers.ts'

// Twelve words and the name of a mint are enough to find the money. That
// is the whole promise, and it rests on two things: every note this wallet
// makes comes off the seed, at a key LUD-26's recovery walks, and the
// counter that says which one is next never leaves a gap a restore's walk
// would stop at. A key note's counter moves once the mint credits it; a
// bearer note's is persisted before its hash reaches the mint.

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

const hostOf = (theMint: Mint): string => new URL(theMint.url).host

// A wallet on a known seed, over in-memory persistence that counts writes.
const seeded = (mnemonic: string, opts: Record<string, unknown> = {}) => {
  const data = emptyWallet()
  data.seedHex = seedFromMnemonic(mnemonic)
  data.mnemonic = mnemonic
  let saves = 0
  const wallet = new Wallet(
    data,
    async () => {
      saves += 1
    },
    {timeoutMs: 3_000, ...opts}
  )
  return {wallet, data, saves: () => saves}
}

const WORDS = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

// hex(Q) of the key at S/0'/<chain>/<index>: a key note's id.
const chainQ = (seedHex: string, host: string, chain: 'wallet' | 'change', index: number): string => {
  const root = deriveCashRoot(hexToBytes(seedHex))
  const service = deriveServiceRoot(new HDKey({privateKey: root.privateKey, chainCode: root.chainCode}), host)
  return bytesToHex(deriveNoteKey(service, {chain, account: 0, index}).outputKey)
}

// A mint this wallet knows takes no key notes, so it makes bearer notes there.
const noKeyNotes = (data: ReturnType<typeof emptyWallet>, theMint: Mint): void => {
  const host = hostOf(theMint)
  const entry = data.mints.find(mint => mint.host === host)
  if (entry) entry.keyNotes = false
  else data.mints.push({input: theMint.url, host, payUrl: `${theMint.url}/.well-known/lnurlp/mint`, addedAt: 1, keyNotes: false})
}

const fund = (theMint: Mint, amountMsat: number): string => {
  const k1 = freshK1()
  theMint.state.creditNote(k1, amountMsat)
  return `${theMint.url}/w?k1=${k1}&amount=${amountMsat}`
}

describe('the seed', () => {
  it('makes twelve words that turn into a seed, and refuses a wrong list', () => {
    const words = newMnemonic()
    expect(words.split(' ')).toHaveLength(12)
    expect(seedFromMnemonic(words)).toHaveLength(128)
    // the same words, however they were typed
    expect(seedFromMnemonic(`  ${WORDS.toUpperCase()}  `)).toBe(seedFromMnemonic(WORDS))
    expect(() => seedFromMnemonic('not twelve real words at all')).toThrow('recovery words')
  })

  it("makes its notes on LUD-26's wallet and change chains, in order, per mint", async () => {
    const theMint = await start()
    const {wallet, data} = seeded(WORDS)
    const host = hostOf(theMint)

    // a receive rotates, onto the wallet chain's first key
    const received = await wallet.receive(fund(theMint, 100_000))
    expect(received.note.scheme).toBe('wallet')
    expect(received.note.index).toBe(0)
    expect(received.note.id).toBe(chainQ(data.seedHex!, host, 'wallet', 0))
    expect(isCk1(received.note.k1)).toBe(true)
    expect(wallet.chainCounterFor(host, 'wallet')).toBe(1)

    // a split's amount goes on the wallet chain and its change on the change chain
    const sent = await wallet.send(30_000)
    expect([sent.scheme, sent.index]).toEqual(['wallet', 1])
    expect(sent.id).toBe(chainQ(data.seedHex!, host, 'wallet', 1))
    const change = wallet.liveNotes()[0]!
    expect([change.scheme, change.index]).toEqual(['change', 0])
    expect(change.id).toBe(chainQ(data.seedHex!, host, 'change', 0))
    expect(wallet.chainCounterFor(host, 'wallet')).toBe(2)
    expect(wallet.chainCounterFor(host, 'change')).toBe(1)
    // and neither bearer ladder moved
    expect(wallet.cashCounterFor(host)).toBe(0)
    expect(wallet.counterFor(host)).toBe(0)
  })

  it('takes every secret off the bearer ladder, in order, at a mint without key notes', async () => {
    const theMint = await start()
    const {wallet, data} = seeded(WORDS)
    noKeyNotes(data, theMint)
    const host = hostOf(theMint)
    const root = deriveCashRoot(hexToBytes(data.seedHex!))

    // a receive rotates, which is one derived secret
    const received = await wallet.receive(fund(theMint, 100_000))
    expect(received.note.index).toBe(0)
    expect(received.note.k1).toBe(deriveCashSecret(root, host, 0))
    expect(wallet.cashCounterFor(host)).toBe(1)

    // a split takes two: the amount and its change
    const sent = await wallet.send(30_000)
    expect(sent.index).toBe(1)
    expect(sent.k1).toBe(deriveCashSecret(root, host, 1))
    const change = wallet.liveNotes()[0]!
    expect(change.index).toBe(2)
    expect(change.k1).toBe(deriveCashSecret(root, host, 2))
    expect(wallet.cashCounterFor(host)).toBe(3)
  })

  it("moves a key note's counter only once the mint credits it, and keeps the key while the outcome is open", async () => {
    const theMint = await start()
    let cutTheWire = false
    const fetchImpl: typeof globalThis.fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url)
      if (cutTheWire && url.pathname === '/w/cb') throw new TypeError('fetch failed')
      return fetch(input, init)
    }
    const {wallet, data} = seeded(WORDS, {fetch: fetchImpl})
    const host = hostOf(theMint)
    const received = await wallet.receive(fund(theMint, 21_000))
    expect(wallet.chainCounterFor(host, 'wallet')).toBe(1)

    cutTheWire = true
    await expect(wallet.rotateLive(received.note)).rejects.toThrow()
    // nothing secret went out, so the counter waits for the mint ...
    expect(wallet.chainCounterFor(host, 'wallet')).toBe(1)
    // ... while the staged output, persisted before the request, holds its key
    const held = data.notes.filter(note => note.state !== 'live' && note.state !== 'spent')
    expect(held.map(note => [note.scheme, note.index])).toContainEqual(['wallet', 1])
    cutTheWire = false

    // reconcile finds it never landed: the input is the holder's again and
    // the key is free, so the next request names it, as LUD-26 asks
    await wallet.reconcile()
    const live = wallet.liveNotes()
    expect(live.map(note => [note.scheme, note.index])).toEqual([['wallet', 0]])
    const again = await wallet.rotateLive(live[0]!)
    expect([again.scheme, again.index]).toEqual(['wallet', 1])
    expect(wallet.chainCounterFor(host, 'wallet')).toBe(2)
  })

  it('persists the bearer counter before the hash goes on the wire', async () => {
    const theMint = await start()
    let cutTheWire = false
    const fetchImpl: typeof globalThis.fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url)
      if (cutTheWire && url.pathname === '/w/cb') throw new TypeError('fetch failed')
      return fetch(input, init)
    }
    const {wallet, data} = seeded(WORDS, {fetch: fetchImpl})
    noKeyNotes(data, theMint)
    const host = hostOf(theMint)
    const received = await wallet.receive(fund(theMint, 21_000))
    const before = wallet.cashCounterFor(host)

    cutTheWire = true
    await expect(wallet.rotateLive(received.note)).rejects.toThrow()
    // the secret was staged and the counter moved with it: a wasted index
    // costs nothing, and the other order would lose the note
    expect(wallet.cashCounterFor(host)).toBe(before + 1)
  })

  it('names the same keys again after a mutation the mint refused', async () => {
    const theMint = await start()
    const {wallet, data} = seeded(WORDS)
    const host = hostOf(theMint)
    await wallet.receive(fund(theMint, 21_000))
    expect(wallet.chainCounterFor(host, 'wallet')).toBe(1)

    // a mint that has stopped splitting: a refusal that cannot possibly be a
    // mutation that landed, so the staged records are dropped and their keys
    // are free again, as LUD-26 asks: no unused index is left behind
    theMint.state.opts.sunset = true
    await expect(wallet.send(9_000)).rejects.toThrow()
    theMint.state.opts.sunset = false
    expect(wallet.chainCounterFor(host, 'wallet')).toBe(1)
    expect(wallet.chainCounterFor(host, 'change')).toBe(0)
    // and a refusal at a mint that already took key notes never sends it
    // back to bearer ones
    expect(data.mints.find(mint => mint.host === host)?.keyNotes).toBeUndefined()

    const next = await wallet.send(9_000)
    expect([next.scheme, next.index]).toEqual(['wallet', 1])
    expect(wallet.liveNotes().map(note => [note.scheme, note.index])).toEqual([['change', 0]])
    expect(wallet.balanceMsat()).toBe(12_000)
  })

  it('never reuses a bearer index after a mutation is unwound', async () => {
    const theMint = await start()
    const {wallet, data} = seeded(WORDS)
    noKeyNotes(data, theMint)
    const host = hostOf(theMint)
    await wallet.receive(fund(theMint, 21_000))
    expect(wallet.cashCounterFor(host)).toBe(1)

    // a mint that has stopped splitting: a refusal that cannot possibly
    // be a mutation that landed, so the staged records are dropped
    theMint.state.opts.sunset = true
    await expect(wallet.send(9_000)).rejects.toThrow()
    theMint.state.opts.sunset = false
    // the two staged indices are spent even though nothing was minted
    expect(wallet.cashCounterFor(host)).toBe(3)

    const next = await wallet.send(9_000)
    expect(next.index).toBe(3)
    expect(wallet.balanceMsat()).toBe(12_000)
  })
})

describe('restoring from the words', () => {
  it('finds key notes again from the words and the mint, asking only by key', async () => {
    const theMint = await start()
    const host = hostOf(theMint)
    const original = seeded(WORDS)
    await original.wallet.addMint(`mint@${host}`)
    await original.wallet.receive(fund(theMint, 100_000))
    const handed = await original.wallet.send(30_000)
    const other = seeded(newMnemonic())
    await other.wallet.receive(original.wallet.noteUrlFor(handed))
    const expected = original.wallet.balanceMsat()
    expect(expected).toBe(70_000)

    // no k1 may go on the wire: the walk asks by cp1 alone
    const asked: string[] = []
    const watching: typeof globalThis.fetch = async (input, init) => {
      asked.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
      return fetch(input, init)
    }
    const fresh = seeded(WORDS, {fetch: watching})
    await fresh.wallet.addMint(`mint@${host}`)
    const restored = await fresh.wallet.restoreFromMint(host)
    expect(fresh.wallet.balanceMsat()).toBe(expected)
    expect(restored.found.map(note => [note.scheme, note.index])).toEqual([['change', 0]])
    expect(asked.some(url => new URL(url).searchParams.has('k1'))).toBe(false)
    // both chains carry on past what the mint holds: the wallet chain's two
    // keys (the receive and the note handed over, now spent) and the change
    expect(fresh.wallet.chainCounterFor(host, 'wallet')).toBe(2)
    expect(fresh.wallet.chainCounterFor(host, 'change')).toBe(1)

    // and the restored wallet can spend what it found
    const spent = await fresh.wallet.send(10_000)
    expect([spent.scheme, spent.index]).toEqual(['wallet', 2])
  })

  it('finds the money again from nothing but the seed and the mint', async () => {
    const theMint = await start()
    const original = seeded(WORDS)
    await original.wallet.addMint(`mint@${hostOf(theMint)}`)
    noKeyNotes(original.data, theMint)
    await original.wallet.receive(fund(theMint, 100_000))
    const handed = await original.wallet.send(30_000)
    // and somebody takes it, so only the change is still this seed's
    const other = seeded(newMnemonic())
    await other.wallet.receive(original.wallet.noteUrlFor(handed))
    const expected = original.wallet.balanceMsat()
    expect(expected).toBe(70_000)

    // Simulate an older service only after the notes exist: published kit
    // 0.14 requires a service to advertise raw-k1 fallback during ordinary
    // receive, while this test is specifically about restore's explicit
    // secret-disclosure fallback.
    theMint.state.opts.hashLookup = false

    // a fresh device: the same words, the same mint, nothing else
    const fresh = seeded(WORDS)
    await fresh.wallet.addMint(`mint@${hostOf(theMint)}`)
    expect(fresh.wallet.balanceMsat()).toBe(0)

    // This deliberately old service answers no lookups by hash, so the
    // explicitly authorised fallback walks by secret.
    const restored = await fresh.wallet.restoreFromMint(hostOf(theMint), {
      allowSecretDisclosure: true
    })
    expect(restored.found.length).toBeGreaterThan(0)
    expect(fresh.wallet.balanceMsat()).toBe(expected)
    // and it knows where to carry on from - past everything the walk
    // disclosed, not merely past the last note it found, because those
    // secrets are in the mint's request log now
    expect(fresh.wallet.cashCounterFor(hostOf(theMint))).toBeGreaterThanOrEqual(
      original.wallet.cashCounterFor(hostOf(theMint))
    )
    for (const note of restored.found) expect(note.origin).toBe('recovered')

    // the restored wallet can spend what it found
    const spent = await fresh.wallet.send(10_000)
    expect(spent.amountMsat).toBe(10_000)
  })

  it('walks past a gap of spent indices and stops after twenty unknowns', async () => {
    const theMint = await start()
    const {wallet, data} = seeded(WORDS)
    const host = hostOf(theMint)
    await wallet.addMint(`mint@${host}`)
    const root = deriveCashRoot(hexToBytes(data.seedHex!))

    // indices 0 and 1 used and burned, 2 alive, then nothing
    for (const index of [0, 1]) {
      const k1 = deriveCashSecret(root, host, index)
      theMint.state.creditNote(k1, 1_000)
      theMint.state.settleMelt(k1)
    }
    theMint.state.creditNote(deriveCashSecret(root, host, 2), 7_000)

    const restored = await wallet.restoreFromMint(host, {allowSecretDisclosure: true})
    expect(restored.found.map(note => note.index)).toEqual([2])
    expect(wallet.balanceMsat()).toBe(7_000)
    // Secret-free lookup still distinguishes retained spent notes from
    // unknown indices, so the next unused index is immediately after the
    // live note rather than after the twenty-index gap.
    expect(restored.next).toBe(3)
  })

  // The reason restoreFromMint walks two ladders. Notes minted before
  // LUD-25 specified a derivation are still money, and this wallet used to
  // put them on the kit's own pre-spec scheme.
  it('finds notes on the pre-spec ladder as well as the current one', async () => {
    const theMint = await start()
    const {wallet, data} = seeded(WORDS)
    const host = hostOf(theMint)
    await wallet.addMint(`mint@${host}`)
    const seed = hexToBytes(data.seedHex!)

    // one note from before the migration, one from after
    theMint.state.creditNote(deriveNoteSecret(deriveNoteRoot(seed), host, 0), 5_000)
    theMint.state.creditNote(deriveCashSecret(deriveCashRoot(seed), host, 0), 7_000)

    const restored = await wallet.restoreFromMint(host, {allowSecretDisclosure: true})

    expect(restored.found).toHaveLength(2)
    expect(wallet.balanceMsat()).toBe(12_000)
    // each note says which ladder found it, so nothing has to guess later
    expect(restored.found.map(note => note.scheme).sort()).toEqual(['bip32', 'hmac'])
    // and both counters moved, not just the live one: the legacy number is
    // where a later restore starts looking for the rest of those notes.
    expect(wallet.cashCounterFor(host)).toBeGreaterThan(0)
    expect(wallet.counterFor(host)).toBeGreaterThan(0)
  })

  it('makes key notes, never bearer ones, at a mint that takes them', async () => {
    const theMint = await start()
    const {wallet, data} = seeded(WORDS)
    const host = hostOf(theMint)
    await wallet.addMint(`mint@${host}`)

    const received = await wallet.receive(fund(theMint, 21_000))

    expect(received.note.scheme).toBe('wallet')
    expect(received.note.id).toBe(chainQ(data.seedHex!, host, 'wallet', 0))
    // neither bearer ladder moves
    expect(wallet.cashCounterFor(host)).toBe(0)
    expect(wallet.counterFor(host)).toBe(0)
    expect(data.counters?.[host] ?? 0).toBe(0)
  })

  it('mints on the bearer ladder at a mint without key notes, never the pre-spec one', async () => {
    const theMint = await start()
    const {wallet, data} = seeded(WORDS)
    const host = hostOf(theMint)
    await wallet.addMint(`mint@${host}`)
    noKeyNotes(data, theMint)
    const seed = hexToBytes(data.seedHex!)

    const received = await wallet.receive(fund(theMint, 21_000))

    expect(received.note.scheme).toBe('bip32')
    expect(received.note.k1).toBe(deriveCashSecret(deriveCashRoot(seed), host, 0))
    expect(received.note.k1).not.toBe(deriveNoteSecret(deriveNoteRoot(seed), host, 0))
    // the legacy ladder never moves
    expect(wallet.counterFor(host)).toBe(0)
    expect(data.counters?.[host] ?? 0).toBe(0)
  })

  it('falls back to a bearer note at a mint that refuses key notes', async () => {
    const theMint = await start({refusesCp1Outputs: true})
    const {wallet, data} = seeded(WORDS)
    const host = hostOf(theMint)
    await wallet.addMint(`mint@${host}`)

    const received = await wallet.receive(fund(theMint, 21_000))
    expect(received.note.state).toBe('live')
    expect(received.note.scheme).toBe('bip32')
    expect(wallet.chainCounterFor(host, 'wallet')).toBe(0)
    // it answers lookups, as a mint taking key notes must, so this may be
    // a passing refusal: it is not marked, and the next request asks again
    expect(data.mints.find(mint => mint.host === host)?.keyNotes).toBeUndefined()
    const next = await wallet.send(9_000)
    expect(next.scheme).toBe('bip32')
    expect(wallet.balanceMsat()).toBe(12_000)
  })

  // lnurl-mint 0.3.1's answer to any `?p=`, as mint.forgesworn.dev gives it.
  const noLookups = (refuseOnce?: {path: string; armed: boolean}): typeof globalThis.fetch => async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url)
    const refuse = (reason: string) =>
      new Response(JSON.stringify({status: 'ERROR', reason}), {headers: {'content-type': 'application/json'}})
    if (!refuseOnce && url.pathname === '/w' && url.searchParams.has('p')) {
      return refuse('Request validation error: Field required `k1`.')
    }
    if (refuseOnce?.armed && url.pathname === refuseOnce.path && (refuseOnce.path !== '/w' || url.searchParams.has('p'))) {
      refuseOnce.armed = false
      return refuse('Temporarily unable to issue an invoice.')
    }
    return fetch(input, init)
  }

  it('marks a mint with no lookups at all as one without key notes, once a bearer note gets through', async () => {
    const theMint = await start({refusesCp1Outputs: true})
    const {wallet, data} = seeded(WORDS, {fetch: noLookups()})
    const host = hostOf(theMint)
    await wallet.addMint(`mint@${host}`)
    const received = await wallet.receive(fund(theMint, 21_000))
    expect(received.note.scheme).toBe('bip32')
    expect(data.mints.find(mint => mint.host === host)?.keyNotes).toBe(false)
    // and re-adding the mint is how a holder asks again
    await wallet.addMint(`mint@${host}`)
    expect(data.mints.find(mint => mint.host === host)?.keyNotes).toBeUndefined()
  })

  it('never marks a mint that takes key notes for one passing refusal', async () => {
    const theMint = await start()
    const once = {path: '/w/cb', armed: true}
    const {wallet, data} = seeded(WORDS, {fetch: noLookups(once)})
    const host = hostOf(theMint)
    await wallet.addMint(`mint@${host}`)
    const received = await wallet.receive(fund(theMint, 21_000))
    // the refused key note was asked again as a bearer one, and went through
    expect(received.note.scheme).toBe('bip32')
    expect(data.mints.find(mint => mint.host === host)?.keyNotes).toBeUndefined()
    // the next request names a key again
    const next = await wallet.send(9_000)
    expect(next.scheme).toBe('wallet')
  })

  it('stops rather than miss a chain when the mint refuses one of its keys', async () => {
    const theMint = await start()
    const host = hostOf(theMint)
    const original = seeded(WORDS)
    await original.wallet.addMint(`mint@${host}`)
    await original.wallet.receive(fund(theMint, 100_000))

    const once = {path: '/w', armed: true}
    const fresh = seeded(WORDS, {fetch: noLookups(once)})
    await fresh.wallet.addMint(`mint@${host}`)
    await expect(fresh.wallet.restoreFromMint(host)).rejects.toThrow(/Temporarily unable/)
    expect(fresh.wallet.balanceMsat()).toBe(0)
    // and asked again, it finds the note
    await fresh.wallet.restoreFromMint(host)
    expect(fresh.wallet.balanceMsat()).toBe(100_000)
  })

  it('refuses when there is no seed to walk', async () => {
    const theMint = await start()
    const data = emptyWallet()
    delete data.seedHex
    const wallet = new Wallet(data, async () => {}, {timeoutMs: 3_000})
    await wallet.addMint(`mint@${hostOf(theMint)}`)
    await expect(wallet.restoreFromMint(hostOf(theMint))).rejects.toThrow(WalletUsageError)
  })
})

describe('notes made before the seed', () => {
  it('are listed as uncovered and adopted by one free rotate each', async () => {
    const theMint = await start()
    const host = hostOf(theMint)
    // a wallet with no seed: its secrets are random, as version 1's were
    const legacy = emptyWallet()
    delete legacy.seedHex
    const old = new Wallet(legacy, async () => {}, {timeoutMs: 3_000})
    await old.addMint(`mint@${host}`)
    await old.receive(fund(theMint, 21_000))
    expect(old.legacyNotes()).toHaveLength(1)
    expect(old.liveNotes()[0]!.index).toBeUndefined()

    // the words arrive
    legacy.seedHex = seedFromMnemonic(WORDS)
    const upgraded = new Wallet(legacy, async () => {}, {timeoutMs: 3_000})
    expect(upgraded.legacyNotes()).toHaveLength(1)

    const result = await upgraded.adoptLegacyNotes()
    expect(result.failed).toEqual([])
    expect(result.adopted).toHaveLength(1)
    expect(upgraded.legacyNotes()).toEqual([])
    expect(upgraded.balanceMsat()).toBe(21_000)
    expect(upgraded.liveNotes()[0]!.index).toBe(0)
    expect(upgraded.liveNotes()[0]!.scheme).toBe('wallet')
    expect(upgraded.liveNotes()[0]!.id).toBe(chainQ(legacy.seedHex!, host, 'wallet', 0))

    // and now a restore on a fresh device finds it, asking only by key
    const fresh = seeded(WORDS)
    await fresh.wallet.addMint(`mint@${host}`)
    await fresh.wallet.restoreFromMint(host)
    expect(fresh.wallet.balanceMsat()).toBe(21_000)
    expect(noteIdOf(fresh.wallet.liveNotes()[0]!.k1)).toBe(upgraded.liveNotes()[0]!.id)
  })

  it('moves notes on the old bearer ladder onto the wallet chain, but only when asked', async () => {
    const theMint = await start()
    const host = hostOf(theMint)
    const {wallet, data} = seeded(WORDS)
    await wallet.addMint(`mint@${host}`)
    // made before this release: on S/i'
    noKeyNotes(data, theMint)
    await wallet.receive(fund(theMint, 21_000))
    delete data.mints.find(mint => mint.host === host)!.keyNotes
    expect(wallet.legacyNotes()).toEqual([])
    expect(wallet.oldLadderNotes().map(note => note.scheme)).toEqual(['bip32'])

    // nothing moves it unasked: a receive, a reconcile
    await wallet.receive(fund(theMint, 5_000))
    await wallet.reconcile()
    expect(wallet.oldLadderNotes()).toHaveLength(1)

    const result = await wallet.adoptLegacyNotes()
    expect(result.failed).toEqual([])
    expect(result.adopted.map(note => note.scheme)).toEqual(['wallet'])
    expect(wallet.oldLadderNotes()).toEqual([])
    expect(wallet.balanceMsat()).toBe(26_000)

    // none to move at a mint without key notes: a rotate there stays bearer
    noKeyNotes(data, theMint)
    await wallet.receive(fund(theMint, 1_000))
    expect(wallet.oldLadderNotes()).toEqual([])
  })
})

describe("LUD-26's vectors", () => {
  // The spec's own numbers (luds 26-vectors.json, as conformance ships it):
  // the wallet's chains must name exactly these cp1s, or another wallet given
  // the same words looks in the wrong place.
  it('names the wallet and change notes of account 0 exactly as the spec does', async () => {
    const {readFileSync} = await import('node:fs')
    const {createRequire} = await import('node:module')
    const path = createRequire(import.meta.url).resolve('lnurlcash-conformance/vectors/spec-vectors.json')
    const vectors = JSON.parse(readFileSync(path, 'utf8')).lud26.derivation as Array<{
      seed: string
      domain: string
      accounts: Array<{account: number; wallet: {notes: Array<{i: number; cp1: string}>}; change: {notes: Array<{i: number; cp1: string}>}}>
    }>
    let checked = 0
    for (const vector of vectors) {
      const data = emptyWallet()
      data.seedHex = vector.seed
      const wallet = new Wallet(data, async () => {}, {timeoutMs: 3_000})
      const reach = wallet as unknown as {
        chainNode(host: string, chain: 'wallet' | 'change'): HDKey
        chainNote(node: HDKey, index: number, domain: string): {ck1: string; cp1: string} | null
      }
      const account = vector.accounts.find(entry => entry.account === 0)!
      for (const chain of ['wallet', 'change'] as const) {
        const node = reach.chainNode(vector.domain, chain)
        for (const note of account[chain].notes) {
          expect(reach.chainNote(node, note.i, `https://${vector.domain}/w`)?.cp1).toBe(note.cp1)
          checked += 1
        }
      }
    }
    expect(checked).toBeGreaterThan(3)
  })
})
