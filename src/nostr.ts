import {SimplePool, finalizeEvent, generateSecretKey, getEventHash, getPublicKey, verifyEvent, type Event, type Filter, type UnsignedEvent} from 'nostr-tools'
import {nip19, nip44, nip59} from 'nostr-tools'
import {bytesToHex, hexToBytes, utf8ToBytes} from '@noble/hashes/utils.js'
import {sha256} from '@noble/hashes/sha2.js'
import {resolveNoteInput, noteK1, noteDeclaredAmount} from 'lnurlcash-kit'

// Bearer notes over Nostr. A note is one string - the LUD-25 URL - so it
// travels as the content of a NIP-59 rumor, sealed to the recipient's
// pubkey. The wrap sits on their inbox relays until they open it, which
// means the recipient need not have a wallet yet; Lightning cannot do
// that. The price is that the wrap is a permanent copy of the secret under
// the recipient's key, so whoever opens it must rotate at once - and this
// wallet's receive() already does.
//
// The rumor kind and tags match heartwood-esp32's note_wrap.rs: the same
// wrap opens on the signer or here.

export const NOTE_KIND = 2525
export const GIFT_WRAP_KIND = 1059
export const SEAL_KIND = 13
export const INBOX_RELAYS_KIND = 10050

// Where a recipient's kind 10050 is looked for when we know nothing else.
export const BOOTSTRAP_RELAYS = ['wss://purplepag.es', 'wss://relay.damus.io', 'wss://nos.lol']

// Wraps are backdated up to two days (NIP-59), so an inbox query has to
// look that far behind the last check to see everything.
const WRAP_BACKDATE_SECS = 2 * 24 * 60 * 60 + 3600

// The bit of a relay pool this module needs, so tests run on a fake.
export type NostrTransport = {
  query(relays: string[], filter: Filter): Promise<Event[]>
  // A live subscription, for kinds relays do not store. `query` asks for
  // history; this catches what arrives while it is open.
  subscribe(relays: string[], filter: Filter, onEvent: (event: Event) => void): {close(): void}
  publish(relays: string[], event: Event): Promise<{ok: string[]; failed: string[]}>
  close(): void
}

export const poolTransport = (): NostrTransport => {
  const pool = new SimplePool()
  return {
    query: (relays, filter) => pool.querySync(relays, filter, {maxWait: 8_000}),
    subscribe: (relays, filter, onEvent) => pool.subscribe(relays, filter, {onevent: onEvent}),
    publish: async (relays, event) => {
      const ok: string[] = []
      const failed: string[] = []
      await Promise.all(
        pool.publish(relays, event).map((p, i) =>
          p.then(
            () => ok.push(relays[i]!),
            () => failed.push(relays[i]!)
          )
        )
      )
      return {ok, failed}
    },
    close: () => pool.destroy()
  }
}

export type NostrIdentity = {secret: Uint8Array; pubkey: string; npub: string}

export const identityFromSecret = (secretHex: string): NostrIdentity => {
  const secret = hexToBytes(secretHex)
  const pubkey = getPublicKey(secret)
  return {secret, pubkey, npub: nip19.npubEncode(pubkey)}
}

export const newIdentitySecretHex = (): string => bytesToHex(generateSecretKey())

// npub or 64-hex, to hex. Anything else is refused: a typo here sends
// money to a key nobody holds.
export const recipientPubkey = (input: string): string => {
  const trimmed = input.trim()
  if (/^[0-9a-f]{64}$/i.test(trimmed)) return trimmed.toLowerCase()
  if (trimmed.startsWith('npub1')) {
    const decoded = nip19.decode(trimmed)
    if (decoded.type === 'npub') return decoded.data
  }
  throw new Error('Give the recipient as an npub, a 64-hex pubkey, or a NIP-05 address.')
}

