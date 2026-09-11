import {createServer} from 'node:net'
import {afterEach, describe, expect, it} from 'vitest'
import {matchFilter, type Event, type Filter} from 'nostr-tools'
import {createFakeBackend, createMoneyer, type FakeBackend, type Moneyer} from '@forgesworn/moneyer'
import {bolt11PaymentHash} from 'farrier-kit/bolt11'
import {bytesToHex, randomBytes} from '@noble/hashes/utils.js'
import {hashK1, isCk1} from 'lnurlcash-kit'
import type {NostrTransport} from '../src/nostr.ts'
import {newMnemonic, seedFromMnemonic} from '../src/store.ts'
import {WalletUsageError} from '../src/wallet.ts'
import {freshK1, makeWallet} from './helpers.ts'

// A moneyer name with a cx1 is paid to this wallet's own keys. The gift wrap
// says only where to look and at which index; the wallet derives the key,
// checks the certificate, and rotates the note onto a secret of its own.

// One in-memory relay that the mint publishes to and the wallet reads.
const memoryRelay = () => {
  const stored: Event[] = []
  const transport: NostrTransport = {
    async publish(relays, event) {
      stored.push(event)
      return {ok: relays, failed: []}
    },
    async query(_relays, filter: Filter) {
      return stored.filter(event => matchFilter(filter, event))
    },
    subscribe() {
      return {close() {}}
    },
    close() {}
  }
  return {stored, transport}
}

// The wrap's URLs point at the mint's public origin, so it has to be the
// real port, known before the mint starts.
const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      probe.close(() => resolve(typeof address === 'object' && address ? address.port : 0))
    })
  })

type Mint = {moneyer: Moneyer; backend: FakeBackend; host: string; relay: ReturnType<typeof memoryRelay>}
let mint: Mint | null = null

const startMint = async (namePriceMsat = 0): Promise<Mint> => {
  const port = await freePort()
  const backend = createFakeBackend()
  const relay = memoryRelay()
  const moneyer = await createMoneyer(
    {
      host: '127.0.0.1',
      port,
      username: 'mint',
      description: 'an LNURLcash note',
      minSendableMsat: 1000,
      maxSendableMsat: 100_000_000,
      minMintMsat: 1000,
      mintFee: null,
      signingKey: bytesToHex(randomBytes(32)),
      dbPath: ':memory:',
      backend: {kind: 'fake'},
      verify: true,
      maxK1s: 21,
      sunset: false,
      publicOrigin: `http://127.0.0.1:${port}`,
      zap: {nostrKey: bytesToHex(randomBytes(32)), relays: ['wss://relay.test'], names: {}},
      namePriceMsat
    },
    {backend, nostr: relay.transport, zapPollMs: 20}
  )
  mint = {moneyer, backend, host: `127.0.0.1:${port}`, relay}
  return mint
}
afterEach(async () => {
  await mint?.moneyer.close()
  mint = null
})

const seededWallet = () => {
  const made = makeWallet()
  made.data.seedHex = seedFromMnemonic(newMnemonic())
  return made
}

const wrapCount = (theMint: Mint) => theMint.relay.stored.filter(event => event.kind === 1059).length

