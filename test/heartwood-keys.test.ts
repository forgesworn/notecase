import {createServer} from 'node:net'
import {schnorr} from '@noble/curves/secp256k1.js'
import {afterEach, describe, expect, it} from 'vitest'
import {finalizeEvent, generateSecretKey, getPublicKey, matchFilter, nip19, type Event, type Filter} from 'nostr-tools'
import {nip44} from 'nostr-tools'
import {createFakeBackend, createMoneyer, type FakeBackend, type Moneyer} from '@forgesworn/moneyer'
import {bolt11PaymentHash} from 'farrier-kit/bolt11'
import {hmac} from '@noble/hashes/hmac.js'
import {sha256} from '@noble/hashes/sha2.js'
import {bytesToHex, hexToBytes, randomBytes, utf8ToBytes} from '@noble/hashes/utils.js'
import {
  cashNodeToCx1,
  decodeCx1,
  deriveLegacyCashAddressNode,
  deriveCashRoot,
  deriveNotePubkey,
  deriveNoteSecretKey,
  encodeCk1,
  encodeCp1,
  encodeCx1,
  isAnyCs1,
  signNoteOwnership
} from '../src/lnurlcash.js'
import {NIP46_KIND, type DeviceNote} from '../src/heartwood.ts'
import type {NostrTransport} from '../src/nostr.ts'
import {legacyEcdsaCk1, makeWallet} from './helpers.ts'

// A lightning address owned by a heartwood's own npub, paid to the device's
// own keys (LUD-25 Part 2). The device derives its address branch from that
// identity key - seed = HMAC-SHA256(key, "LNURLcash/nostr-seed"), then
// the old m/139'/1'/d1..d4 firmware still uses - which is what the fake below does, with
// the kit, exactly as heartwood-esp32's cash_key.rs does in Rust against
// vectors the kit produced. The mint is a real moneyer.

const NOSTR_SEED_LABEL = 'LNURLcash/nostr-seed'

type Held = DeviceNote & {k1: string}

