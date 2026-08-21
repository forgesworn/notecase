import {finalizeEvent, generateSecretKey, getPublicKey, verifyEvent, type Event} from 'nostr-tools'
import {nip44} from 'nostr-tools'
import {bytesToHex, hexToBytes, randomBytes} from '@noble/hashes/utils.js'
import {INBOX_RELAYS_KIND, type NostrTransport} from './nostr.ts'

// A heartwood signer as a note locker, reached over NIP-46. The device holds
// its own bearer notes behind a button; this is the client side of the
// heartwood_note_* extensions: list what it holds, collect what arrived by
// gift wrap (export, claim here, mark spent there), and ask it to seal a
// note to an npub so the secret never crosses to this machine at all.
//
// Every call is a request event to the device and a poll for its answer.
// Polling rather than a standing subscription: a hold on the device takes
// as long as the owner takes, and a subscription that quietly dies at the
// minute mark loses exactly the answer that matters.

export const NIP46_KIND = 24133

export type HeartwoodLink = {
  uri: string
  devicePubkey: string
  relays: string[]
  clientSecretHex: string
}

export type DeviceNote = {
  id: string
  state: 'pending' | 'confirmed' | 'spent'
  amount_msat: number
  host: string
  label: string
  from?: string
  sent_to?: string
}

export class HeartwoodError extends Error {}