// A NIP-05 address looks like a Lightning one and resolves the same way, but
// it is a different well-known and a different answer: `name@host` maps to a
// pubkey via /.well-known/nostr.json. Worth supporting because telling
// someone to send money to a 63-character npub is a worse story than telling
// them an address - and an address can be moved to a new key later, which an
// npub written on a card cannot.
export const isNip05 = (input: string): boolean =>
  /^[a-z0-9._-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(input.trim())

export const resolveNip05 = async (
  address: string,
  fetchImpl: typeof fetch = fetch
): Promise<string> => {
  const [name, host] = address.trim().toLowerCase().split('@')
  if (!name || !host) throw new Error(`${address} is not a NIP-05 address.`)
  const url = `https://${host}/.well-known/nostr.json?name=${encodeURIComponent(name)}`
  let body: {names?: Record<string, string>}
  try {
    const res = await fetchImpl(url)
    if (!res.ok) throw new Error(`${host} answered ${res.status}`)
    body = (await res.json()) as {names?: Record<string, string>}
  } catch (err) {
    throw new Error(`Could not resolve ${address}: ${(err as Error).message}`)
  }
  const hex = body.names?.[name]
  if (!hex || !/^[0-9a-f]{64}$/i.test(hex)) {
    throw new Error(`${host} lists no key for ${name}.`)
  }
  return hex.toLowerCase()
}

// The one call a caller wants: npub, hex or NIP-05, whichever they were given.
export const resolveRecipient = async (
  input: string,
  fetchImpl: typeof fetch = fetch
): Promise<string> =>
  isNip05(input) ? resolveNip05(input, fetchImpl) : recipientPubkey(input)

export const npubOf = (pubkeyHex: string): string => nip19.npubEncode(pubkeyHex)

export const NIP98_KIND = 27235

const base64 = (text: string): string => {
  const bytes = utf8ToBytes(text)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

// A NIP-98 Authorization header: a signed statement that this key is
// making this request to this URL with this body, and made it just now.
// The mint reads the pubkey off it and needs no account of its own.
export const nip98Header = (identity: NostrIdentity, url: string, method: string, body?: string): string => {
  const tags: string[][] = [
    ['u', url],
    ['method', method.toUpperCase()]
  ]
  if (body !== undefined) tags.push(['payload', bytesToHex(sha256(utf8ToBytes(body)))])
  const event = finalizeEvent(
    {kind: NIP98_KIND, created_at: Math.floor(Date.now() / 1000), content: '', tags},
    identity.secret
  )
  return `Nostr ${base64(JSON.stringify(event))}`
}

// What a zap said, when a note was minted by one. The mint carries the
// payer's own kind 9734 alongside the note, so the wallet can show who
// sent it and what they wrote rather than "a note arrived".
export type ZapDetail = {senderPubkey: string; content: string; amountMsat: number}

const zapFromDescription = (tags: string[][]): ZapDetail | null => {
  const description = tags.find(tag => tag[0] === 'description')?.[1]
  if (!description) return null
  try {
    const request = JSON.parse(description) as Event
    // The payer signed this, not the mint. A mint that made one up would
    // have to forge a signature, and this is where that gets caught.
    if (request.kind !== 9734 || !verifyEvent(request)) return null
    const amount = Number(request.tags.find(tag => tag[0] === 'amount')?.[1])
    return {
      senderPubkey: request.pubkey,
      content: typeof request.content === 'string' ? request.content : '',
      amountMsat: Number.isSafeInteger(amount) && amount > 0 ? amount : 0
    }
  } catch {
    return null
  }
}

export type NoteRumor = {noteUrl: string; amountMsat: number; host: string}

const hostOf = (noteUrl: string): string => {
  const parsed = new URL(noteUrl)
  return `${parsed.host}${parsed.pathname === '/' ? '' : parsed.pathname}`
}

// `extras` carries what a send is FOR: the request it settles and a line
// of prose. Both are additive tags.
//
// Checked against the hardware signer before adding them: its rumor parser
// reads `content` and looks tags up by name, so a tag it does not know is
// a tag it never sees. Nothing needs gating on whether the recipient is a
// paired device.
export type NoteRumorExtras = {requestId?: string; memo?: string}

export const buildNoteRumor = (
  noteUrl: string,
  amountMsat: number,
  recipientHex: string,
  extras: NoteRumorExtras = {}
): Partial<UnsignedEvent> => ({
  kind: NOTE_KIND,
  content: noteUrl,
  tags: [
    ['p', recipientHex],
    ['amount', String(amountMsat)],
    ['u', hostOf(noteUrl)],
    ...(extras.requestId ? [['req', extras.requestId]] : []),
    ...(extras.memo ? [['memo', extras.memo]] : [])
  ]
})

export const wrapNote = (
  noteUrl: string,
  amountMsat: number,
  recipientHex: string,
  sender: NostrIdentity,
  extras: NoteRumorExtras = {}
): Event =>
  nip59.wrapEvent(buildNoteRumor(noteUrl, amountMsat, recipientHex, extras), sender.secret, recipientHex)

export class NotANoteWrapError extends Error {}

// The recipient's side, with the checks nostr-tools' unwrapEvent skips: the
// seal must verify, and the rumor must claim the seal's signer as author -
// otherwise anyone could forge "this came from X". Same gates as the
// signer's nip59::unwrap.
export const unwrapNote = (
  wrap: Event,
  recipient: NostrIdentity
): {
  note: NoteRumor
  sender: string
  rumorCreatedAt: number
  zap: ZapDetail | null
  memo?: string
  requestId?: string
} => {
  if (wrap.kind !== GIFT_WRAP_KIND) throw new NotANoteWrapError('not a gift wrap')
  if (!verifyEvent(wrap)) throw new NotANoteWrapError('wrap signature does not verify')
  const seal = JSON.parse(nip44.decrypt(wrap.content, nip44.getConversationKey(recipient.secret, wrap.pubkey))) as Event
  if (seal.kind !== SEAL_KIND || !verifyEvent(seal)) throw new NotANoteWrapError('inner event is not a valid seal')
  const rumor = JSON.parse(nip44.decrypt(seal.content, nip44.getConversationKey(recipient.secret, seal.pubkey))) as UnsignedEvent & {id: string}
  if (rumor.pubkey !== seal.pubkey) throw new NotANoteWrapError('rumor author is not the seal signer')
  if (rumor.id !== getEventHash(rumor)) throw new NotANoteWrapError('rumor id does not match its content')
  if (rumor.kind !== NOTE_KIND) throw new NotANoteWrapError(`kind ${rumor.kind} is not a bearer note`)
  const noteUrl = resolveNoteInput(rumor.content)
  if (!noteUrl || !noteK1(noteUrl)) throw new NotANoteWrapError('rumor content is not a note URL')
  const fromUrl = noteDeclaredAmount(noteUrl)
  const fromTag = Number(rumor.tags.find(t => t[0] === 'amount')?.[1])
  const amountMsat = fromUrl ?? (Number.isSafeInteger(fromTag) && fromTag > 0 ? fromTag : 0)
  // Somebody else's words and somebody else's id. Bounded on the way in:
  // a memo is shown to a person, and a request id is matched against this
  // wallet's own records, so neither is worth carrying at any length.
  const memo = rumor.tags.find(t => t[0] === 'memo')?.[1]
  const requestId = rumor.tags.find(t => t[0] === 'req')?.[1]
  return {
    note: {noteUrl, amountMsat, host: hostOf(noteUrl)},
    sender: seal.pubkey,
    rumorCreatedAt: rumor.created_at,
    zap: zapFromDescription(rumor.tags),
    ...(typeof memo === 'string' && memo.length > 0 ? {memo: memo.slice(0, 280)} : {}),
    ...(typeof requestId === 'string' && /^[0-9a-f]{16}$/i.test(requestId)
      ? {requestId: requestId.toLowerCase()}
      : {})
  }
}

// A pubkey's NIP-17 inbox relays. Empty when none are published: the
// caller decides whether to fall back to its own relays (and say so).
export const inboxRelays = async (transport: NostrTransport, pubkeyHex: string, lookOn: string[]): Promise<string[]> => {
  const events = await transport.query(lookOn, {kinds: [INBOX_RELAYS_KIND], authors: [pubkeyHex], limit: 3})
  const latest = events.sort((a, b) => b.created_at - a.created_at)[0]
  if (!latest) return []
  return [...new Set(latest.tags.filter(t => t[0] === 'relay' && t[1]).map(t => t[1]!))]
}

export const inboxRelayListEvent = (identity: NostrIdentity, relays: string[]): Event =>
  finalizeEvent(
    {
      kind: INBOX_RELAYS_KIND,
      created_at: Math.floor(Date.now() / 1000),
      content: '',
      tags: relays.map(r => ['relay', r])
    },
    identity.secret
  )

export const fetchWraps = async (transport: NostrTransport, relays: string[], pubkeyHex: string, sinceSecs: number): Promise<Event[]> => {
  const since = Math.max(0, sinceSecs - WRAP_BACKDATE_SECS)
  const events = await transport.query(relays, {kinds: [GIFT_WRAP_KIND], '#p': [pubkeyHex], since})
  const byId = new Map(events.map(e => [e.id, e]))
  return [...byId.values()].sort((a, b) => a.created_at - b.created_at)
}
