import {afterEach, describe, expect, it} from 'vitest'
import {createMockMint} from 'lnurlcash-conformance/mock-mint'
import {deriveNoteRoot, deriveNoteSecret, hashK1} from 'lnurlcash-kit'
import {hexToBytes} from '@noble/hashes/utils.js'
import {Wallet, WalletUsageError} from '../src/wallet.ts'
import {newMnemonic, seedFromMnemonic} from '../src/store.ts'
import {emptyWallet} from '../src/types.ts'
import {freshK1} from './helpers.ts'

// Twelve words and the name of a mint are enough to find the money. That
// is the whole promise, and it rests on two things: every secret this
// wallet makes comes off the seed, and the counter that says which one is
// next is persisted before the secret's hash reaches the mint.

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

  it('takes every secret it makes off the seed, in order, per mint', async () => {
    const theMint = await start()
    const {wallet, data} = seeded(WORDS)
    const host = hostOf(theMint)
    const root = deriveNoteRoot(hexToBytes(data.seedHex!))

    // a receive rotates, which is one derived secret
    const received = await wallet.receive(fund(theMint, 100_000))
    expect(received.note.index).toBe(0)
    expect(received.note.k1).toBe(deriveNoteSecret(root, host, 0))
    expect(wallet.counterFor(host)).toBe(1)

    // a split takes two: the amount and its change
    const sent = await wallet.send(30_000)
    expect(sent.index).toBe(1)
    expect(sent.k1).toBe(deriveNoteSecret(root, host, 1))
    const change = wallet.liveNotes()[0]!
    expect(change.index).toBe(2)
    expect(change.k1).toBe(deriveNoteSecret(root, host, 2))
    expect(wallet.counterFor(host)).toBe(3)
  })

  it('persists the counter before the hash goes on the wire', async () => {
    const theMint = await start()
    let cutTheWire = false
    const fetchImpl: typeof globalThis.fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url)
      if (cutTheWire && url.pathname === '/w/cb') throw new TypeError('fetch failed')
      return fetch(input, init)
    }
    const {wallet} = seeded(WORDS, {fetch: fetchImpl})
    const host = hostOf(theMint)
    const received = await wallet.receive(fund(theMint, 21_000))
    const before = wallet.counterFor(host)

    cutTheWire = true
    await expect(wallet.rotateLive(received.note)).rejects.toThrow()
    // the secret was staged and the counter moved with it: a wasted index
    // costs nothing, and the other order would lose the note
    expect(wallet.counterFor(host)).toBe(before + 1)
  })

  it('never reuses an index after a mutation is unwound', async () => {
    const theMint = await start()
    const {wallet} = seeded(WORDS)
    const host = hostOf(theMint)
    await wallet.receive(fund(theMint, 21_000))
    expect(wallet.counterFor(host)).toBe(1)

    // a mint that has stopped splitting: a refusal that cannot possibly
    // be a mutation that landed, so the staged records are dropped
    theMint.state.opts.sunset = true
    await expect(wallet.send(9_000)).rejects.toThrow()
    theMint.state.opts.sunset = false
    // the two staged indices are spent even though nothing was minted
    expect(wallet.counterFor(host)).toBe(3)

    const next = await wallet.send(9_000)
    expect(next.index).toBe(3)
    expect(wallet.balanceMsat()).toBe(12_000)
  })
})

describe('restoring from the words', () => {
  it('finds the money again from nothing but the seed and the mint', async () => {
    const theMint = await start()
    const original = seeded(WORDS)
    await original.wallet.addMint(`mint@${hostOf(theMint)}`)
    await original.wallet.receive(fund(theMint, 100_000))
    const handed = await original.wallet.send(30_000)
    // and somebody takes it, so only the change is still this seed's
    const other = seeded(newMnemonic())
    await other.wallet.receive(original.wallet.noteUrlFor(handed))
    const expected = original.wallet.balanceMsat()
    expect(expected).toBe(70_000)

    // a fresh device: the same words, the same mint, nothing else
    const fresh = seeded(WORDS)
    await fresh.wallet.addMint(`mint@${hostOf(theMint)}`)
    expect(fresh.wallet.balanceMsat()).toBe(0)

    // the mock mint answers no lookups by hash, so these walk by secret
    const restored = await fresh.wallet.restoreFromMint(hostOf(theMint), {
      allowSecretDisclosure: true
    })
    expect(restored.found.length).toBeGreaterThan(0)
    expect(fresh.wallet.balanceMsat()).toBe(expected)
    // and it knows where to carry on from - past everything the walk
    // disclosed, not merely past the last note it found, because those
    // secrets are in the mint's request log now
    expect(fresh.wallet.counterFor(hostOf(theMint))).toBeGreaterThanOrEqual(
      original.wallet.counterFor(hostOf(theMint))
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
    const root = deriveNoteRoot(hexToBytes(data.seedHex!))

    // indices 0 and 1 used and burned, 2 alive, then nothing
    for (const index of [0, 1]) {
      const k1 = deriveNoteSecret(root, host, index)
      theMint.state.creditNote(k1, 1_000)
      theMint.state.settleMelt(k1)
    }
    theMint.state.creditNote(deriveNoteSecret(root, host, 2), 7_000)

    const restored = await wallet.restoreFromMint(host, {allowSecretDisclosure: true})
    expect(restored.found.map(note => note.index)).toEqual([2])
    expect(wallet.balanceMsat()).toBe(7_000)
    // 3 would be right for a walk that disclosed nothing. This one asked
    // by secret, so it burned every index it touched looking for more:
    // minting into any of them now would mint a note the mint's log
    // already holds the secret for.
    expect(restored.next).toBe(23)
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
    expect(upgraded.liveNotes()[0]!.k1).toBe(deriveNoteSecret(deriveNoteRoot(hexToBytes(legacy.seedHex!)), host, 0))

    // and now a restore on a fresh device finds it
    const fresh = seeded(WORDS)
    await fresh.wallet.addMint(`mint@${host}`)
    await fresh.wallet.restoreFromMint(host, {allowSecretDisclosure: true})
    expect(fresh.wallet.balanceMsat()).toBe(21_000)
    expect(hashK1(fresh.wallet.liveNotes()[0]!.k1)).toBe(upgraded.liveNotes()[0]!.id)
  })
})