const waitFor = async (predicate: () => boolean, timeoutMs = 3_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

// Pays `name` and waits for the mint to credit it and publish the wrap.
const pay = async (theMint: Mint, name: string, amountMsat: number): Promise<void> => {
  const before = wrapCount(theMint)
  const cb = (await (await fetch(`${theMint.moneyer.url}/z/cb/${name}?amount=${amountMsat}`)).json()) as {pr: string}
  theMint.backend.control.settleInvoice(bolt11PaymentHash(cb.pr)!)
  await waitFor(() => wrapCount(theMint) > before)
}

describe('a name paid to this wallet\'s keys', () => {
  it('registers the branch, and takes what arrives at it from the inbox', async () => {
    const theMint = await startMint()
    const {wallet} = seededWallet()
    await wallet.addMint(`mint@${theMint.host}`)
    const claimed = await wallet.registerName({name: 'alice'})
    expect(claimed.toKeys).toBe(true)
    expect(theMint.moneyer.store.zapName('alice')?.cx1).toBe(wallet.addressCx1(theMint.host))

    await pay(theMint, 'alice', 21_000)
    const got = await wallet.receiveFromNostr(theMint.relay.transport)
    expect(got.skipped).toEqual([])
    expect(got.received).toHaveLength(1)
    expect(got.received[0]!.note.amountMsat).toBe(21_000)
    // rotated onto a secret of its own at once: no ck1 is held
    expect(wallet.liveNotes().some(note => isCk1(note.k1))).toBe(false)
    expect(wallet.balanceMsat()).toBe(21_000)
  })

  it('finds a payment whose wrap never arrived by scanning the branch', async () => {
    const theMint = await startMint()
    const {wallet} = seededWallet()
    await wallet.addMint(`mint@${theMint.host}`)
    await wallet.registerName({name: 'alice'})
    await pay(theMint, 'alice', 21_000)
    await pay(theMint, 'alice', 5_000)

    const scan = await wallet.scanAddress(theMint.host, {gap: 5})
    expect(scan.received.map(r => r.note.amountMsat).sort((a, b) => a - b)).toEqual([5_000, 21_000])
    expect(scan.scanned).toBe(2 + 5)
    expect(wallet.balanceMsat()).toBe(26_000)

    // the wraps that arrive late find their notes already taken
    const late = await wallet.receiveFromNostr(theMint.relay.transport)
    expect(late.received).toEqual([])
    expect(wallet.balanceMsat()).toBe(26_000)
  })

  it('skips a note paid to a key it does not hold', async () => {
    const theMint = await startMint()
    const made = seededWallet()
    await made.wallet.addMint(`mint@${theMint.host}`)
    await made.wallet.registerName({name: 'alice'})
    await pay(theMint, 'alice', 21_000)
    // the same Nostr key, but other recovery words
    made.data.seedHex = seedFromMnemonic(newMnemonic())
    const got = await made.wallet.receiveFromNostr(theMint.relay.transport)
    expect(got.received).toEqual([])
    expect(got.skipped[0]!.reason).toMatch(/does not hold/)
  })

  it('moves a custodial name onto its keys, and back', async () => {
    const theMint = await startMint()
    const made = makeWallet()
    await made.wallet.addMint(`mint@${theMint.host}`)
    const claimed = await made.wallet.registerName({name: 'alice'})
    expect(claimed.toKeys).toBe(false)

    made.data.seedHex = seedFromMnemonic(newMnemonic())
    expect((await made.wallet.payNameToKeys()).toKeys).toBe(true)
    expect(theMint.moneyer.store.zapName('alice')?.cx1).toBe(made.wallet.addressCx1(theMint.host))
    expect((await made.wallet.payNameToKeys(false)).toKeys).toBe(false)
    expect(theMint.moneyer.store.zapName('alice')?.cx1).toBeNull()
  })

  it('leaves the key spent once taken, so a later scan counts it as used and takes nothing twice', async () => {
    const theMint = await startMint()
    const {wallet} = seededWallet()
    await wallet.addMint(`mint@${theMint.host}`)
    await wallet.registerName({name: 'alice'})
    await pay(theMint, 'alice', 21_000)
    await wallet.receiveFromNostr(theMint.relay.transport)

    const scan = await wallet.scanAddress(theMint.host, {gap: 3})
    expect(scan.received).toEqual([])
    expect(scan.scanned).toBe(1 + 3)
    const stats = (await (await fetch(`${theMint.moneyer.url}/stats`)).json()) as {outstandingNotes: number}
    // the rotated note, and nothing left on the key
    expect(stats.outstandingNotes).toBe(1)
    expect(wallet.balanceMsat()).toBe(21_000)
  })

  it('moves a name its key owns but never recorded, such as one the operator set up', async () => {
    const theMint = await startMint()
    const {wallet} = seededWallet()
    await wallet.addMint(`mint@${theMint.host}`)
    theMint.moneyer.store.putOperatorZapName('ops', (await wallet.ensureNostrIdentity()).pubkey)

    await expect(wallet.payNameToKeys()).rejects.toThrow(WalletUsageError)
    const moved = await wallet.payNameToKeys(true, {name: 'ops'})
    expect(moved.toKeys).toBe(true)
    expect(theMint.moneyer.store.zapName('ops')?.cx1).toBe(wallet.addressCx1(theMint.host))
    expect(wallet.lightningAddress()).toBe(`ops@${theMint.host}`)
  })

  it('takes the note back when re-claiming a priced name it already owns', async () => {
    const theMint = await startMint(21_000)
    const {wallet} = seededWallet()
    await wallet.addMint(`mint@${theMint.host}`)
    const k1 = freshK1()
    theMint.moneyer.store.creditNote(hashK1(k1), 50_000)
    await wallet.receive(`${theMint.moneyer.url}/w?k1=${k1}&amount=50000`)

    const first = await wallet.registerName({name: 'alice'})
    expect(first.paidMsat).toBe(21_000)
    expect(wallet.balanceMsat()).toBe(29_000)

    // the mint only updates where the name pays, and takes nothing
    const again = await wallet.registerName({name: 'alice'})
    expect(again.paidMsat).toBe(0)
    expect(again.toKeys).toBe(true)
    expect(wallet.balanceMsat()).toBe(29_000)
  })
})
