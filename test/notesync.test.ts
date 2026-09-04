import {afterEach, describe, expect, it} from 'vitest'
import {createMockMint} from 'lnurlcash-conformance/mock-mint'
import {matchFilter, type Event, type Filter} from 'nostr-tools'
import {hexToBytes} from '@noble/hashes/utils.js'
import {mintBackupKey} from '../src/mintbackup.ts'
import {NOTE_SYNC_KIND, decodeNote, noteDTag} from '../src/notesync.ts'
import type {NostrTransport} from '../src/nostr.ts'
import {makeWallet} from './helpers.ts'

// Two wallets, one seed, one purse.
//
// The CLI and the PWA have always been two wallets that cannot share, and
// a hardware signer is a third. These tests are about what it takes to
// make them one: what travels, what must never travel, and above all what
// happens when the two disagree about a note - because the wrong answer
// there is a wallet offering to spend money that is already gone.

type Mint = Awaited<ReturnType<typeof createMockMint>>
const open: Mint[] = []
const start = async (options: Record<string, unknown> = {}): Promise<Mint> => {
  const mint = await createMockMint(options)
  open.push(mint)
  return mint
}
afterEach(async () => {
  for (const mint of open.splice(0)) await mint.close()
})

const RELAYS = ['wss://relay.one', 'wss://relay.two']
const SEED = 'ab'.repeat(32)

const dTag = (event: Event): string | undefined => event.tags.find(t => t[0] === 'd')?.[1]

const fakeRelays = (): {transport: NostrTransport; stored: Map<string, Event[]>; down: Set<string>} => {
  const stored = new Map<string, Event[]>()
  const down = new Set<string>()
  const transport: NostrTransport = {
    subscribe: () => ({close() {}}),
    async query(relays, filter: Filter) {
      const out: Event[] = []
      for (const r of relays) {
        if (down.has(r)) continue
        for (const e of stored.get(r) ?? []) if (matchFilter(filter, e)) out.push(e)
      }
      return out
    },
    async publish(relays, event) {
      const ok: string[] = []
      const failed: string[] = []
      for (const r of relays) {
        if (down.has(r)) {
          failed.push(r)
          continue
        }
        // Addressable: one event per (author, kind, d), newest kept.
        const list = (stored.get(r) ?? []).filter(
          e => !(e.kind === event.kind && e.pubkey === event.pubkey && dTag(e) === dTag(event))
        )
        list.push(event)
        stored.set(r, list)
        ok.push(r)
      }
      return {ok, failed}
    },
    close() {}
  }
  return {transport, stored, down}
}

const hostOf = (mint: Mint): string => new URL(mint.url).host

/** A wallet on the shared seed with the note store switched on. */
const synced = async () => {
  const made = makeWallet()
  made.data.seedHex = SEED
  await made.wallet.setNostrRelays(RELAYS)
  await made.wallet.setNoteSync(true)
  return made
}

/** Puts a real note in a wallet, the way a receive does. */
const fund = async (made: Awaited<ReturnType<typeof synced>>, mint: Mint, k1: string, msat: number) => {
  mint.state.creditNote(k1, msat)
  return made.wallet.receive(`${mint.url}/w?k1=${k1}&amount=${msat}`)
}

const eventsFor = (stored: Map<string, Event[]>, id: string): Event[] =>
  (stored.get(RELAYS[0]!) ?? []).filter(event => dTag(event) === noteDTag(id))

