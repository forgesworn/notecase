import {legacyNoteIdOf, noteIdOf} from './spend.ts'
import type {NoteRecord, WalletData} from './types.ts'

// Moving a wallet's notes onto the ids LUD-25 now gives them.
//
// A bearer note used to be filed under h = sha256(k1). Every note is a
// taproot output key Q now, and a mint files, burns and certifies it under
// hex(Q), so this wallet does too. A key note's id was already its key, which
// is its Q, and does not move.
//
// The move is deterministic, because a record carries its own k1 and the new
// id is a function of it, and idempotent, because a record already under its
// Q no longer matches its old id and is left alone. So it runs wherever wallet
// data is read - a wallet file, a PWA store, a backup - and running it twice
// is running it once. Only a record filed under exactly its own old id moves:
// anything else is a record this wallet did not write, and guessing at it
// could fold two notes into one.
//
// Everything else that names a note by id moves with it in the same pass:
// the inputs a staged mutation replaced, the note a melt burned, the note that
// paid a request, and what the relay store was last sent per note.

// Only a bearer note ever had an id other than its Q, and only a preimage or
// a cw1 can be one. A ck1's id was always its key, so it is never asked
// about: reading an old 65-byte ck1 costs a key recovery, every open.
const mayHaveMoved = (k1: unknown): k1 is string =>
  typeof k1 === 'string' && (/^[0-9a-f]{64}$/i.test(k1.trim()) || /^cw1/i.test(k1.trim()))

export const migrateNoteIds = (data: WalletData): number => {
  const renamed = new Map<string, string>()
  for (const note of data.notes ?? []) {
    if (!mayHaveMoved(note.k1)) continue
    // sha256 alone for a preimage, so a wallet that has already moved pays
    // almost nothing to find that out on every open.
    if (legacyNoteIdOf(note.k1) !== note.id) continue
    const current = noteIdOf(note.k1)
    if (!current || current === note.id) continue
    renamed.set(note.id, current)
    note.id = current
  }
  if (renamed.size === 0) return 0

  const rename = (id: string): string => renamed.get(id) ?? id
  for (const note of data.notes) {
    if (note.replaces) note.replaces = note.replaces.map(rename)
  }
  for (const melt of data.melts ?? []) melt.noteId = rename(melt.noteId)
  for (const request of data.requests ?? []) {
    if (request.paidBy) request.paidBy = rename(request.paidBy)
  }
  // Keyed by note id. The fingerprint stays with the note: it was taken of the
  // record under its old id, so the next push sees a change and republishes
  // the note under its new one.
  const pushed = data.settings?.noteSyncPushed
  if (pushed) {
    data.settings.noteSyncPushed = Object.fromEntries(Object.entries(pushed).map(([id, print]) => [rename(id), print]))
  }
  return renamed.size
}

// The id a record from somewhere else - the relay store, typically - names
// its note by here. A record carrying its k1 is judged by it, exactly as the
// migration judges a local one. A spent record travels without its k1, so it
// is matched to the local note whose old id it carries. That index is built
// only if a record needs it, and again if notes have been added since, so a
// note taken in earlier in the same pass is found too.
export const noteIdResolver = (local: NoteRecord[]): ((record: Pick<NoteRecord, 'id' | 'k1'>) => string) => {
  let byOldId: Map<string, string> | null = null
  let indexed = -1
  return record => {
    if (typeof record.k1 === 'string' && record.k1 !== '') {
      if (!mayHaveMoved(record.k1) || legacyNoteIdOf(record.k1) !== record.id) return record.id
      return noteIdOf(record.k1) ?? record.id
    }
    if (!byOldId || indexed !== local.length) {
      byOldId = new Map(
        local.flatMap(note => {
          const old = mayHaveMoved(note.k1) ? legacyNoteIdOf(note.k1) : null
          return old && old !== note.id ? [[old, note.id] as const] : []
        })
      )
      indexed = local.length
    }
    return byOldId.get(record.id) ?? record.id
  }
}
