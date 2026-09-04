import {finalizeEvent, type Event, type Filter} from 'nostr-tools'
import {nip44} from 'nostr-tools'
import {BOOTSTRAP_RELAYS, type NostrTransport} from './nostr.ts'
import type {MintBackupKey} from './mintbackup.ts'
import type {NoteRecord, NoteState} from './types.ts'

// The note store on relays: one wallet, several devices, one set of notes.
//
// The CLI and the PWA are two wallets that cannot share, and a hardware
// signer is a third. Cashu.me answers this by keeping the whole proof set
// encrypted on relays, which buys multi-device and backup in one move, and
// closes the counter collision that restore-from-seed leaves open. This is
// the same shape for LNURLcash notes.
//
// One addressable event per note, under the same seed-derived key the mint
// list uses - deliberately not the wallet's Nostr identity, so knowing
// somebody's npub does not find their money. The content is NIP-44 to
// itself, and the seed is the only key that opens it.
//
// What this is NOT: a backup you can spend from without the seed, or a
// second copy of a note that two devices may both hand over. A relay holds
// ciphertext of bearer secrets. THREAT-MODEL.md says what that costs.

export const NOTE_SYNC_KIND = 30078
export const NOTE_D_PREFIX = 'lnurlcash-note:'
export const COUNTER_D_PREFIX = 'lnurlcash-counters:'

export const noteDTag = (id: string): string => `${NOTE_D_PREFIX}${id}`
export const counterDTag = (deviceId: string): string => `${COUNTER_D_PREFIX}${deviceId}`

// The record as it travels. Two fields stay at home. `replaces` names the
// local ids a mutation consumed, which is this device's bookkeeping about
// its own staging engine. `detail` is this wallet's note to itself about
// why a state was filed - each device writes its own, and publishing them
// would have two wallets forever rewriting each other's copy of the same
// fact.
export type SyncedNote = Omit<NoteRecord, 'replaces' | 'detail'>

export type NotePayload = {v: 1; note: SyncedNote}

// Counters live per device rather than in one shared list. Addressable
// events replace by (author, kind, d), so a single shared record would
// have each device overwriting the others' numbers on every push - which
// is the precise failure the counters exist to prevent. A `d` tag per
// device makes the merge a max() over records nobody else writes.
// v2 adds `cashCounters`, the LUD-25 m/139' ladder, alongside the legacy
// hmac one. Both directions are safe across versions: a device that predates
// this reads `counters` and ignores the new field, and it never mints on the
// m/139' ladder either, so it cannot collide with one that does. A v1 payload
// arriving here simply carries no cash counters, which reads as 0 - correct,
// since its author never used that ladder.
export type CounterPayload = {
  v: 1 | 2
  device: string
  counters: Record<string, number>
  cashCounters?: Record<string, number>
  updatedAt: number
}

const selfKey = (key: MintBackupKey): Uint8Array => nip44.getConversationKey(key.secret, key.pubkey)

// A note in a terminal state is history: the other device needs to know it
// is gone, and nothing needs its secret ever again. So the record still
// travels - "spent" is the tombstone, and it says more than a deleted
// event does, because a relay that dropped a NIP-09 delete and a relay
// that never held the note look identical to the wallet reading them.
const TERMINAL: readonly NoteState[] = ['spent']

export const forRelay = (note: NoteRecord): SyncedNote => {
  const {replaces: _replaces, detail: _detail, ...rest} = note
  if (!TERMINAL.includes(note.state)) return rest
  const {k1: _k1, ...withoutSecret} = rest
  return {...withoutSecret, k1: ''}
}

export const encodeNote = (key: MintBackupKey, note: NoteRecord): Event =>
  finalizeEvent(
    {
      kind: NOTE_SYNC_KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['d', noteDTag(note.id)]],
      content: nip44.encrypt(JSON.stringify({v: 1, note: forRelay(note)} satisfies NotePayload), selfKey(key))
    },
    key.secret
  )

const NOTE_STATES: readonly NoteState[] = ['live', 'staged', 'ambiguous', 'melting', 'sent', 'spent']

// Signed by a key only this seed can make, so it is ours - which is not the
// same as well formed. A truncated or corrupt payload must not become a
// note record, and a note record is money.
export const decodeNote = (key: MintBackupKey, event: Event): SyncedNote | null => {
  try {
    const parsed = JSON.parse(nip44.decrypt(event.content, selfKey(key))) as NotePayload
    const note = parsed?.note
    if (parsed?.v !== 1 || !note) return null
    if (typeof note.id !== 'string' || !/^[0-9a-f]{64}$/i.test(note.id)) return null
    if (event.tags.find(tag => tag[0] === 'd')?.[1] !== noteDTag(note.id)) return null
    if (typeof note.k1 !== 'string') return null
    if (typeof note.amountMsat !== 'number' || !Number.isFinite(note.amountMsat) || note.amountMsat < 0) return null
    if (typeof note.mintHost !== 'string' || note.mintHost === '') return null
    if (!NOTE_STATES.includes(note.state)) return null
    if (typeof note.updatedAt !== 'number' || !Number.isFinite(note.updatedAt)) return null
    return note
  } catch {
    return null
  }
}

