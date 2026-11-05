import {createServer} from 'node:net'
import {afterEach, describe, expect, it} from 'vitest'
import {matchFilter, type Event, type Filter} from 'nostr-tools'
import {createFakeBackend, createMoneyer, type FakeBackend, type Moneyer} from '@forgesworn/moneyer'
import {bolt11PaymentHash} from 'farrier-kit/bolt11'
import {bytesToHex, randomBytes} from '@noble/hashes/utils.js'
import {
  cashNodeToCx1,
  deriveCashRoot,
  deriveLegacyCashAddressNode,
  deriveNostrAddressNode,
  encodeLegacyCx1,
  bearerNoteIdOfPreimage,
  isCk1
} from '../src/lnurlcash.js'
import {hexToBytes} from '@noble/hashes/utils.js'
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

// null: registration closed, as on moneyer.dev - only a name's owner may
// still say where it pays
const startMint = async (namePriceMsat: number | null = 0): Promise<Mint> => {
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
      ...(namePriceMsat === null ? {} : {namePriceMsat})
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
    const share = wallet.addressCx1(theMint.host)
    const claimed = await wallet.registerName({name: 'alice'})
    expect(claimed.toKeys).toBe(true)
    expect(theMint.moneyer.store.zapName('alice')?.cx1).toBe(share)

    await pay(theMint, 'alice', 21_000)
    const got = await wallet.receiveFromNostr(theMint.relay.transport)
    expect(got.skipped).toEqual([])
    expect(got.received).toHaveLength(1)
    expect(got.received[0]!.note.amountMsat).toBe(21_000)
    // rotated onto a key of its own at once, on its wallet chain: the
    // share's key, which the mint holding the cx1 can derive, is spent
    const live = wallet.liveNotes()
    expect(live).toHaveLength(1)
    expect(live[0]!.scheme).toBe('wallet')
    expect(live[0]!.index).toBe(0)
    expect(isCk1(live[0]!.k1)).toBe(true)
    expect(wallet.balanceMsat()).toBe(21_000)
  })

  it('finds a payment whose wrap never arrived by scanning the share', async () => {
    const theMint = await startMint()
    const {wallet} = seededWallet()
    await wallet.addMint(`mint@${theMint.host}`)
    await wallet.registerName({name: 'alice'})
    await pay(theMint, 'alice', 21_000)
    await pay(theMint, 'alice', 5_000)

    const scan = await wallet.scanAddress(theMint.host, {gap: 5})
    expect(scan.received.map(r => r.note.amountMsat).sort((a, b) => a - b)).toEqual([5_000, 21_000])
    // share 0 to its two keys paid and a gap; shares 1 to 5 empty, and so
    // 0 to 4 on the Nostr key's root; then the four superseded whole
    // branches, each on the Lightning Address purpose and the ladder from
    // before purposes
    expect(scan.scanned).toBe(2 + 5 + 5 * 5 + 5 * 5 + 5 * 8)
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

  it('pays a wallet with no words to its Nostr key, and moves the name as the wallet changes', async () => {
    const theMint = await startMint()
    const made = makeWallet()
    await made.wallet.addMint(`mint@${theMint.host}`)
    await made.wallet.ensureNostrIdentity()
    const nostrCx1 = made.wallet.addressCx1(theMint.host)
    const claimed = await made.wallet.registerName({name: 'alice'})
    expect(claimed.toKeys).toBe(true)
    expect(theMint.moneyer.store.zapName('alice')?.cx1).toBe(nostrCx1)
    await pay(theMint, 'alice', 21_000)
    expect((await made.wallet.receiveFromNostr(theMint.relay.transport)).received.map(r => r.note.amountMsat)).toEqual([21_000])

    // Words later. A payment made before the name moves still lands on the
    // Nostr key's share, and the wallet still holds that key.
    made.data.seedHex = seedFromMnemonic(newMnemonic())
    await pay(theMint, 'alice', 5_000)
    const late = await made.wallet.receiveFromNostr(theMint.relay.transport)
    expect(late.skipped).toEqual([])
    expect(late.received.map(r => r.note.amountMsat)).toEqual([5_000])

    // the share on file is never overwritten: the move is LUD-26's PUT,
    // proven by the Nostr key's share and by the new one from the words
    const wordsCx1 = made.wallet.addressCx1(theMint.host)
    expect(wordsCx1).not.toBe(nostrCx1)
    expect((await made.wallet.payNameToKeys()).toKeys).toBe(true)
    expect(theMint.moneyer.store.zapName('alice')?.cx1).toBe(wordsCx1)
    await pay(theMint, 'alice', 3_000)
    expect((await made.wallet.receiveFromNostr(theMint.relay.transport)).received.map(r => r.note.amountMsat)).toEqual([3_000])
    expect((await made.wallet.payNameToKeys(false)).toKeys).toBe(false)
    expect(theMint.moneyer.store.zapName('alice')?.cx1).toBeNull()
    expect(made.wallet.balanceMsat()).toBe(29_000)
  })

  it("keeps paying a name still on a whole branch from before LUD-26, and moves it onto a share", async () => {
    const theMint = await startMint()
    const made = seededWallet()
    await made.wallet.addMint(`mint@${theMint.host}`)
    await made.wallet.registerName({name: 'alice'})
    // where a wallet before 2026-09-16 pointed the name
    const legacy = cashNodeToCx1(deriveLegacyCashAddressNode(deriveCashRoot(hexToBytes(made.data.seedHex!)), theMint.host))
    const legacyCx1 = encodeLegacyCx1({pubkeyXOnly: legacy.pubkeyXOnly, chainCode: legacy.chainCode})
    expect(legacyCx1).not.toBe(made.wallet.addressCx1(theMint.host))
    theMint.moneyer.store.setZapNameCx1('alice', legacyCx1)

    await pay(theMint, 'alice', 21_000)
    const got = await made.wallet.receiveFromNostr(theMint.relay.transport)
    expect(got.skipped).toEqual([])
    expect(got.received.map(r => r.note.amountMsat)).toEqual([21_000])

    // a wrap that never arrived is still found by the walk
    await pay(theMint, 'alice', 5_000)
    theMint.relay.stored.length = 0
    const scan = await made.wallet.scanAddress(theMint.host, {gap: 3})
    expect(scan.received.map(r => r.note.amountMsat)).toEqual([5_000])

    // PUT, proven by the old branch's own key and by the new share
    const next = made.wallet.addressCx1(theMint.host)
    await made.wallet.payNameToKeys()
    expect(theMint.moneyer.store.zapName('alice')?.cx1).toBe(next)
    expect(made.data.settings.lightningAddressCx1).toBe(next)
    await pay(theMint, 'alice', 3_000)
    expect((await made.wallet.receiveFromNostr(theMint.relay.transport)).received.map(r => r.note.amountMsat)).toEqual([3_000])
    expect(made.wallet.balanceMsat()).toBe(29_000)
    const stats = (await (await fetch(`${theMint.moneyer.url}/stats`)).json()) as {outstandingMsat: number}
    expect(stats.outstandingMsat).toBe(29_000)
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
    // share 0's spent key and a gap, five empty shares on each root, and
    // the whole branches on both of their ladders
    expect(scan.scanned).toBe(1 + 3 + 5 * 3 + 5 * 3 + 3 * 8)
    const stats = (await (await fetch(`${theMint.moneyer.url}/stats`)).json()) as {outstandingNotes: number}
    // the rotated note, and nothing left on the key
    expect(stats.outstandingNotes).toBe(1)
    expect(wallet.balanceMsat()).toBe(21_000)
  })

  it('moves a name its key owns but never recorded, such as one the operator set up', async () => {
    const theMint = await startMint(null)
    const {wallet} = seededWallet()
    await wallet.addMint(`mint@${theMint.host}`)
    theMint.moneyer.store.putOperatorZapName('ops', (await wallet.ensureNostrIdentity()).pubkey)

    await expect(wallet.payNameToKeys()).rejects.toThrow(WalletUsageError)
    const share = wallet.addressCx1(theMint.host)
    const moved = await wallet.payNameToKeys(true, {name: 'ops'})
    expect(moved.toKeys).toBe(true)
    expect(theMint.moneyer.store.zapName('ops')?.cx1).toBe(share)
    expect(wallet.lightningAddress()).toBe(`ops@${theMint.host}`)
    // and back to gift-wrapped notes, proven by the share on file
    expect((await wallet.payNameToKeys(false)).toKeys).toBe(false)
    expect(theMint.moneyer.store.zapName('ops')?.cx1).toBeNull()
  })

  it('takes the note back when re-claiming a priced name it already owns, and says how to move it', async () => {
    const theMint = await startMint(21_000)
    const {wallet} = seededWallet()
    await wallet.addMint(`mint@${theMint.host}`)
    const k1 = freshK1()
    theMint.moneyer.store.creditNote(bearerNoteIdOfPreimage(k1), 50_000)
    await wallet.receive(`${theMint.moneyer.url}/w?k1=${k1}&amount=50000`)

    const first = await wallet.registerName({name: 'alice'})
    expect(first.paidMsat).toBe(21_000)
    expect(wallet.balanceMsat()).toBe(29_000)

    // the share on file is never overwritten by a claim: the mint refuses,
    // takes nothing, and the note comes home
    await expect(wallet.registerName({name: 'alice'})).rejects.toThrow(/address keys alice/)
    expect(wallet.balanceMsat()).toBe(29_000)
    expect(wallet.sentNotes()).toEqual([])
  })

  it("pays a name at the same mint with a note, free, and the name's wallet finds it on its share", async () => {
    const theMint = await startMint()
    const {wallet: bob} = seededWallet()
    await bob.addMint(`mint@${theMint.host}`)
    await bob.registerName({name: 'bob'})

    const {wallet: alice} = seededWallet()
    await alice.addMint(`mint@${theMint.host}`)
    const k1 = freshK1()
    theMint.moneyer.store.creditNote(bearerNoteIdOfPreimage(k1), 50_000)
    await alice.receive(`${theMint.moneyer.url}/w?k1=${k1}&amount=50000`)

    const sent = await alice.payAddressInternally(`bob@${theMint.host}`, 21_000)
    expect(sent).toMatchObject({host: theMint.host, ambiguous: false})
    expect(sent!.note.state).toBe('spent')
    expect(alice.balanceMsat()).toBe(29_000)

    // no fee taken, and no Lightning payment made
    const scan = await bob.scanAddress(theMint.host, {gap: 3})
    expect(scan.received.map(r => r.note.amountMsat)).toEqual([21_000])
    const stats = (await (await fetch(`${theMint.moneyer.url}/stats`)).json()) as {outstandingMsat: number}
    expect(stats.outstandingMsat).toBe(50_000)
  })

  it('leaves a name it cannot cover, or that is no registered name, to be paid over Lightning', async () => {
    const theMint = await startMint()
    const {wallet: bob} = seededWallet()
    await bob.addMint(`mint@${theMint.host}`)
    await bob.registerName({name: 'bob'})
    const {wallet: alice} = seededWallet()
    await alice.addMint(`mint@${theMint.host}`)
    // nothing held there
    expect(await alice.payAddressInternally(`bob@${theMint.host}`, 21_000)).toBeNull()
    // a name nobody registered
    expect(await alice.payAddressInternally(`nobody@${theMint.host}`, 21_000)).toBeNull()
    // the mint's own address takes payments, but is no registered name
    expect(await alice.payAddressInternally(`mint@${theMint.host}`, 21_000)).toBeNull()
  })
})