describe('what a note looks like on a relay', () => {
  it('is one addressable event per note, and says nothing in the clear', async () => {
    const mint = await start()
    const {transport, stored} = fakeRelays()
    const made = await synced()
    await made.wallet.addMint(`mint@${hostOf(mint)}`)
    const received = await fund(made, mint, 'cd'.repeat(32), 21_000)

    await made.wallet.pushNotes(transport)

    const note = made.data.notes.find(n => n.state === 'live')!
    const [event] = eventsFor(stored, note.id)
    expect(event!.kind).toBe(NOTE_SYNC_KIND)
    // The secret is the money. It must not be legible on a relay, and
    // neither must the mint or the amount.
    expect(event!.content).not.toContain(note.k1)
    expect(event!.content).not.toContain(hostOf(mint))
    expect(event!.content).not.toContain('21000')
    expect(received.note.amountMsat).toBe(21_000)

    const decoded = decodeNote(mintBackupKey(hexToBytes(SEED)), event!)!
    expect(decoded.id).toBe(note.id)
    expect(decoded.k1).toBe(note.k1)
    expect(decoded.amountMsat).toBe(note.amountMsat)
  })

  it('cannot be read by another seed', async () => {
    const mint = await start()
    const {transport, stored} = fakeRelays()
    const made = await synced()
    await made.wallet.addMint(`mint@${hostOf(mint)}`)
    await fund(made, mint, 'ce'.repeat(32), 21_000)
    await made.wallet.pushNotes(transport)

    const note = made.data.notes.find(n => n.state === 'live')!
    const [event] = eventsFor(stored, note.id)
    expect(decodeNote(mintBackupKey(hexToBytes('99'.repeat(32))), event!)).toBeNull()
  })

  it('keeps no secret once the note is spent', async () => {
    const mint = await start()
    const {transport, stored} = fakeRelays()
    const made = await synced()
    await made.wallet.addMint(`mint@${hostOf(mint)}`)
    await fund(made, mint, 'cf'.repeat(32), 21_000)
    await made.wallet.pushNotes(transport)

    const note = made.data.notes.find(n => n.state === 'live')!
    const k1 = note.k1
    await made.wallet.melt(
      // Spending it is what matters here, not where it went; the wallet
      // marks it spent either way.
      `${mint.url}/w?k1=${k1}&amount=21000`,
      'invoice'
    ).catch(() => {})
    note.state = 'spent'
    note.updatedAt = note.updatedAt + 1
    await made.wallet.pushNotes(transport)

    const decoded = decodeNote(mintBackupKey(hexToBytes(SEED)), eventsFor(stored, note.id)[0]!)!
    // The record still travels - that is how the other device learns the
    // note is gone - but a burned secret has no reason to sit on a relay.
    expect(decoded.state).toBe('spent')
    expect(decoded.k1).toBe('')
  })
})