const fakeHeartwood = (relay: string) => {
  const secret = generateSecretKey()
  const pubkey = getPublicKey(secret)
  const branchFor = (host: string) =>
    deriveLegacyCashAddressNode(deriveCashRoot(hmac(sha256, secret, utf8ToBytes(NOSTR_SEED_LABEL))), host)
  const notes: Held[] = []
  const bound = new Set<string>()
  const log: string[] = []
  const subs: {filter: Filter; onEvent: (e: Event) => void}[] = []
  let nextId = 1
  // Who the address answer says the branch belongs to: a link served as a
  // persona would name the persona, not the npub it was paired as.
  let answerAs = pubkey
  // How it answers heartwood_note_address_proof: as the firmware does, as
  // firmware from before the method does, or wrongly in one of two ways.
  let proofMode: 'ok' | 'unknown' | 'wrongBranch' | 'wrongDomain' = 'ok'
  // The firmware's address_proof: the branch cash_address hands out for
  // `host` signs sha256("LNURLcash:<action>:<domain>:<name>") with its
  // index-0 key, the domain being the host's bare lowercase hostname.
  const proofFor = (host: string, name: string, action: string, domain = host.replace(/:\d+$/, '').toLowerCase()) => {
    const node = branchFor(host)
    const {pubkeyXOnly, chainCode} = cashNodeToCx1(node)
    const digest = sha256(utf8ToBytes(`LNURLcash:${action}:${domain}:${name}`))
    const sig = schnorr.sign(digest, deriveNoteSecretKey(node.privateKey, node.chainCode, 0), new Uint8Array(32))
    return {cx1: encodeCx1(pubkeyXOnly, chainCode), sig: bytesToHex(sig), domain}
  }

  const answer = (to: string, id: string, body: {result?: unknown; error?: string}): Event =>
    finalizeEvent(
      {
        kind: NIP46_KIND,
        created_at: Math.floor(Date.now() / 1000),
        tags: [['p', to]],
        content: nip44.encrypt(JSON.stringify({id, ...body}), nip44.getConversationKey(secret, to))
      },
      secret
    )
  const ok = (fields: Record<string, unknown>) => ({result: JSON.stringify({ok: true, ...fields})})

  const noteCmd = (method: string, fields: Record<string, unknown>): {result?: unknown; error?: string} => {
    switch (method) {
      case 'heartwood_note_address': {
        const {pubkeyXOnly, chainCode} = cashNodeToCx1(branchFor(String(fields.host)))
        return ok({host: fields.host, cx1: encodeCx1(pubkeyXOnly, chainCode), pubkey: answerAs})
      }
      case 'heartwood_note_address_proof': {
        const host = String(fields.host)
        const name = String(fields.name)
        const action = String(fields.action)
        if (proofMode === 'unknown') return {error: 'unknown note method'}
        const signed =
          proofMode === 'wrongBranch'
            ? proofFor('other.example', name, action)
            : proofMode === 'wrongDomain'
              ? proofFor(host, name, action, 'other.example')
              : proofFor(host, name, action)
        return ok({host, domain: signed.domain, name, action, cx1: signed.cx1, sig: signed.sig})
      }
      case 'heartwood_note_claim': {
        // The firmware's claim_key_note: derive the key at `index` for the
        // endpoint's mint, refuse one that is not at `p`, keep it once.
        const host = String(fields.host)
        const node = branchFor(host.split('/')[0]!)
        const index = Number(fields.index)
        const key = deriveNoteSecretKey(node.privateKey, node.chainCode, index)
        const p = encodeCp1(hexToBytes(getPublicKey(key)))
        if (fields.p !== undefined && fields.p !== p) return {error: 'bad_request'}
        const existing = notes.find(n => n.p === p)
        if (existing) return ok({id: existing.id, created: false, p})
        const id = String(nextId++).padStart(8, '0')
        notes.push({
          id,
          // what the firmware exports: the 65-byte ECDSA shape
          k1: legacyEcdsaCk1(key),
          state: 'confirmed',
          amount_msat: Number(fields.amount_msat),
          host,
          label: '',
          p,
          index,
          ...(typeof fields.sig === 'string' ? {sig: fields.sig} : {})
        })
        return ok({id, created: true, p})
      }
      case 'heartwood_note_list':
        return ok({total: notes.length, offset: 0, notes: notes.map(({k1: _k1, ...meta}) => meta)})
      case 'heartwood_note_export': {
        const n = notes.find(note => note.id === fields.id)
        if (!n || n.state !== 'confirmed') return {error: 'invalid_state'}
        return ok({k1: n.k1})
      }
      case 'heartwood_note_spent': {
        const n = notes.find(note => note.id === fields.id)
        if (!n || n.state !== 'confirmed') return {error: 'invalid_state'}
        n.state = 'spent'
        return ok({})
      }
      default:
        return {error: 'unknown method'}
    }
  }

  const transport: NostrTransport = {
    async query() {
      return []
    },
    subscribe(_relays, filter, onEvent) {
      const sub = {filter, onEvent}
      subs.push(sub)
      return {
        close() {
          subs.splice(subs.indexOf(sub), 1)
        }
      }
    },
    async publish(relays, event) {
      if (!relays.includes(relay)) return {ok: [], failed: relays}
      if (event.kind === NIP46_KIND && event.tags.some(t => t[0] === 'p' && t[1] === pubkey)) {
        const req = JSON.parse(nip44.decrypt(event.content, nip44.getConversationKey(secret, event.pubkey))) as {
          id: string
          method: string
          params: unknown[]
        }
        log.push(req.method)
        let body: {result?: unknown; error?: string}
        if (req.method === 'connect') {
          bound.add(event.pubkey)
          body = {result: 'ack'}
        } else if (!bound.has(event.pubkey)) {
          body = {error: 'unauthorised'}
        } else if (req.method === 'sign_event') {
          // The real device puts a card up; this one holds at once.
          const unsigned = JSON.parse(String(req.params[0])) as {kind: number; created_at: number; tags: string[][]; content: string}
          body = {result: JSON.stringify(finalizeEvent(unsigned, secret))}
        } else {
          body = noteCmd(req.method, (req.params[0] ?? {}) as Record<string, unknown>)
        }
        const reply = answer(event.pubkey, req.id, body)
        for (const sub of [...subs]) if (matchFilter(sub.filter, reply)) sub.onEvent(reply)
      }
      return {ok: relays, failed: []}
    },
    close() {}
  }
  return {
    transport,
    notes,
    log,
    pubkey,
    // What the owner wrote down for this master: it is a bunker master, so
    // its nsec.
    nsec: nip19.nsecEncode(secret),
    branchFor,
    answerAs(other: string) {
      answerAs = other
    },
    proofMode(mode: typeof proofMode) {
      proofMode = mode
    },
    uri: `bunker://${pubkey}?relay=${encodeURIComponent(relay)}&secret=pairing`
  }
}

// The mint's own relay, which its wraps go to.
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
afterEach(async () => {
  await mint?.moneyer.close()
  mint = null
})

