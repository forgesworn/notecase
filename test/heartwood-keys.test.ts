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
  decodeLegacyCx1,
  deriveCashAddressNode,
  deriveLegacyCashAddressNode,
  deriveCashRoot,
  deriveLegacyNotePubkey,
  LEGACY_NOTE_PURPOSE_WALLET,
  LEGACY_NOTE_PURPOSE_LIGHTNING_ADDRESS,
  type NotePurpose,
  deriveLegacyNoteSecretKey,
  encodeCk1,
  encodeCp1,
  encodeLegacyCx1,
  isCs1WithAmount,
  signNoteOwnership
} from '../src/lnurlcash.js'
import {NIP46_KIND, type DeviceNote} from '../src/heartwood.ts'
import type {NostrTransport} from '../src/nostr.ts'
import {legacyEcdsaCk1, makeWallet} from './helpers.ts'

// A lightning address owned by a heartwood's own npub, paid to the device's
// own keys (LUD-25 Part 2). The device derives its address branch from that
// identity key - seed = HMAC-SHA256(key, "LNURLcash/nostr-seed"), then
// m/139'/d1..d4 since firmware 0.18.0-beta.24 and m/139'/1'/d1..d4 before -
// which is what the fake below does, with the kit, as heartwood-esp32's
// cash_key.rs does in Rust against lnurlcash-conformance's vectors. The mint
// is a real moneyer.

const NOSTR_SEED_LABEL = 'LNURLcash/nostr-seed'

type Held = DeviceNote & {key: Uint8Array}

