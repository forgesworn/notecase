import {afterEach, describe, expect, it} from 'vitest'
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {matchFilter, type Event, type Filter} from 'nostr-tools'
import {schnorr} from '@noble/curves/secp256k1.js'
import {bytesToHex, hexToBytes, randomBytes} from '@noble/hashes/utils.js'
import {bearerNoteIdOfPreimage, hashK1} from '../src/lnurlcash.js'
import {migrateNoteIds} from '../src/noteids.ts'
import {exportBackup, importBackup} from '../src/backup.ts'
import {initWallet, openWallet} from '../src/store.ts'
import {mintBackupKey} from '../src/mintbackup.ts'
import {encodeNote, noteDTag} from '../src/notesync.ts'
import type {NostrTransport} from '../src/nostr.ts'
import {Wallet} from '../src/wallet.ts'
import {emptyWallet, type NoteRecord, type WalletData} from '../src/types.ts'
import {freshK1, legacySchnorrCk1} from './helpers.ts'

// Every note is keyed by its taproot Q now. A wallet written before that
// filed a bearer note under sha256(k1), and has to be moved - exactly,
// because the record carries its k1, and harmlessly again and again, because
// it runs every time wallet data is read.

const note = (k1: string, id: string, extra: Partial<NoteRecord> = {}): NoteRecord => ({
  id,
  k1,
  amountMsat: 21_000,
  baseUrl: 'https://mint.example/w',
  callback: 'https://mint.example/cb',
  mintHost: 'mint.example',
  state: 'live',
  origin: 'receive',
  createdAt: 1,
  updatedAt: 1,
  ...extra
})

// A wallet as an older release left it: bearer notes under h, and every
// record that points at one pointing by h too.
const olderWallet = () => {
  const spent = freshK1()
  const rotated = freshK1()
  const melting = freshK1()
  const keySk = randomBytes(32)
  const keyCk1 = legacySchnorrCk1(keySk)
  const keyId = bytesToHex(schnorr.getPublicKey(keySk))
  const data: WalletData = emptyWallet()
  data.seedHex = 'ab'.repeat(32)
  data.notes = [
    note(spent, hashK1(spent), {state: 'spent'}),
    note(rotated, hashK1(rotated), {origin: 'rotate', replaces: [hashK1(spent)]}),
    note(melting, hashK1(melting), {state: 'melting'}),
    note(keyCk1, keyId),
    // a record this wallet did not write the way it writes one: left alone
    note(freshK1(), 'ee'.repeat(32))
  ]
  data.melts = [
    {
      paymentHash: 'cd'.repeat(32),
      noteId: hashK1(melting),
      pr: 'lnbc1',
      amountMsat: 21_000,
      target: 'invoice',
      state: 'in-flight',
      createdAt: 1,
      updatedAt: 1
    }
  ]
  data.requests = [
    {id: 'r1', amountMsat: 21_000, mints: ['mint.example'], createdAt: 1, state: 'paid', paidBy: hashK1(rotated), encoded: 'x'}
  ]
  data.settings.noteSyncPushed = {[hashK1(spent)]: 'pushed-spent', [hashK1(rotated)]: 'pushed-rotated', '#counters': 'c'}
  return {data, spent, rotated, melting, keyCk1, keyId}
}

describe('moving note ids onto Q', () => {
  it('moves each bearer note and everything that names it, and leaves a key note where it is', () => {
    const {data, spent, rotated, melting, keyCk1, keyId} = olderWallet()
    expect(migrateNoteIds(data)).toBe(3)

    const [spentNote, rotatedNote, meltingNote, keyNote, stranger] = data.notes
    expect(spentNote!.id).toBe(bearerNoteIdOfPreimage(spent))
    expect(rotatedNote!.id).toBe(bearerNoteIdOfPreimage(rotated))
    expect(meltingNote!.id).toBe(bearerNoteIdOfPreimage(melting))
    expect(rotatedNote!.replaces).toEqual([bearerNoteIdOfPreimage(spent)])
    expect(keyNote).toMatchObject({id: keyId, k1: keyCk1})
    expect(stranger!.id).toBe('ee'.repeat(32))

    expect(data.melts[0]!.noteId).toBe(bearerNoteIdOfPreimage(melting))
    expect(data.requests![0]!.paidBy).toBe(bearerNoteIdOfPreimage(rotated))
    expect(data.settings.noteSyncPushed).toEqual({
      [bearerNoteIdOfPreimage(spent)]: 'pushed-spent',
      [bearerNoteIdOfPreimage(rotated)]: 'pushed-rotated',
      '#counters': 'c'
    })
  })

  it('is idempotent: a second pass changes nothing', () => {
    const {data} = olderWallet()
    migrateNoteIds(data)
    const once = JSON.stringify(data)
    expect(migrateNoteIds(data)).toBe(0)
    expect(JSON.stringify(data)).toBe(once)
  })

  it('happens when a wallet is built over older data, so every lookup by id still lands', () => {
    const {data, rotated, melting} = olderWallet()
    const wallet = new Wallet(data, async () => {}, {})
    expect(wallet.noteById(bearerNoteIdOfPreimage(rotated))?.k1).toBe(rotated)
    expect(wallet.noteById(hashK1(rotated))).toBeUndefined()
    expect(wallet.noteById(data.melts[0]!.noteId)?.k1).toBe(melting)
    expect(wallet.balanceMsat()).toBe(21_000 * 3)
  })
})

