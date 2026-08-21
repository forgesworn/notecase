import {afterEach, describe, expect, it} from 'vitest'
import {createMockMint} from 'lnurlcash-conformance/mock-mint'
import {finalizeEvent, generateSecretKey, getPublicKey, matchFilter, type Event, type Filter} from 'nostr-tools'
import {nip44} from 'nostr-tools'
import {bytesToHex} from '@noble/hashes/utils.js'
import {Wallet} from '../src/wallet.ts'
import {HeartwoodError, NIP46_KIND, parseBunkerUri} from '../src/heartwood.ts'
import {GIFT_WRAP_KIND, identityFromSecret, newIdentitySecretHex, unwrapNote, wrapNote, type NostrTransport} from '../src/nostr.ts'
import {freshK1, makeWallet} from './helpers.ts'

// A heartwood that lives on the relay: it answers heartwood_note_* the way
// the firmware's note_cmd does, from an in-memory locker, and "presses the
// button" instantly. The wallet under test cannot tell the difference.

type Mint = Awaited<ReturnType<typeof createMockMint>>
let mint: Mint | null = null
afterEach(async () => {
  await mint?.close()
  mint = null
})

type Locker = {id: string; k1: string; state: string; amount_msat: number; host: string; from?: string; sent_to?: string}

const fakeDevice = (relay: string) => {
  const secret = generateSecretKey()
  const pubkey = getPublicKey(secret)
  const deviceId = identityFromSecret(bytesToHex(secret))
  const notes: Locker[] = []
  const bound = new Set<string>()
  const pairingSecret = 'pairingsecret'
  const stored: Event[] = []
  const log: string[] = []

  const answer = (to: string, id: string, body: {result?: unknown; error?: string}): Event =>
    finalizeEvent(
      {kind: NIP46_KIND, created_at: Math.floor(Date.now() / 1000), tags: [['p', to]], content: nip44.encrypt(JSON.stringify({id, ...body}), nip44.getConversationKey(secret, to))},
      secret
    )

  const noteCmd = (client: string, method: string, fields: Record<string, unknown>): unknown => {
    if (!bound.has(client)) return {error: 'unauthorised'}
    const find = () => notes.find(n => n.id === fields.id)
    switch (method) {
      case 'heartwood_note_list':
        return {result: JSON.stringify({ok: true, total: notes.length, offset: 0, notes: notes.map(({k1: _k1, ...rest}) => rest)})}
      case 'heartwood_note_export': {
        const n = find()
        if (!n) return {error: 'not_found'}
        if (n.state !== 'confirmed') return {error: 'invalid_state'}
        return {result: JSON.stringify({ok: true, k1: n.k1})}
      }
      case 'heartwood_note_spent': {
        const n = find()
        if (!n) return {error: 'not_found'}
        if (n.state !== 'confirmed') return {error: 'invalid_state'}
        n.state = 'spent'
        return {result: JSON.stringify({ok: true})}
      }
      case 'heartwood_note_send': {
        const n = find()
        if (!n) return {error: 'not_found'}
        if (n.state !== 'confirmed' || n.from || n.sent_to) return {error: 'invalid_state'}
        const url = `https://${n.host}?k1=${n.k1}&amount=${n.amount_msat}`
        const wrap = wrapNote(url, n.amount_msat, String(fields.to), deviceId)
        n.sent_to = String(fields.to)
        return {result: JSON.stringify({ok: true, event: wrap})}
      }
      default:
        return {error: 'unknown method'}
    }
  }

  // Live subscribers, so the fake behaves like a real relay for ephemeral
  // kinds: a NIP-46 reply reaches whoever is listening when it is pushed.
  const subs: {filter: Filter; onEvent: (e: Event) => void}[] = []
  const emit = (event: Event) => {
    // Kind 24133 is in the ephemeral range, so a real relay does NOT keep
    // it: it reaches live subscribers and is then gone. Not storing it here
    // is what makes this suite able to catch a client that publishes and
    // then asks for history.
    for (const sub of subs) if (matchFilter(sub.filter, event)) sub.onEvent(event)
  }

  const transport: NostrTransport = {
    async query(_relays, filter: Filter) {
      return stored.filter(e => matchFilter(filter, e))
    },
    subscribe(_relays, filter, onEvent) {
      const sub = {filter, onEvent}
      subs.push(sub)
      return {
        close() {
          const i = subs.indexOf(sub)
          if (i >= 0) subs.splice(i, 1)
        }
      }
    },
    async publish(relays, event) {
      if (!relays.includes(relay)) return {ok: [], failed: relays}
      stored.push(event)
      if (event.kind === NIP46_KIND && event.tags.some(t => t[0] === 'p' && t[1] === pubkey)) {
        const ck = nip44.getConversationKey(secret, event.pubkey)
        const req = JSON.parse(nip44.decrypt(event.content, ck)) as {id: string; method: string; params: unknown[]}
        log.push(req.method)
        if (req.method === 'connect') {
          if (req.params[1] === pairingSecret) {
            bound.add(event.pubkey)
            emit(answer(event.pubkey, req.id, {result: 'ack'}))
          } else {
            emit(answer(event.pubkey, req.id, {error: 'secret mismatch'}))
          }
        } else {
          emit(answer(event.pubkey, req.id, noteCmd(event.pubkey, req.method, (req.params[0] ?? {}) as Record<string, unknown>) as {result?: unknown; error?: string}))
        }
      }
      return {ok: relays, failed: []}
    },
    close() {}
  }
  return {
    transport,
    notes,
    log,
    stored,
    pubkey,
    uri: `bunker://${pubkey}?relay=${encodeURIComponent(relay)}&secret=${pairingSecret}`
  }
}