// Registration closed, as on moneyer.dev: the name is the operator's to give,
// and its owner can still say where it pays.
const startMint = async (): Promise<Mint> => {
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
      zap: {nostrKey: bytesToHex(randomBytes(32)), relays: ['wss://relay.test'], names: {}}
    },
    {backend, nostr: relay.transport, zapPollMs: 20}
  )
  mint = {moneyer, backend, host: `127.0.0.1:${port}`, relay}
  return mint
}

const waitFor = async (predicate: () => boolean, timeoutMs = 3_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

const pay = async (theMint: Mint, name: string, amountMsat: number): Promise<void> => {
  const before = theMint.relay.stored.filter(e => e.kind === 1059).length
  const cb = (await (await fetch(`${theMint.moneyer.url}/z/cb/${name}?amount=${amountMsat}`)).json()) as {pr: string}
  theMint.backend.control.settleInvoice(bolt11PaymentHash(cb.pr)!)
  await waitFor(() => theMint.relay.stored.filter(e => e.kind === 1059).length > before)
}

const setUp = async (referenceRegistration = false) => {
  const theMint = await startMint()
  const device = fakeHeartwood('wss://device.test')
  const registrations: {method: string; username: string; cx1: string | null; sig: string; npub: string | null}[] = []
  // What moneyer's POST /names was sent, as the NIP-98 request committed to it.
  const bodies: Array<{name: string; cx1: string | null; sig?: string}> = []
  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url)
    if (url.pathname === '/names' && init?.method === 'POST') bodies.push(JSON.parse(String(init.body)))
    if (referenceRegistration && url.pathname === '/p/_' && init?.method === 'POST') {
      return Response.json({status: 'ERROR', reason: 'Invalid or reserved username.'})
    }
    const reference = url.pathname.match(/^\/p\/([^/]+)$/)
    if (referenceRegistration && reference && (init?.method === 'POST' || init?.method === 'DELETE')) {
      registrations.push({
        method: init.method,
        username: decodeURIComponent(reference[1]!),
        cx1: url.searchParams.get('cx1'),
        sig: url.searchParams.get('sig') ?? '',
        npub: url.searchParams.get('npub')
      })
      return Response.json({status: 'OK'})
    }
    return fetch(input, init)
  }
  const {wallet} = makeWallet({fetch: fetchImpl})
  await wallet.addMint(`mint@${theMint.host}`)
  await wallet.linkHeartwood(device.transport, device.uri)
  if (!referenceRegistration) theMint.moneyer.store.putOperatorZapName('donkey', device.pubkey)
  return {theMint, device, wallet, registrations, bodies}
}

// What a mint checks: the branch's pk_0 over the domain-bound digest.
const provenBy = (cx1: string, action: string, name: string, domain: string, sig: string): boolean => {
  const branch = decodeCx1(cx1)!
  const pk0 = deriveNotePubkey(branch.pubkeyXOnly, branch.chainCode, 0)
  return schnorr.verify(hexToBytes(sig), sha256(utf8ToBytes(`LNURLcash:${action}:${domain}:${name}`)), pk0)
}