describe('two wallets on one seed', () => {
  it('hands a note from one device to the other', async () => {
    const mint = await start()
    const {transport} = fakeRelays()

    const laptop = await synced()
    await laptop.wallet.addMint(`mint@${hostOf(mint)}`)
    await fund(laptop, mint, 'd1'.repeat(32), 50_000)
    await laptop.wallet.pushNotes(transport)

    const phone = await synced()
    await phone.wallet.addMint(`mint@${hostOf(mint)}`)
    expect(phone.wallet.balanceMsat()).toBe(0)

    const pulled = await phone.wallet.pullNotes(transport)
    expect(pulled.found).toBe(true)
    expect(pulled.added).toHaveLength(1)
    expect(phone.wallet.balanceMsat()).toBe(50_000)
    // The same secret, not a copy of the shape of one.
    expect(phone.data.notes[0]!.k1).toBe(laptop.data.notes.find(n => n.state === 'live')!.k1)
  })

  it('marks a note spent when the other device burned it', async () => {
    const mint = await start()
    const {transport} = fakeRelays()

    const laptop = await synced()
    await laptop.wallet.addMint(`mint@${hostOf(mint)}`)
    await fund(laptop, mint, 'd2'.repeat(32), 50_000)
    await laptop.wallet.pushNotes(transport)

    const phone = await synced()
    await phone.wallet.addMint(`mint@${hostOf(mint)}`)
    await phone.wallet.pullNotes(transport)
    expect(phone.wallet.balanceMsat()).toBe(50_000)

    // The phone spends it and says so.
    const held = phone.data.notes[0]!
    held.state = 'spent'
    held.updatedAt = Date.now() + 1
    await phone.wallet.pushNotes(transport)

    const before = laptop.wallet.balanceMsat()
    const pulled = await laptop.wallet.pullNotes(transport)
    expect(before).toBe(50_000)
    expect(pulled.spentElsewhere).toHaveLength(1)
    expect(laptop.wallet.balanceMsat()).toBe(0)
    expect(laptop.data.notes.find(n => n.id === held.id)!.detail).toMatch(/another device/)
  })

  it('never resurrects a note this wallet already spent, however new the relay copy is', async () => {
    const mint = await start()
    const {transport, stored} = fakeRelays()

    const laptop = await synced()
    await laptop.wallet.addMint(`mint@${hostOf(mint)}`)
    await fund(laptop, mint, 'd3'.repeat(32), 50_000)
    await laptop.wallet.pushNotes(transport)

    const phone = await synced()
    await phone.wallet.addMint(`mint@${hostOf(mint)}`)
    await phone.wallet.pullNotes(transport)

    // The laptop spends it. The phone has not heard, and touches its own
    // copy afterwards for its own reasons - so the record on the relay is
    // both NEWER than the laptop's and still says the note is live.
    const note = laptop.data.notes.find(n => n.state === 'live')!
    note.state = 'spent'
    note.updatedAt = Date.now()

    const onPhone = phone.data.notes.find(n => n.id === note.id)!
    onPhone.memo = 'still mine, as far as this device knows'
    onPhone.updatedAt = note.updatedAt + 5_000
    await phone.wallet.pushNotes(transport)
    expect(decodeNote(mintBackupKey(hexToBytes(SEED)), eventsFor(stored, note.id)[0]!)!.state).toBe('live')

    const pulled = await laptop.wallet.pullNotes(transport)

    // Newest-wins would hand the holder back money that is already gone,
    // which is the one direction this merge must never move in.
    expect(pulled.updated).toEqual([])
    expect(laptop.data.notes.find(n => n.id === note.id)!.state).toBe('spent')
    expect(laptop.wallet.balanceMsat()).toBe(0)
  })

  it('takes the newer record when both devices know the note', async () => {
    const mint = await start()
    const {transport} = fakeRelays()

    const laptop = await synced()
    await laptop.wallet.addMint(`mint@${hostOf(mint)}`)
    await fund(laptop, mint, 'd4'.repeat(32), 50_000)
    await laptop.wallet.pushNotes(transport)

    const phone = await synced()
    await phone.wallet.addMint(`mint@${hostOf(mint)}`)
    await phone.wallet.pullNotes(transport)

    const onPhone = phone.data.notes[0]!
    onPhone.memo = 'for the taxi'
    onPhone.updatedAt = Date.now() + 1_000
    await phone.wallet.pushNotes(transport)

    const pulled = await laptop.wallet.pullNotes(transport)
    expect(pulled.updated).toHaveLength(1)
    expect(laptop.data.notes.find(n => n.id === onPhone.id)!.memo).toBe('for the taxi')
  })
})