const fakeHeartwood = (relay: string) => {
  const secret = generateSecretKey()
  const pubkey = getPublicKey(secret)
  const root = () => deriveCashRoot(hmac(sha256, secret, utf8ToBytes(NOSTR_SEED_LABEL)))
  const currentBranch = (host: string) => deriveCashAddressNode(root(), host)
  const supersededBranch = (host: string) => deriveLegacyCashAddressNode(root(), host)
  // The branch the device hands out: the spec's since beta.24, the
  // superseded one before.
  const branchFor = (host: string) => (firmware === 'purposes' ? currentBranch(host) : supersededBranch(host))
  const notes: Held[] = []
  const bound = new Set<string>()
  const log: string[] = []
  // What each heartwood_note_claim was sent.
  const claims: Record<string, unknown>[] = []
  const subs: {filter: Filter; onEvent: (e: Event) => void}[] = []
  let nextId = 1
  // Who the address answer says the branch belongs to: a link served as a
  // persona would name the persona, not the npub it was paired as.
  let answerAs = pubkey
  // How it answers heartwood_note_address_proof: as the firmware does, as
  // firmware from before the method does, or wrongly in one of two ways.
  let proofMode: 'ok' | 'unknown' | 'wrongBranch' | 'wrongDomain' = 'ok'
  // 0.18.0-beta.24 ('purposes'): a claim names its purpose (2 when it does
  // not), is found on the current branch or, given its `p`, the superseded
  // one, carries its certificate as `c` (or `sig`), and a key note exports
  // as a ck1 bound to its mint. Before it ('prePurpose'): the superseded
  // branch only, the ladder before purposes only, `sig`, and the 65-byte
  // ECDSA ck1.
  let firmware: 'purposes' | 'prePurpose' = 'purposes'
  // The firmware's address_proof: the branch cash_address hands out for
  // `host` signs sha256("LNURLcash:<action>:<domain>:<name>") with its
  // purpose-0 index-0 key (firmware from before purposes signs with its
  // unpurposed one, which no mint takes), the domain being the host's bare lowercase hostname.
  const proofFor = (host: string, name: string, action: string, domain = host.replace(/:\d+$/, '').toLowerCase()) => {
    const node = branchFor(host)
    const {pubkeyXOnly, chainCode} = cashNodeToCx1(node)
    const digest = sha256(utf8ToBytes(`LNURLcash:${action}:${domain}:${name}`))
    const sig = schnorr.sign(digest, deriveLegacyNoteSecretKey(node.privateKey, node.chainCode, LEGACY_NOTE_PURPOSE_WALLET, 0), new Uint8Array(32))
    return {cx1: encodeLegacyCx1({pubkeyXOnly: pubkeyXOnly, chainCode: chainCode}), sig: bytesToHex(sig), domain}
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
        return ok({host: fields.host, cx1: encodeLegacyCx1({pubkeyXOnly: pubkeyXOnly, chainCode: chainCode}), pubkey: answerAs})
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
        // The firmware's claim_key_note: derive the key at `index` of the
        // claim's purpose for the endpoint's mint, refuse one that is not at
        // `p`, keep it once.
        const host = String(fields.host)
        const mintHost = host.split('/')[0]!
        const index = Number(fields.index)
        const purpose: NotePurpose = firmware === 'purposes' ? ((fields.purpose as NotePurpose | undefined) ?? LEGACY_NOTE_PURPOSE_LIGHTNING_ADDRESS) : null
        const nodes = firmware === 'purposes' ? [currentBranch(mintHost), supersededBranch(mintHost)] : [supersededBranch(mintHost)]
        const keys = nodes.map(node => deriveLegacyNoteSecretKey(node.privateKey, node.chainCode, purpose, index))
        const key = fields.p === undefined ? keys[0]! : keys.find(k => encodeCp1(hexToBytes(getPublicKey(k))) === fields.p)
        if (!key) {
          return {result: JSON.stringify({ok: false, error: 'bad_request', message: 'that note is paid to a key this device does not hold'})}
        }
        const p = encodeCp1(hexToBytes(getPublicKey(key)))
        const existing = notes.find(n => n.p === p)
        if (existing) return ok({id: existing.id, created: false, p})
        const id = String(nextId++).padStart(8, '0')
        const certificate = firmware === 'purposes' ? (fields.c ?? fields.sig) : fields.sig
        claims.push(fields)
        notes.push({
          id,
          key,
          state: 'confirmed',
          amount_msat: Number(fields.amount_msat),
          host,
          label: '',
          p,
          index,
          ...(typeof certificate === 'string' ? {sig: certificate} : {})
        })
        return ok({id, created: true, p})
      }
      case 'heartwood_note_list':
        return ok({total: notes.length, offset: 0, notes: notes.map(({key: _key, ...meta}) => meta)})
      case 'heartwood_note_export': {
        const n = notes.find(note => note.id === fields.id)
        if (!n || n.state !== 'confirmed') return {error: 'invalid_state'}
        // a ck1 bound to the note's mint, or before beta.24 the 65-byte
        // ECDSA shape
        if (firmware === 'prePurpose') return ok({k1: legacyEcdsaCk1(n.key)})
        const signed = signNoteOwnership(n.key, n.host.split('/')[0]!)
        return ok({k1: encodeCk1(signed.pubkeyXOnly, signed.signature)})
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
    claims,
    pubkey,
    // What the owner wrote down for this master: it is a bunker master, so
    // its nsec.
    nsec: nip19.nsecEncode(secret),
    branchFor,
    answerAs(other: string) {
      answerAs = other
    },
    firmware(version: typeof firmware) {
      firmware = version
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

const setUp = async () => {
  const theMint = await startMint()
  const device = fakeHeartwood('wss://device.test')
  // What moneyer's POST /names was sent, as the NIP-98 request committed to
  // it, and the forms LUD-26's DELETE carried.
  const bodies: Array<{name: string; cx1: string | null; sig?: string}> = []
  const deletes: Array<{name: string; sig: string}> = []
  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url)
    // a signed request, not the unsigned look at whether the route exists
    if (url.pathname === '/names' && init?.method === 'POST' && new Headers(init.headers).has('authorization')) {
      bodies.push(JSON.parse(String(init.body)))
    }
    const address = url.pathname.match(/^\/\.well-known\/lnurlp\/([^/]+)$/)
    if (address && init?.method === 'DELETE') {
      deletes.push({name: address[1]!, sig: new URLSearchParams(String(init.body ?? '')).get('sig') ?? ''})
    }
    return fetch(input, init)
  }
  const {wallet} = makeWallet({fetch: fetchImpl})
  await wallet.addMint(`mint@${theMint.host}`)
  await wallet.linkHeartwood(device.transport, device.uri)
  theMint.moneyer.store.putOperatorZapName('donkey', device.pubkey)
  return {theMint, device, wallet, bodies, deletes}
}

// The device's whole branch at the mint, as a name registered before
// LUD-26 has it on file: heartwood firmware still hands out nothing else.
const deviceCx1 = (theMint: Mint, device: ReturnType<typeof fakeHeartwood>): string =>
  encodeLegacyCx1(cashNodeToCx1(device.branchFor(theMint.host)))
const onDeviceBranch = (theMint: Mint, device: ReturnType<typeof fakeHeartwood>): string => {
  const cx1 = deviceCx1(theMint, device)
  theMint.moneyer.store.setZapNameCx1('donkey', cx1)
  return cx1
}

// What moneyer checks of a whole branch's proof: by the branch's index-0
// key (or its own), over the domain-bound digest.
const provenBy = (cx1: string, action: string, name: string, domain: string, sig: string): boolean => {
  const branch = decodeLegacyCx1(cx1)!
  const pk0 = deriveLegacyNotePubkey(branch.pubkeyXOnly, branch.chainCode, LEGACY_NOTE_PURPOSE_WALLET, 0)
  return schnorr.verify(hexToBytes(sig), sha256(utf8ToBytes(`LNURLcash:${action}:${domain}:${name}`)), pk0)
}

describe("a name a heartwood's key owns, paid to the heartwood's keys", () => {
  it('refuses to register a name to the device\'s keys until its firmware hands out a LUD-26 share', async () => {
    const {theMint, device, wallet, bodies} = await setUp()
    await expect(wallet.heartwoodNameToKeys(device.transport, 'donkey')).rejects.toThrow(/LUD-26 share/)
    // nothing was asked of the device, and nothing of the mint
    expect(device.log).toEqual(['connect'])
    expect(bodies).toEqual([])
    expect(theMint.moneyer.store.zapName('donkey')?.cx1 ?? null).toBeNull()
  })

  it("takes a name off the device's branch, on the branch's proof and a request the device signs", async () => {
    const {theMint, device, wallet, bodies} = await setUp()
    const cx1 = onDeviceBranch(theMint, device)
    const back = await wallet.heartwoodNameToKeys(device.transport, 'donkey', {toKeys: false})
    expect(back).toEqual({address: `donkey@${theMint.host}`, toKeys: false})
    expect(theMint.moneyer.store.zapName('donkey')?.cx1).toBeNull()
    // The wallet's own key signed nothing: the device gave the proof, then
    // signed the request that carries it, in the body it commits to.
    expect(device.log).toEqual(['connect', 'heartwood_note_address', 'heartwood_note_address_proof', 'sign_event'])
    expect(bodies[0]).toMatchObject({name: 'donkey', cx1: null})
    expect(provenBy(cx1, 'unregister', 'donkey', '127.0.0.1', bodies[0]!.sig!)).toBe(true)
  })

  it("releases a name on the device's branch with LUD-26's DELETE, proven on the device", async () => {
    const {theMint, device, wallet, deletes} = await setUp()
    const cx1 = onDeviceBranch(theMint, device)
    await expect(wallet.heartwoodUnregisterName(device.transport, 'donkey')).resolves.toEqual({address: `donkey@${theMint.host}`})
    expect(deletes).toHaveLength(1)
    expect(provenBy(cx1, 'unregister', 'donkey', '127.0.0.1', deletes[0]!.sig)).toBe(true)
    // one hold for the proof, and nothing else signed
    expect(device.log).toEqual(['connect', 'heartwood_note_address', 'heartwood_note_address_proof'])
    // a moneyer name stays its Nostr key's, paying gift-wrapped notes again
    expect(theMint.moneyer.store.zapName('donkey')).toMatchObject({cx1: null, pubkey: device.pubkey})
  })

  it('tells the owner to update heartwood when the firmware does not know the proof method', async () => {
    const {theMint, device, wallet, bodies, deletes} = await setUp()
    onDeviceBranch(theMint, device)
    device.proofMode('unknown')
    await expect(wallet.heartwoodUnregisterName(device.transport, 'donkey')).rejects.toThrow('update heartwood to release this name')
    expect(deletes).toEqual([])
    await expect(wallet.heartwoodNameToKeys(device.transport, 'donkey', {toKeys: false})).rejects.toThrow('update heartwood')
    expect(device.log).not.toContain('sign_event')
    expect(bodies).toEqual([])
  })

  it('refuses a proof for another branch, and sends nothing', async () => {
    const {theMint, device, wallet, deletes} = await setUp()
    onDeviceBranch(theMint, device)
    device.proofMode('wrongBranch')
    await expect(wallet.heartwoodUnregisterName(device.transport, 'donkey')).rejects.toThrow('different branch')
    expect(deletes).toEqual([])
  })

  it('refuses a proof that does not verify for this mint, and sends nothing', async () => {
    const {theMint, device, wallet, bodies} = await setUp()
    const cx1 = onDeviceBranch(theMint, device)
    device.proofMode('wrongDomain')
    await expect(wallet.heartwoodNameToKeys(device.transport, 'donkey', {toKeys: false})).rejects.toThrow('does not verify')
    expect(device.log).not.toContain('sign_event')
    expect(bodies).toEqual([])
    expect(theMint.moneyer.store.zapName('donkey')?.cx1).toBe(cx1)
  })

  it('finds a payment the device never saw a wrap for, has the device keep it, and collects it', async () => {
    const {theMint, device, wallet} = await setUp()
    onDeviceBranch(theMint, device)
    await pay(theMint, 'donkey', 21_000)

    const scan = await wallet.heartwoodScanAddress(device.transport, theMint.host, {gap: 3})
    expect(scan.claimed).toEqual([{id: device.notes[0]!.id, index: 0, amountMsat: 21_000}])
    expect(scan.waiting).toEqual([])
    // purpose 2 and the ladder before purposes, a gap of 3 on each, and the
    // key paid on one of them
    expect(scan.scanned).toBe(1 + 3 + 3)
    const kept = device.notes[0]!
    expect(kept.host).toBe(`${theMint.host}/w`)
    expect(isCs1WithAmount(kept.sig!)).toBe(true)
    // the claim names its purpose and carries the certificate as LUD-25's c
    expect(device.claims[0]).toMatchObject({purpose: LEGACY_NOTE_PURPOSE_LIGHTNING_ADDRESS, c: kept.sig})
    expect(device.claims[0]).not.toHaveProperty('sig')

    // A scan puts a note ON the device, so the inventory it leaves behind
    // has to include it - by its index on the branch, never its ck1.
    expect(wallet.heartwoodInventory()!.notes).toEqual([
      {id: kept.id, amountMsat: 21_000, host: `${theMint.host}/w`, state: 'confirmed', index: 0}
    ])
    expect(wallet.heartwoodHeld()).toMatchObject({msat: 21_000, notes: 1})
    expect(JSON.stringify(wallet.heartwoodInventory()!.notes)).not.toContain(bytesToHex(kept.key))

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
    onDeviceBranch(theMint, device)
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

  it('reports what older firmware cannot claim as waiting at the mint, where the nsec reaches it', async () => {
    const {theMint, device, wallet} = await setUp()
    device.firmware('prePurpose')
    onDeviceBranch(theMint, device)
    await pay(theMint, 'donkey', 21_000)

    const scan = await wallet.heartwoodScanAddress(device.transport, theMint.host, {gap: 3})
    expect(scan.claimed).toEqual([])
    expect(scan.waiting).toEqual([{index: 0, amountMsat: 21_000}])
    expect(device.notes).toEqual([])
    const stats = (await (await fetch(`${theMint.moneyer.url}/stats`)).json()) as {outstandingNotes: number}
    expect(stats.outstandingNotes).toBe(1)

    const {wallet: rescuer} = makeWallet()
    await rescuer.addMint(`mint@${theMint.host}`)
    const result = await rescuer.recoverHeartwoodNotes(device.nsec, {expectedPubkey: device.pubkey, mintHost: theMint.host, gap: 3})
    expect(result.received.map(r => r.note.amountMsat)).toEqual([21_000])
  })

  // A name registered before 0.18.0-beta.24 still points at the superseded
  // m/139'/1' branch, and moneyer pays it there on purpose 2. The updated
  // device hands out its new branch, and no mint publishes a name's cx1 any
  // more, so the scan cannot find it: the device's nsec does.
  it('finds what a name still on the superseded branch is paid from the nsec, once the device has moved on', async () => {
    const {theMint, device, wallet} = await setUp()
    device.firmware('prePurpose')
    onDeviceBranch(theMint, device)
    await pay(theMint, 'donkey', 21_000)

    device.firmware('purposes')
    const blind = await wallet.heartwoodScanAddress(device.transport, theMint.host, {gap: 3})
    expect(blind.claimed).toEqual([])
    expect(blind.waiting).toEqual([])

    const {wallet: rescuer} = makeWallet()
    await rescuer.addMint(`mint@${theMint.host}`)
    const result = await rescuer.recoverHeartwoodNotes(device.nsec, {expectedPubkey: device.pubkey, mintHost: theMint.host, gap: 3})
    expect(result.received.map(r => r.note.amountMsat)).toEqual([21_000])
  })

  // Firmware before beta.24 exports a key note as the 65-byte ECDSA ck1,
  // which kit 0.20 no longer reads. Collecting must leave such a note on the
  // device, not write it off as already taken, so updated firmware can
  // release it in a shape this wallet reads.
  it('leaves a note older firmware releases in an unreadable shape on the device, and collects it once updated', async () => {
    const {theMint, device, wallet} = await setUp()
    device.firmware('prePurpose')
    // a note on the ladder from before purposes, which older firmware claims
    const {pubkeyXOnly, chainCode} = cashNodeToCx1(device.branchFor(theMint.host))
    const q = deriveLegacyNotePubkey(pubkeyXOnly, chainCode, null, 0)
    theMint.moneyer.store.creditNote(bytesToHex(q), 21_000)
    const scan = await wallet.heartwoodScanAddress(device.transport, theMint.host, {gap: 3})
    expect(scan.claimed.map(c => c.amountMsat)).toEqual([21_000])

    const stuck = await wallet.collectFromHeartwood(device.transport)
    expect(stuck.collected).toEqual([])
    expect(stuck.failed).toEqual([{id: device.notes[0]!.id, reason: expect.stringContaining('update the firmware')}])
    expect(device.notes[0]!.state).toBe('confirmed')
    expect(device.log).not.toContain('heartwood_note_spent')
    expect(wallet.balanceMsat()).toBe(0)

    device.firmware('purposes')
    const collected = await wallet.collectFromHeartwood(device.transport)
    expect(collected.failed).toEqual([])
    expect(collected.collected.map(r => r.note.amountMsat)).toEqual([21_000])
    expect(device.notes[0]!.state).toBe('spent')
    expect(wallet.balanceMsat()).toBe(21_000)
  })

  it("recovers a lost heartwood's notes from its nsec, into a wallet that never saw it", async () => {
    const {theMint, device, wallet} = await setUp()
    onDeviceBranch(theMint, device)
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
    // the spec's branch first, which this firmware hands out and was paid
    // on, then the superseded m/139'/1' one, each on the Lightning Address
    // purpose and on the ladder from before purposes: four gaps, and the two
    // keys paid
    expect(result.scanned).toBe(2 + 3 * 4)
    expect(rescuer.balanceMsat()).toBe(26_000)
    // taken, so a second recovery finds the keys spent and takes nothing
    expect((await rescuer.recoverHeartwoodNotes(device.nsec, opts)).received).toEqual([])
  })

  it('refuses a branch the device says belongs to another identity, before anything is signed', async () => {
    const {theMint, device, wallet} = await setUp()
    device.answerAs(getPublicKey(generateSecretKey()))
    await expect(wallet.heartwoodNameToKeys(device.transport, 'donkey', {toKeys: false})).rejects.toThrow('not the linked')
    expect(device.log).not.toContain('sign_event')
    expect(theMint.moneyer.store.zapName('donkey')?.cx1 ?? null).toBeNull()
  })

  it("cannot move a name the device's key does not own", async () => {
    const {theMint, device, wallet} = await setUp()
    theMint.moneyer.store.putOperatorZapName('mule', getPublicKey(generateSecretKey()))
    await expect(wallet.heartwoodNameToKeys(device.transport, 'mule', {toKeys: false})).rejects.toThrow('taken')
    expect(theMint.moneyer.store.zapName('mule')?.cx1 ?? null).toBeNull()
  })
})