export const encodeCounters = (
  key: MintBackupKey,
  deviceId: string,
  counters: Record<string, number>,
  cashCounters: Record<string, number> = {}
): Event =>
  finalizeEvent(
    {
      kind: NOTE_SYNC_KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['d', counterDTag(deviceId)]],
      content: nip44.encrypt(
        JSON.stringify({
          v: 2,
          device: deviceId,
          counters,
          cashCounters,
          updatedAt: Date.now()
        } satisfies CounterPayload),
        selfKey(key)
      )
    },
    key.secret
  )

export const decodeCounters = (key: MintBackupKey, event: Event): CounterPayload | null => {
  try {
    const parsed = JSON.parse(nip44.decrypt(event.content, selfKey(key))) as CounterPayload
    if ((parsed?.v !== 1 && parsed?.v !== 2) || typeof parsed.device !== 'string') return null
    const sane = (from: unknown): Record<string, number> => {
      const out: Record<string, number> = {}
      for (const [host, value] of Object.entries((from ?? {}) as Record<string, unknown>)) {
        if (typeof value === 'number' && Number.isInteger(value) && value >= 0) out[host] = value
      }
      return out
    }
    return {
      v: parsed.v,
      device: parsed.device,
      counters: sane(parsed.counters),
      // A v1 device wrote no cash counters, and never minted on that ladder
      // either, so an empty map here is the truth rather than a gap.
      cashCounters: sane(parsed.cashCounters),
      updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : 0
    }
  } catch {
    return null
  }
}

const relaysOr = (relays: string[]): string[] => (relays.length > 0 ? relays : BOOTSTRAP_RELAYS)

export const publishEvent = async (
  transport: NostrTransport,
  relays: string[],
  event: Event
): Promise<{ok: string[]; failed: string[]}> => transport.publish(relaysOr(relays), event)

// Everything this wallet has under its backup key, in one query. The key
// is used for nothing else, so a kind + author filter is the whole store;
// the `d` tag then says whether a record is a note, the mint list, or one
// device's counters. Relay filters match tag values exactly and cannot
// match a prefix, which is why the sorting happens here.
export const fetchStore = async (
  transport: NostrTransport,
  relays: string[],
  key: MintBackupKey
): Promise<{notes: SyncedNote[]; counters: CounterPayload[]}> => {
  const filter: Filter = {kinds: [NOTE_SYNC_KIND], authors: [key.pubkey]}
  const events = (await transport.query(relaysOr(relays), filter)).filter(
    event => event.pubkey === key.pubkey
  )

  // Newest per `d`. Relays are asked in parallel and a slow one may still
  // be holding a version this wallet replaced weeks ago.
  const newest = new Map<string, Event>()
  for (const event of events) {
    const d = event.tags.find(tag => tag[0] === 'd')?.[1]
    if (!d) continue
    const held = newest.get(d)
    if (!held || event.created_at > held.created_at) newest.set(d, event)
  }

  const notes: SyncedNote[] = []
  const counters: CounterPayload[] = []
  for (const [d, event] of newest) {
    if (d.startsWith(NOTE_D_PREFIX)) {
      const note = decodeNote(key, event)
      if (note) notes.push(note)
    } else if (d.startsWith(COUNTER_D_PREFIX)) {
      const payload = decodeCounters(key, event)
      if (payload) counters.push(payload)
    }
  }
  return {notes, counters}
}

// The highest index any device has claimed at each mint. Taken before
// minting, so two wallets on one seed do not derive the same secret twice.
// Upwards only, both ladders. A counter that went backwards would hand a
// second device an index the first has already minted at, and the note under
// it would collide with one that is already money.
export const mergeCounters = (
  payloads: CounterPayload[]
): {counters: Record<string, number>; cashCounters: Record<string, number>} => {
  const counters: Record<string, number> = {}
  const cashCounters: Record<string, number> = {}
  for (const payload of payloads) {
    for (const [host, value] of Object.entries(payload.counters)) {
      counters[host] = Math.max(counters[host] ?? 0, value)
    }
    for (const [host, value] of Object.entries(payload.cashCounters ?? {})) {
      cashCounters[host] = Math.max(cashCounters[host] ?? 0, value)
    }
  }
  return {counters, cashCounters}
}