describe("a name a heartwood's key owns, paid to the heartwood's keys", () => {
  it('registers a reference-mint name on the device branch, proven on the device, and releases it the same way', async () => {
    const {theMint, device, wallet, registrations} = await setUp(true)
    const moved = await wallet.heartwoodNameToKeys(device.transport, 'donkey')
    expect(moved).toEqual({address: `donkey@${theMint.host}`, toKeys: true})
    const {pubkeyXOnly, chainCode} = cashNodeToCx1(device.branchFor(theMint.host))
    const cx1 = encodeCx1(pubkeyXOnly, chainCode)
    expect(registrations).toEqual([
      {method: 'POST', username: 'donkey', cx1, sig: expect.stringMatching(/^[0-9a-f]{128}$/), npub: nip19.npubEncode(device.pubkey)}
    ])
    expect(provenBy(cx1, 'register', 'donkey', '127.0.0.1', registrations[0]!.sig)).toBe(true)
    // one hold for the proof, and nothing else signed
    expect(device.log).toEqual(['connect', 'heartwood_note_address', 'heartwood_note_address_proof'])

    await expect(wallet.heartwoodUnregisterName(device.transport, 'donkey')).resolves.toEqual({address: `donkey@${theMint.host}`})
    expect(registrations[1]).toMatchObject({method: 'DELETE', username: 'donkey', cx1: null})
    expect(provenBy(cx1, 'unregister', 'donkey', '127.0.0.1', registrations[1]!.sig)).toBe(true)
    expect(registrations[1]!.sig).not.toBe(registrations[0]!.sig)
  })

  it('points the name at the branch the device derives, on a proof and a request the device signs', async () => {
    const {theMint, device, wallet} = await setUp()
    const moved = await wallet.heartwoodNameToKeys(device.transport, 'donkey')
    expect(moved).toEqual({address: `donkey@${theMint.host}`, toKeys: true})
    const {pubkeyXOnly, chainCode} = cashNodeToCx1(device.branchFor(theMint.host))
    const cx1 = encodeCx1(pubkeyXOnly, chainCode)
    expect(theMint.moneyer.store.zapName('donkey')?.cx1).toBe(cx1)
    // The wallet's own key signed nothing: the device gave the proof, then
    // signed the request that carries it.
    expect(device.log).toEqual(['connect', 'heartwood_note_address', 'heartwood_note_address_proof', 'sign_event'])

    const back = await wallet.heartwoodNameToKeys(device.transport, 'donkey', {toKeys: false})
    expect(back.toKeys).toBe(false)
    expect(theMint.moneyer.store.zapName('donkey')?.cx1).toBeNull()
    // clearing is proven by the branch on file, which is the device's
    expect(device.log.slice(4)).toEqual(['heartwood_note_address', 'heartwood_note_address_proof', 'sign_event'])
  })

  it('sends the proof in the body the NIP-98 request commits to', async () => {
    const {theMint, device, wallet, bodies} = await setUp()
    await wallet.heartwoodNameToKeys(device.transport, 'donkey')
    const {pubkeyXOnly, chainCode} = cashNodeToCx1(device.branchFor(theMint.host))
    const cx1 = encodeCx1(pubkeyXOnly, chainCode)
    expect(bodies[0]).toMatchObject({name: 'donkey', cx1})
    expect(provenBy(cx1, 'register', 'donkey', '127.0.0.1', bodies[0]!.sig!)).toBe(true)
  })

  it('tells the owner to update heartwood when the firmware does not know the proof method', async () => {
    const {theMint, device, wallet} = await setUp()
    device.proofMode('unknown')
    await expect(wallet.heartwoodNameToKeys(device.transport, 'donkey')).rejects.toThrow('update heartwood to register this name')
    await expect(wallet.heartwoodNameToKeys(device.transport, 'donkey', {toKeys: false})).resolves.toMatchObject({toKeys: false})
    // nothing was asked of the mint on the failed attempt
    expect(device.log.filter(method => method === 'sign_event')).toHaveLength(1)
    expect(theMint.moneyer.store.zapName('donkey')?.cx1 ?? null).toBeNull()
  })

  it('tells the owner to update heartwood before releasing a reference name, too', async () => {
    const {device, wallet, registrations} = await setUp(true)
    device.proofMode('unknown')
    await expect(wallet.heartwoodUnregisterName(device.transport, 'donkey')).rejects.toThrow('update heartwood to release this name')
    expect(registrations).toEqual([])
  })

  it('refuses a proof for another branch, and sends nothing', async () => {
    const {device, wallet, registrations} = await setUp(true)
    device.proofMode('wrongBranch')
    await expect(wallet.heartwoodNameToKeys(device.transport, 'donkey')).rejects.toThrow('different branch')
    expect(registrations).toEqual([])
  })

  it('refuses a proof that does not verify for this mint, and sends nothing', async () => {
    const {theMint, device, wallet} = await setUp()
    device.proofMode('wrongDomain')
    await expect(wallet.heartwoodNameToKeys(device.transport, 'donkey')).rejects.toThrow('does not verify')
    expect(device.log).not.toContain('sign_event')
    expect(theMint.moneyer.store.zapName('donkey')?.cx1 ?? null).toBeNull()
  })

  it('finds a payment the device never saw a wrap for, has the device keep it, and collects it', async () => {
    const {theMint, device, wallet} = await setUp()
    await wallet.heartwoodNameToKeys(device.transport, 'donkey')
    await pay(theMint, 'donkey', 21_000)

    const scan = await wallet.heartwoodScanAddress(device.transport, theMint.host, {gap: 3})
    expect(scan.claimed).toEqual([{id: device.notes[0]!.id, index: 0, amountMsat: 21_000}])
    expect(scan.scanned).toBe(1 + 3)
    const kept = device.notes[0]!
    expect(kept.host).toBe(`${theMint.host}/w`)
    expect(isAnyCs1(kept.sig!)).toBe(true)

    // A scan puts a note ON the device, so the inventory it leaves behind
    // has to include it - by its index on the branch, never its ck1.
    expect(wallet.heartwoodInventory()!.notes).toEqual([
      {id: kept.id, amountMsat: 21_000, host: `${theMint.host}/w`, state: 'confirmed', index: 0}
    ])
    expect(wallet.heartwoodHeld()).toMatchObject({msat: 21_000, notes: 1})
    expect(JSON.stringify(wallet.heartwoodInventory()!.notes)).not.toContain(kept.k1)

    // A second scan finds it held and keeps nothing twice.
    expect((await wallet.heartwoodScanAddress(device.transport, theMint.host, {gap: 3})).claimed).toEqual([])
    expect(device.notes).toHaveLength(1)

    // Collecting releases a ck1, never the key, and the wallet rotates it.
    const collected = await wallet.collectFromHeartwood(device.transport)
    expect(collected.failed).toEqual([])
    expect(collected.collected.map(r => r.note.amountMsat)).toEqual([21_000])
    expect(device.notes[0]!.state).toBe('spent')
    expect(wallet.balanceMsat()).toBe(21_000)
    const stats = (await (await fetch(`${theMint.moneyer.url}/stats`)).json()) as {outstandingNotes: number}
    expect(stats.outstandingNotes).toBe(1)
  })

  it('collects only the notes named, and leaves the rest on the device', async () => {
    const {theMint, device, wallet} = await setUp()
    await wallet.heartwoodNameToKeys(device.transport, 'donkey')
    await pay(theMint, 'donkey', 21_000)
    await pay(theMint, 'donkey', 5_000)
    await wallet.heartwoodScanAddress(device.transport, theMint.host, {gap: 3})
    const [first, second] = device.notes
    await expect(wallet.collectFromHeartwood(device.transport, () => {}, {ids: ['nosuchid']})).rejects.toThrow('Nothing to collect')
    expect(device.log).not.toContain('heartwood_note_export')

    const result = await wallet.collectFromHeartwood(device.transport, () => {}, {ids: [second!.id]})
    expect(result.collected.map(r => r.note.amountMsat)).toEqual([second!.amount_msat])
    expect(device.notes.map(n => n.state)).toEqual(['confirmed', 'spent'])
    expect(first!.state).toBe('confirmed')
  })

  it("recovers a lost heartwood's notes from its nsec, into a wallet that never saw it", async () => {
    const {theMint, device, wallet} = await setUp()
    await wallet.heartwoodNameToKeys(device.transport, 'donkey')
    await pay(theMint, 'donkey', 21_000)
    await pay(theMint, 'donkey', 5_000)

    // the device is gone; a fresh wallet with only the master's nsec
    const {wallet: rescuer} = makeWallet()
    await rescuer.addMint(`mint@${theMint.host}`)
    const opts = {expectedPubkey: device.pubkey, mintHost: theMint.host, gap: 3}
    await expect(rescuer.recoverHeartwoodNotes(nip19.nsecEncode(generateSecretKey()), opts)).rejects.toThrow('does not open')

    const result = await rescuer.recoverHeartwoodNotes(device.nsec, opts)
    expect(result.mode).toBe('bunker')
    expect(result.received.map(r => r.note.amountMsat).sort((a, b) => a - b)).toEqual([5_000, 21_000])
    // the spec's branch first, where this firmware was never paid, then the
    // old m/139'/1' one it still hands out
    expect(result.scanned).toBe(3 + 2 + 3)
    expect(rescuer.balanceMsat()).toBe(26_000)
    // taken, so a second recovery finds the keys spent and takes nothing
    expect((await rescuer.recoverHeartwoodNotes(device.nsec, opts)).received).toEqual([])
  })

  it('refuses a branch the device says belongs to another identity, before anything is signed', async () => {
    const {theMint, device, wallet} = await setUp()
    device.answerAs(getPublicKey(generateSecretKey()))
    await expect(wallet.heartwoodNameToKeys(device.transport, 'donkey')).rejects.toThrow('not the linked')
    expect(device.log).not.toContain('sign_event')
    expect(theMint.moneyer.store.zapName('donkey')?.cx1 ?? null).toBeNull()
  })

  it("cannot move a name the device's key does not own", async () => {
    const {theMint, device, wallet} = await setUp()
    theMint.moneyer.store.putOperatorZapName('mule', getPublicKey(generateSecretKey()))
    await expect(wallet.heartwoodNameToKeys(device.transport, 'mule')).rejects.toThrow('taken')
    expect(theMint.moneyer.store.zapName('mule')?.cx1 ?? null).toBeNull()
  })
})