describe('bunker URIs', () => {
  it('parses relays and secret, and refuses the rest', () => {
    const pk = 'ab'.repeat(32)
    const parsed = parseBunkerUri(`bunker://${pk}?relay=wss%3A%2F%2Fr.example&relay=wss://s.example&secret=abc`)
    expect(parsed.devicePubkey).toBe(pk)
    expect(parsed.relays).toEqual(['wss://r.example', 'wss://s.example'])
    expect(parsed.secret).toBe('abc')
    expect(() => parseBunkerUri(`bunker://${pk}`)).toThrow('no relay')
    expect(() => parseBunkerUri('nostrconnect://xyz')).toThrow(HeartwoodError)
  })
})

describe('a linked heartwood', () => {
  it('pairs once, lists, collects what arrived by wrap, and marks it spent on the device', async () => {
    mint = await createMockMint({})
    const device = fakeDevice('wss://dev.example')
    const {wallet, data} = makeWallet()
    await wallet.linkHeartwood(device.transport, device.uri)
    expect(data.settings.heartwood?.devicePubkey).toBe(device.pubkey)
    // The pairing secret is not kept.
    expect(data.settings.heartwood?.uri).not.toContain('secret')
    expect(device.log).toEqual(['connect'])

    const k1 = freshK1()
    mint.state.creditNote(k1, 9_000)
    const host = `${new URL(mint.url).host}/w`
    device.notes.push({id: 'aaaa1111', k1, state: 'confirmed', amount_msat: 9_000, host, from: 'cc'.repeat(32)})
    device.notes.push({id: 'bbbb2222', k1: freshK1(), state: 'confirmed', amount_msat: 1_000, host})

    const listed = await wallet.heartwoodNotes(device.transport)
    expect(listed.map(n => n.id)).toEqual(['aaaa1111', 'bbbb2222'])
    expect(JSON.stringify(listed)).not.toContain(k1)

    const steps: string[] = []
    const result = await wallet.collectFromHeartwood(device.transport, s => steps.push(s))
    expect(result.failed).toEqual([])
    expect(result.collected).toHaveLength(1)
    expect(result.collected[0]!.note.amountMsat).toBe(9_000)
    expect(result.collected[0]!.note.receivedFrom).toBe('cc'.repeat(32))
    expect(result.collected[0]!.note.k1).not.toBe(k1)
    expect(mint.state.noteState(k1)).toBe('burned')
    expect(device.notes[0]!.state).toBe('spent')
    // The device's own minted note was left alone.
    expect(device.notes[1]!.state).toBe('confirmed')
    expect(steps).toHaveLength(2)
    expect(wallet.balanceMsat()).toBe(9_000)
  })

  it('asks the device to seal its own note to an npub and relays the wrap', async () => {
    const device = fakeDevice('wss://dev.example')
    const {wallet} = makeWallet()
    await wallet.setNostrRelays(['wss://dev.example'])
    await wallet.linkHeartwood(device.transport, device.uri)
    const bob = identityFromSecret(newIdentitySecretHex())
    device.notes.push({id: 'cccc3333', k1: freshK1(), state: 'confirmed', amount_msat: 4_000, host: 'mint.example/w'})

    const sent = await wallet.heartwoodSend(device.transport, 'cccc3333', bob.npub)
    expect(sent.inboxKnown).toBe(false)
    expect(sent.relays).toEqual(['wss://dev.example'])
    const wrap = device.stored.find(e => e.kind === GIFT_WRAP_KIND)!
    expect(wrap.id).toBe(sent.wrapId)
    const opened = unwrapNote(wrap, bob)
    expect(opened.sender).toBe(device.pubkey)
    expect(opened.note.amountMsat).toBe(4_000)
    expect(device.notes[0]!.sent_to).toBe(bob.pubkey)
    // Once only.
    await expect(wallet.heartwoodSend(device.transport, 'cccc3333', bob.npub)).rejects.toThrow('invalid_state')
  })

  it('refuses to link on a wrong pairing secret and does not store the link', async () => {
    const device = fakeDevice('wss://dev.example')
    const {wallet, data} = makeWallet()
    await expect(wallet.linkHeartwood(device.transport, device.uri.replace('pairingsecret', 'nope'))).rejects.toThrow('secret mismatch')
    expect(data.settings.heartwood).toBeUndefined()
    await expect(wallet.heartwoodNotes(device.transport)).rejects.toThrow('No heartwood is linked')
  })
})