export const parseBunkerUri = (uri: string): {devicePubkey: string; relays: string[]; secret: string} => {
  const trimmed = uri.trim()
  const match = trimmed.match(/^bunker:\/\/([0-9a-f]{64})\??(.*)$/i)
  if (!match) throw new HeartwoodError('That is not a bunker:// URI.')
  const params = new URLSearchParams(match[2] ?? '')
  const relays = params.getAll('relay').filter(r => /^wss?:\/\//.test(r))
  if (!relays.length) throw new HeartwoodError('The bunker URI names no relay.')
  return {devicePubkey: match[1]!.toLowerCase(), relays, secret: params.get('secret') ?? ''}
}

const POLL_MS = 1_500
// A gated method waits for a hand: the device window is 30 s plus a 2 s
// hold, and a queued card can wait behind another.
export const GATED_TIMEOUT_MS = 75_000
export const PLAIN_TIMEOUT_MS = 15_000

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

export class HeartwoodClient {
  private readonly secret: Uint8Array
  readonly clientPubkey: string
  private readonly conversationKey: Uint8Array
  private readonly transport: NostrTransport
  readonly link: HeartwoodLink
  private readonly now: () => number

  constructor(transport: NostrTransport, link: HeartwoodLink, now: () => number = () => Date.now()) {
    this.transport = transport
    this.link = link
    this.now = now
    this.secret = hexToBytes(link.clientSecretHex)
    this.clientPubkey = getPublicKey(this.secret)
    this.conversationKey = nip44.getConversationKey(this.secret, link.devicePubkey)
  }

  async rpc<T = unknown>(method: string, params: unknown[], timeoutMs = PLAIN_TIMEOUT_MS): Promise<T> {
    const id = bytesToHex(randomBytes(8))
    const createdAt = Math.floor(this.now() / 1000)
    const request = finalizeEvent(
      {
        kind: NIP46_KIND,
        created_at: createdAt,
        tags: [['p', this.link.devicePubkey]],
        content: nip44.encrypt(JSON.stringify({id, method, params}), this.conversationKey)
      },
      this.secret
    )
    // NIP-46 replies are kind 24133, which is in the ephemeral range: relays
    // do not store them, so asking for history after publishing is a race
    // the device usually loses - it answers in about 100 ms, and a stored-
    // event query returns nothing at all. Subscribe BEFORE publishing and
    // take the reply live.
    let answer: {id: string; result?: unknown; error?: unknown} | null = null
    const sub = this.transport.subscribe(
      this.link.relays,
      {
        kinds: [NIP46_KIND],
        authors: [this.link.devicePubkey],
        '#p': [this.clientPubkey],
        since: createdAt - 5
      },
      event => {
        if (answer) return
        const inner = this.open(event)
        if (inner && inner.id === id) answer = inner
      }
    )
    try {
      const published = await this.transport.publish(this.link.relays, request)
      if (!published.ok.length) {
        throw new HeartwoodError(`No relay took the request (${published.failed.join(', ')}).`)
      }
      const deadline = this.now() + timeoutMs
      while (this.now() < deadline) {
        if (answer) {
          const inner = answer as {id: string; result?: unknown; error?: unknown}
          if (inner.error !== undefined) throw new HeartwoodError(String(inner.error))
          return inner.result as T
        }
        await sleep(POLL_MS)
      }
    } finally {
      sub.close()
    }
    throw new HeartwoodError(`The device did not answer ${method} in time.`)
  }

  private open(event: Event): {id: string; result?: unknown; error?: unknown} | null {
    try {
      return JSON.parse(nip44.decrypt(event.content, this.conversationKey))
    } catch {
      return null
    }
  }

  // The note methods answer with the locker's own JSON inside the NIP-46
  // result string. `ok:false` is an error whichever layer raised it.
  async note<T extends Record<string, unknown>>(method: string, fields: Record<string, unknown>, gated = false): Promise<T> {
    const raw = await this.rpc<string>(method, [fields], gated ? GATED_TIMEOUT_MS : PLAIN_TIMEOUT_MS)
    const parsed = (typeof raw === 'string' ? JSON.parse(raw) : raw) as T & {ok?: boolean; error?: string; message?: string}
    if (parsed.ok === false) throw new HeartwoodError(parsed.message ?? parsed.error ?? 'the locker refused')
    return parsed
  }

  async connect(secret: string): Promise<void> {
    const result = await this.rpc<string>('connect', [this.link.devicePubkey, secret])
    if (result !== 'ack' && result !== secret) throw new HeartwoodError(`Unexpected connect reply: ${String(result)}`)
  }

  async listNotes(): Promise<DeviceNote[]> {
    const out: DeviceNote[] = []
    let offset = 0
    for (;;) {
      const page = await this.note<{notes: DeviceNote[]; next_offset?: number}>('heartwood_note_list', {offset, limit: 8})
      out.push(...page.notes)
      if (page.next_offset === undefined) return out
      offset = page.next_offset
    }
  }

  // Hand a note's secret over. The device puts a RELEASE card up.
  async exportSecret(id: string): Promise<string> {
    const res = await this.note<{k1: string}>('heartwood_note_export', {id}, true)
    return res.k1
  }

  async markSpent(id: string): Promise<void> {
    await this.note('heartwood_note_spent', {id}, true)
  }

  // Seal a note to `recipientHex` on the device. What comes back is the
  // kind 1059 to relay; this machine never sees the secret.
  async sendNote(id: string, recipientHex: string): Promise<Event> {
    const res = await this.note<{event: Event}>('heartwood_note_send', {id, to: recipientHex}, true)
    return res.event
  }

  // Plain NIP-46 sign_event, as the device's own identity. Gated unless
  // the device's policy for this client allows the kind.
  async signEvent(unsigned: {kind: number; created_at: number; tags: string[][]; content: string}): Promise<Event> {
    const raw = await this.rpc<string>('sign_event', [JSON.stringify({...unsigned, pubkey: this.link.devicePubkey})], GATED_TIMEOUT_MS)
    const event = (typeof raw === 'string' ? JSON.parse(raw) : raw) as Event
    if (event.pubkey !== this.link.devicePubkey || !verifyEvent(event)) {
      throw new HeartwoodError('The device returned an event it did not sign.')
    }
    return event
  }

  // Where the device listens, as a kind 10050 in its own name: the relays
  // from the bunker URI, which are exactly the ones its gift-wrap
  // subscription is on. Without this a sender who resolves the device's
  // npub has nowhere to leave a note. Published to the device's relays and
  // wherever else the caller says (the indexers, typically).
  async publishInbox(alsoOn: string[] = []): Promise<{event: Event; ok: string[]; failed: string[]}> {
    const event = await this.signEvent({
      kind: INBOX_RELAYS_KIND,
      created_at: Math.floor(this.now() / 1000),
      tags: this.link.relays.map(r => ['relay', r]),
      content: ''
    })
    const result = await this.transport.publish([...new Set([...this.link.relays, ...alsoOn])], event)
    return {event, ok: result.ok, failed: result.failed}
  }
}

export const newHeartwoodLink = (uri: string): {link: HeartwoodLink; secret: string} => {
  const parsed = parseBunkerUri(uri)
  const clientSecretHex = bytesToHex(generateSecretKey())
  // The secret is a pairing token, used once at connect and never stored.
  const bare = `bunker://${parsed.devicePubkey}?${parsed.relays.map(r => `relay=${encodeURIComponent(r)}`).join('&')}`
  return {link: {uri: bare, devicePubkey: parsed.devicePubkey, relays: parsed.relays, clientSecretHex}, secret: parsed.secret}
}