describe('older wallet files, stores and backups', () => {
  const homes: string[] = []
  afterEach(() => {
    for (const home of homes.splice(0)) rmSync(home, {recursive: true, force: true})
  })
  const tempHome = (): string => {
    const home = mkdtempSync(join(tmpdir(), 'notecase-ids-'))
    homes.push(home)
    return home
  }

  it('moves a plaintext wallet.json on open', async () => {
    const home = tempHome()
    await initWallet({home})
    const {data, rotated} = olderWallet()
    writeFileSync(join(home, 'wallet.json'), JSON.stringify({v: 1, cipher: 'none', data}))

    const opened = await openWallet({home})
    expect(opened.data.notes.map(record => record.id)).toContain(bearerNoteIdOfPreimage(rotated))
    await opened.save()
    const onDisk = JSON.parse(readFileSync(join(home, 'wallet.json'), 'utf8')) as {data: WalletData}
    expect(onDisk.data.notes.find(record => record.k1 === rotated)!.id).toBe(bearerNoteIdOfPreimage(rotated))
  })

  it('moves a sealed wallet on open', async () => {
    const home = tempHome()
    const store = await initWallet({home, pin: '123456'})
    const {data, rotated} = olderWallet()
    Object.assign(store.data, data)
    await store.save()

    const opened = await openWallet({home, pin: '123456'})
    expect(opened.data.notes.find(record => record.k1 === rotated)!.id).toBe(bearerNoteIdOfPreimage(rotated))
  })

  it('restores a backup taken before the move, with its ids moved', async () => {
    const {data, spent, rotated} = olderWallet()
    const restored = await importBackup(await exportBackup(data, 'correct horse battery'), 'correct horse battery')
    const rotatedNote = restored.notes.find(record => record.k1 === rotated)!
    expect(rotatedNote.id).toBe(bearerNoteIdOfPreimage(rotated))
    expect(rotatedNote.replaces).toEqual([bearerNoteIdOfPreimage(spent)])
    expect(restored.requests![0]!.paidBy).toBe(bearerNoteIdOfPreimage(rotated))
  })
})

// A relay the note store writes to, keeping one event per (author, kind, d).
const fakeRelay = (): {transport: NostrTransport; events: () => Event[]} => {
  let stored: Event[] = []
  const dOf = (event: Event) => event.tags.find(tag => tag[0] === 'd')?.[1]
  const transport: NostrTransport = {
    subscribe: () => ({close() {}}),
    async query(_relays, filter: Filter) {
      return stored.filter(event => matchFilter(filter, event))
    },
    async publish(relays, event) {
      stored = stored.filter(held => !(held.pubkey === event.pubkey && held.kind === event.kind && dOf(held) === dOf(event)))
      stored.push(event)
      return {ok: relays, failed: []}
    },
    close() {}
  }
  return {transport, events: () => stored}
}

describe('the note store across the move', () => {
  const SEED = 'ab'.repeat(32)
  const synced = () => {
    const data = emptyWallet()
    data.seedHex = SEED
    data.settings.noteSync = true
    data.settings.nostrRelays = ['wss://relay.one']
    return {data, wallet: new Wallet(data, async () => {}, {})}
  }
  const key = mintBackupKey(hexToBytes(SEED))

  it("merges a record filed under a note's old id, from before this device moved or from one that has not", async () => {
    const relay = fakeRelay()
    const {data, wallet} = synced()
    const k1 = freshK1()
    data.notes.push(note(k1, bearerNoteIdOfPreimage(k1)))
    // another device on the same seed, still on the old ids, handed it over
    await relay.transport.publish(['wss://relay.one'], encodeNote(key, note(k1, hashK1(k1), {state: 'sent', updatedAt: 5})))

    const pulled = await wallet.pullNotes(relay.transport)
    expect(pulled.added).toEqual([])
    expect(pulled.updated.map(record => record.id)).toEqual([bearerNoteIdOfPreimage(k1)])
    expect(data.notes).toHaveLength(1)
    expect(data.notes[0]).toMatchObject({id: bearerNoteIdOfPreimage(k1), state: 'sent', k1})

    // and the next push files it under its Q
    await wallet.pushNotes(relay.transport)
    const tags = relay.events().map(event => event.tags.find(tag => tag[0] === 'd')?.[1])
    expect(tags).toContain(noteDTag(bearerNoteIdOfPreimage(k1)))
  })

  it("takes a burn filed under a note's old id, though it travels without its secret", async () => {
    const relay = fakeRelay()
    const {data, wallet} = synced()
    const k1 = freshK1()
    data.notes.push(note(k1, bearerNoteIdOfPreimage(k1)))
    await relay.transport.publish(['wss://relay.one'], encodeNote(key, note(k1, hashK1(k1), {state: 'spent', updatedAt: 5})))

    const pulled = await wallet.pullNotes(relay.transport)
    expect(pulled.spentElsewhere.map(record => record.id)).toEqual([bearerNoteIdOfPreimage(k1)])
    expect(wallet.balanceMsat()).toBe(0)
    expect(data.notes).toHaveLength(1)
  })

  it('takes in a note only another device held under its old id, filed under its Q', async () => {
    const relay = fakeRelay()
    const {data, wallet} = synced()
    const k1 = freshK1()
    await relay.transport.publish(['wss://relay.one'], encodeNote(key, note(k1, hashK1(k1), {updatedAt: 5})))

    const pulled = await wallet.pullNotes(relay.transport)
    expect(pulled.added.map(record => record.id)).toEqual([bearerNoteIdOfPreimage(k1)])
    expect(data.notes[0]!.k1).toBe(k1)
  })
})