describe('the derivation counters', () => {
  it('carry the highest index any device has claimed', async () => {
    const mint = await start()
    const {transport} = fakeRelays()
    const host = hostOf(mint)

    const laptop = await synced()
    await laptop.wallet.addMint(`mint@${host}`)
    laptop.data.cashCounters = {[host]: 7}
    await laptop.wallet.pushNotes(transport)

    const phone = await synced()
    await phone.wallet.addMint(`mint@${host}`)
    expect(phone.wallet.cashCounterFor(host)).toBe(0)

    const pulled = await phone.wallet.pullNotes(transport)
    expect(pulled.countersMoved).toBe(1)
    // Two wallets deriving from index 0 would make the same secret twice,
    // and the second mint of it would be refused as a collision.
    expect(phone.wallet.cashCounterFor(host)).toBe(7)
  })

  // The legacy ladder is still synced, because it is still where a restore
  // starts looking for notes minted before LUD-25 specified a derivation.
  it('carry the pre-spec ladder too, alongside the current one', async () => {
    const mint = await start()
    const {transport} = fakeRelays()
    const host = hostOf(mint)

    const laptop = await synced()
    await laptop.wallet.addMint(`mint@${host}`)
    laptop.data.counters = {[host]: 3}
    laptop.data.cashCounters = {[host]: 11}
    await laptop.wallet.pushNotes(transport)

    const phone = await synced()
    await phone.wallet.addMint(`mint@${host}`)
    await phone.wallet.pullNotes(transport)

    expect(phone.wallet.cashCounterFor(host)).toBe(11)
    expect(phone.wallet.counterFor(host)).toBe(3)
  })

  // A device that predates the m/139' ladder publishes a v1 payload with no
  // cash counters at all. It never minted on that ladder either, so reading
  // its silence as zero is correct rather than a gap.
  it('accept a payload from a device that predates the current ladder', async () => {
    const mint = await start()
    const {transport} = fakeRelays()
    const host = hostOf(mint)

    const laptop = await synced()
    await laptop.wallet.addMint(`mint@${host}`)
    laptop.data.counters = {[host]: 6}
    delete laptop.data.cashCounters
    await laptop.wallet.pushNotes(transport)

    const phone = await synced()
    await phone.wallet.addMint(`mint@${host}`)
    phone.data.cashCounters = {[host]: 2}
    await phone.wallet.pullNotes(transport)

    expect(phone.wallet.counterFor(host)).toBe(6)
    // and its own position on the current ladder is not dragged back
    expect(phone.wallet.cashCounterFor(host)).toBe(2)
  })

  it('are published per device, and the highest wins whoever wrote last', async () => {
    const mint = await start()
    const {transport} = fakeRelays()
    const host = hostOf(mint)

    // The device that has minted the most publishes FIRST, so a merge that
    // simply took the last record it read would land on the wrong number
    // and hand the next mint a secret that is already in use.
    const laptop = await synced()
    await laptop.wallet.addMint(`mint@${host}`)
    laptop.data.cashCounters = {[host]: 9}
    await laptop.wallet.pushNotes(transport)

    const phone = await synced()
    await phone.wallet.addMint(`mint@${host}`)
    phone.data.cashCounters = {[host]: 4}
    await phone.wallet.pushNotes(transport)

    // A single shared record would have left only the last writer's number.
    const third = await synced()
    await third.wallet.addMint(`mint@${host}`)
    expect((await third.wallet.pullNotes(transport)).countersMoved).toBe(1)
    expect(third.wallet.cashCounterFor(host)).toBe(9)

    // And the device that was behind catches up rather than dragging the
    // others back.
    expect((await phone.wallet.pullNotes(transport)).countersMoved).toBe(1)
    expect(phone.wallet.cashCounterFor(host)).toBe(9)
    expect((await laptop.wallet.pullNotes(transport)).countersMoved).toBe(0)
    expect(laptop.wallet.cashCounterFor(host)).toBe(9)
  })
})

describe('publishing', () => {
  it('sends a record once and not again until it changes', async () => {
    const mint = await start()
    const {transport} = fakeRelays()
    const made = await synced()
    await made.wallet.addMint(`mint@${hostOf(mint)}`)
    await fund(made, mint, 'd5'.repeat(32), 21_000)

    expect((await made.wallet.pushNotes(transport)).pushed.length).toBeGreaterThan(0)
    expect((await made.wallet.pushNotes(transport)).pushed).toEqual([])

    const note = made.data.notes.find(n => n.state === 'live')!
    note.memo = 'changed'
    note.updatedAt = note.updatedAt + 1
    expect((await made.wallet.pushNotes(transport)).pushed).toContain(note.id)
  })

  it('does not count a push no relay took', async () => {
    const mint = await start()
    const {transport, down} = fakeRelays()
    const made = await synced()
    await made.wallet.addMint(`mint@${hostOf(mint)}`)
    await fund(made, mint, 'd6'.repeat(32), 21_000)
    for (const relay of RELAYS) down.add(relay)

    const first = await made.wallet.pushNotes(transport)
    expect(first.pushed).toEqual([])
    expect(first.failed.length).toBeGreaterThan(0)

    // Remembering it as published would leave the note off the relays for
    // good, because nothing about it changes again.
    for (const relay of RELAYS) down.delete(relay)
    expect((await made.wallet.pushNotes(transport)).pushed.length).toBeGreaterThan(0)
  })

  it('keeps a spent note local until it has been published once', async () => {
    const mint = await start()
    const {transport, stored} = fakeRelays()
    const made = await synced()
    await made.wallet.addMint(`mint@${hostOf(mint)}`)
    await fund(made, mint, 'd7'.repeat(32), 21_000)

    const note = made.data.notes.find(n => n.state === 'live')!
    note.state = 'spent'
    await made.wallet.pushNotes(transport)

    // Nobody else ever knew about it, so there is nothing to tell them.
    expect(eventsFor(stored, note.id)).toEqual([])
  })
})

describe('switching it on', () => {
  it('refuses a wallet with no seed', async () => {
    const made = makeWallet()
    await expect(made.wallet.setNoteSync(true)).rejects.toThrow(/no seed/)
  })

  it('looks for a store rather than starting an empty one beside it', async () => {
    const mint = await start()
    const {transport} = fakeRelays()

    const laptop = await synced()
    await laptop.wallet.addMint(`mint@${hostOf(mint)}`)
    await fund(laptop, mint, 'd8'.repeat(32), 33_000)
    await laptop.wallet.pushNotes(transport)

    const fresh = makeWallet()
    fresh.data.seedHex = SEED
    await fresh.wallet.setNostrRelays(RELAYS)
    await fresh.wallet.setNoteSync(true, transport)

    expect(fresh.wallet.balanceMsat()).toBe(33_000)
  })

  it('refuses to sync while it is off', async () => {
    const {transport} = fakeRelays()
    const made = makeWallet()
    made.data.seedHex = SEED
    await expect(made.wallet.syncNotes(transport)).rejects.toThrow(/off/)
  })
})

// The acceptance case, end to end through syncNotes rather than the two
// halves: rotate on one device, the other has the note without a file
// changing hands; burn it there, and the first device's next sync says so.
describe('the round trip', () => {
  it('rotates on one device and spends on the other', async () => {
    const mint = await start()
    const {transport} = fakeRelays()
    const host = hostOf(mint)

    const laptop = await synced()
    await laptop.wallet.addMint(`mint@${host}`)
    await fund(laptop, mint, 'e1'.repeat(32), 60_000)
    const before = laptop.data.notes.find(n => n.state === 'live')!.k1
    await laptop.wallet.rotateLive(laptop.data.notes.find(n => n.state === 'live')!)
    const rotated = laptop.data.notes.find(n => n.state === 'live')!
    expect(rotated.k1).not.toBe(before)
    await laptop.wallet.syncNotes(transport)

    const phone = await synced()
    await phone.wallet.addMint(`mint@${host}`)
    const arrived = await phone.wallet.syncNotes(transport)
    expect(arrived.added.map(note => note.id)).toContain(rotated.id)
    expect(phone.wallet.balanceMsat()).toBe(60_000)

    // The phone melts it. The mint burns the note, and the record the
    // phone publishes is what tells the laptop.
    mint.state.settleMelt(rotated.k1)
    const spentOnPhone = phone.data.notes.find(n => n.id === rotated.id)!
    spentOnPhone.state = 'spent'
    spentOnPhone.updatedAt = Date.now() + 1_000
    await phone.wallet.syncNotes(transport)

    const back = await laptop.wallet.syncNotes(transport)
    expect(back.spentElsewhere.map(note => note.id)).toEqual([rotated.id])
    expect(laptop.wallet.balanceMsat()).toBe(0)
  })
})
