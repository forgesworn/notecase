import {afterEach, describe, expect, it} from 'vitest'
import {createMockMint} from 'lnurlcash-conformance/mock-mint'
import {finalizeEvent, generateSecretKey, getPublicKey, matchFilter, type Event, type Filter} from 'nostr-tools'
import {nip44} from 'nostr-tools'
import {Wallet} from '../src/wallet.ts'
import {
  GIFT_WRAP_KIND,
  INBOX_RELAYS_KIND,
  NOTE_KIND,
  NotANoteWrapError,
  identityFromSecret,
  newIdentitySecretHex,
  recipientPubkey,
  resolveRecipient,
  npubOf,
  unwrapNote,
  wrapNote,
  type NostrTransport
} from '../src/nostr.ts'
import {noteK1, resolveNoteInput} from 'lnurlcash-kit'
import {freshK1, makeWallet} from './helpers.ts'

// Two wallets and a relay that is a list. The mint is the conformance
// mock, so "claimed" below means the secret in the wrap really was burned.

type Mint = Awaited<ReturnType<typeof createMockMint>>
let mint: Mint | null = null
const start = async (): Promise<Mint> => {
  mint = await createMockMint({})
  return mint
}
afterEach(async () => {
  await mint?.close()
  mint = null
})

const fund = (theMint: Mint, amountMsat: number): string => {
  const k1 = freshK1()
  theMint.state.creditNote(k1, amountMsat)
  return `${theMint.url}/w?k1=${k1}&amount=${amountMsat}`
}

// One relay shared by everyone, keyed by URL so publish/query can be
// checked per relay.
const fakeRelays = (): {transport: NostrTransport; stored: Map<string, Event[]>; down: Set<string>} => {
  const stored = new Map<string, Event[]>()
  const down = new Set<string>()
  const transport: NostrTransport = {
    subscribe(_relays, _filter, _onEvent) {
      // This suite drives the wrap/inbox paths, which use query() against
      // stored kinds. Nothing here needs a live subscription.
      return {close() {}}
    },
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
        const list = stored.get(r) ?? []
        if (!list.some(e => e.id === event.id)) list.push(event)
        stored.set(r, list)
        ok.push(r)
      }
      return {ok, failed}
    },
    close() {}
  }
  return {transport, stored, down}
}

const withIdentity = async (w: Wallet, relays: string[]): Promise<ReturnType<typeof identityFromSecret>> => {
  await w.setNostrRelays(relays)
  return w.ensureNostrIdentity()
}

describe('the wrap itself', () => {
  it('round-trips, names the sender, and carries the note verbatim', () => {
    const alice = identityFromSecret(newIdentitySecretHex())
    const bob = identityFromSecret(newIdentitySecretHex())
    const url = 'https://mint.example/w?k1=' + 'ab'.repeat(32) + '&amount=21000'
    const wrap = wrapNote(url, 21_000, bob.pubkey, alice)
    expect(wrap.kind).toBe(GIFT_WRAP_KIND)
    expect(wrap.pubkey).not.toBe(alice.pubkey)
    expect(wrap.tags).toEqual([['p', bob.pubkey]])
    const opened = unwrapNote(wrap, bob)
    expect(opened.sender).toBe(alice.pubkey)
    expect(opened.note.noteUrl).toBe(url)
    expect(opened.note.amountMsat).toBe(21_000)
    expect(opened.note.host).toBe('mint.example/w')
    // Not for Carol.
    const carol = identityFromSecret(newIdentitySecretHex())
    expect(() => unwrapNote(wrap, carol)).toThrow()
  })

  it('refuses a rumor that claims a different author than the seal signer', () => {
    const alice = identityFromSecret(newIdentitySecretHex())
    const bob = identityFromSecret(newIdentitySecretHex())
    const mallory = identityFromSecret(newIdentitySecretHex())
    // Alice signs the seal; the rumor inside says Mallory wrote it.
    const rumor = {
      kind: NOTE_KIND,
      created_at: 1,
      content: 'https://mint.example/w?k1=' + 'ab'.repeat(32) + '&amount=1',
      tags: [],
      pubkey: mallory.pubkey,
      id: ''
    }
    const {getEventHash} = require('nostr-tools') as typeof import('nostr-tools')
    rumor.id = getEventHash(rumor)
    const seal = finalizeEvent(
      {kind: 13, created_at: 1, tags: [], content: nip44.encrypt(JSON.stringify(rumor), nip44.getConversationKey(alice.secret, bob.pubkey))},
      alice.secret
    )
    const eph = generateSecretKey()
    const wrap = finalizeEvent(
      {kind: GIFT_WRAP_KIND, created_at: 1, tags: [['p', bob.pubkey]], content: nip44.encrypt(JSON.stringify(seal), nip44.getConversationKey(eph, bob.pubkey))},
      eph
    )
    expect(() => unwrapNote(wrap, bob)).toThrow(NotANoteWrapError)
    expect(() => unwrapNote(wrap, bob)).toThrow('rumor author')
  })

  it('refuses a wrap whose rumor is not a note', () => {
    const alice = identityFromSecret(newIdentitySecretHex())
    const bob = identityFromSecret(newIdentitySecretHex())
    const {nip59} = require('nostr-tools') as typeof import('nostr-tools')
    const dm = nip59.wrapEvent({kind: 14, content: 'hello', tags: [['p', bob.pubkey]]}, alice.secret, bob.pubkey)
    expect(() => unwrapNote(dm, bob)).toThrow('not a bearer note')
    const junk = nip59.wrapEvent({kind: NOTE_KIND, content: 'https://mint.example/w', tags: []}, alice.secret, bob.pubkey)
    expect(() => unwrapNote(junk, bob)).toThrow('not a note URL')
  })

  it('takes an npub or hex and nothing else', () => {
    const id = identityFromSecret(newIdentitySecretHex())
    expect(recipientPubkey(id.npub)).toBe(id.pubkey)
    expect(recipientPubkey(id.pubkey.toUpperCase())).toBe(id.pubkey)
    expect(() => recipientPubkey('alice@example.com')).toThrow()
    expect(() => recipientPubkey('npub1notreal')).toThrow()
  })
})

describe('sending to an npub', () => {
  it('lands on the recipient inbox relays and is claimable there once', async () => {
    const theMint = await start()
    const {transport, stored} = fakeRelays()
    const {wallet: alice, data: aliceData} = makeWallet()
    const {wallet: bob} = makeWallet()
    await alice.receive(fund(theMint, 50_000))
    await withIdentity(alice, ['wss://a.example'])
    const bobId = await withIdentity(bob, ['wss://bob-inbox.example'])
    await bob.publishInbox(transport)

    const sent = await alice.sendToNostr(transport, 20_000, bobId.npub)
    expect(sent.inboxKnown).toBe(true)
    expect(sent.relays).toEqual(['wss://bob-inbox.example'])
    expect(sent.note.state).toBe('sent')
    expect(sent.note.sentTo).toBe(bobId.pubkey)
    expect(alice.balanceMsat()).toBe(30_000)
    expect(aliceData.notes.find(n => n.id === sent.note.id)?.sentTo).toBe(bobId.pubkey)
    // Nothing on the relay says who, how much, or where.
    const onRelay = stored.get('wss://bob-inbox.example')!.find(e => e.kind === GIFT_WRAP_KIND)!
    expect(JSON.stringify(onRelay)).not.toContain(sent.note.k1)
    expect(JSON.stringify(onRelay)).not.toContain(alice.nostrIdentity()!.pubkey)

    const got = await bob.receiveFromNostr(transport)
    expect(got.received).toHaveLength(1)
    expect(got.received[0]!.note.amountMsat).toBe(20_000)
    expect(got.received[0]!.note.receivedFrom).toBe(alice.nostrIdentity()!.pubkey)
    expect(bob.balanceMsat()).toBe(20_000)
    // Claiming rotated: the wrapped secret is dead on the relay.
    expect(theMint.state.noteState(sent.note.k1)).toBe('burned')
    expect(got.received[0]!.note.k1).not.toBe(sent.note.k1)

    // A second look is idle, and the relay replaying it changes nothing.
    const again = await bob.receiveFromNostr(transport)
    expect(again.received).toHaveLength(0)
    expect(again.skipped).toHaveLength(0)
    expect(bob.balanceMsat()).toBe(20_000)

    // Alice cannot take it back now; reclaim says so and markTaken closes it.
    await expect(alice.reclaim(sent.note)).rejects.toThrow()
    await alice.markTaken(sent.note)
    expect(alice.sentNotes()).toHaveLength(0)
  })

  it('falls back to our own relays, and says so, when the recipient has no inbox list', async () => {
    const theMint = await start()
    const {transport, stored} = fakeRelays()
    const {wallet: alice} = makeWallet()
    await alice.receive(fund(theMint, 50_000))
    await withIdentity(alice, ['wss://a.example'])
    const stranger = identityFromSecret(newIdentitySecretHex())

    const sent = await alice.sendToNostr(transport, 20_000, stranger.pubkey)
    expect(sent.inboxKnown).toBe(false)
    expect(sent.relays).toEqual(['wss://a.example'])
    expect(stored.get('wss://a.example')!.some(e => e.kind === GIFT_WRAP_KIND)).toBe(true)
    // Still reclaimable while unclaimed.
    const back = await alice.reclaim(sent.note)
    expect(back.note.state).toBe('live')
    expect(alice.balanceMsat()).toBe(50_000)
  })

  it('keeps the note reclaimable when every relay refuses the wrap', async () => {
    const theMint = await start()
    const {transport, down} = fakeRelays()
    down.add('wss://a.example')
    const {wallet: alice} = makeWallet()
    await alice.receive(fund(theMint, 50_000))
    await withIdentity(alice, ['wss://a.example'])
    const bob = identityFromSecret(newIdentitySecretHex())
    const sent = await alice.sendToNostr(transport, 20_000, bob.pubkey)
    expect(sent.relays).toEqual([])
    expect(sent.failed).toEqual(['wss://a.example'])
    expect(sent.note.state).toBe('sent')
    expect(alice.sentNotes()).toHaveLength(1)
  })
})

describe('the inbox', () => {
  it('skips what is not ours or not a note, once, and keeps claiming the rest', async () => {
    const theMint = await start()
    const {transport} = fakeRelays()
    const {wallet: bob} = makeWallet()
    const bobId = await withIdentity(bob, ['wss://r.example'])
    const alice = identityFromSecret(newIdentitySecretHex())
    const {nip59} = require('nostr-tools') as typeof import('nostr-tools')
    // A DM, a note already spent, and a good note.
    await transport.publish(['wss://r.example'], nip59.wrapEvent({kind: 14, content: 'hi', tags: [['p', bobId.pubkey]]}, alice.secret, bobId.pubkey))
    const spentUrl = fund(theMint, 5_000)
    const {wallet: other} = makeWallet()
    await other.receive(spentUrl)
    await transport.publish(['wss://r.example'], wrapNote(spentUrl, 5_000, bobId.pubkey, alice))
    const goodUrl = fund(theMint, 7_000)
    await transport.publish(['wss://r.example'], wrapNote(goodUrl, 7_000, bobId.pubkey, alice))

    const got = await bob.receiveFromNostr(transport)
    expect(got.received.map(r => r.note.amountMsat)).toEqual([7_000])
    expect(got.skipped).toHaveLength(2)
    const again = await bob.receiveFromNostr(transport)
    expect(again.received).toHaveLength(0)
    expect(again.skipped).toHaveLength(0)
  })

  it('publishes an inbox list others can find', async () => {
    const {transport} = fakeRelays()
    const {wallet: bob} = makeWallet()
    const bobId = await withIdentity(bob, ['wss://inbox.example'])
    const published = await bob.publishInbox(transport)
    expect(published.ok).toContain('wss://inbox.example')
    const lists = await transport.query(['wss://inbox.example'], {kinds: [INBOX_RELAYS_KIND], authors: [bobId.pubkey]})
    expect(lists).toHaveLength(1)
    expect(lists[0]!.tags).toEqual([['relay', 'wss://inbox.example']])
    expect(getPublicKey(bobId.secret)).toBe(bobId.pubkey)
  })
})

describe('interop with the signer', () => {
  it('opens a wrap the heartwood firmware code sealed', async () => {
    // Written by heartwood-esp32's common/tests/note_wrap_interop.rs from
    // fixed keys; copy it over when that test changes.
    const fixture = (await import('./fixtures/note_wrap_from_device.json', {with: {type: 'json'}})).default as {
      wrap: Event
      sender: string
      recipient_secret: string
      url: string
      amount_msat: number
    }
    const bob = identityFromSecret(fixture.recipient_secret)
    const opened = unwrapNote(fixture.wrap, bob)
    expect(opened.sender).toBe(fixture.sender)
    // The wallet resolves lnurlw:// to the scheme LUD-17 gives it.
    expect(opened.note.noteUrl).toBe(resolveNoteInput(fixture.url))
    expect(noteK1(opened.note.noteUrl)).toBe('cd'.repeat(32))
    expect(opened.note.amountMsat).toBe(fixture.amount_msat)
    expect(opened.note.host).toBe('mint.example/w')
  })

  // The other direction. heartwood's note_wrap_interop.rs opens a wrap this
  // wallet produced, from a fixture frozen in that repo - so if this side's
  // wrap format ever drifts, that test keeps passing against bytes this
  // wallet no longer writes, and the mismatch surfaces on a bench instead
  // of in CI. Asserting the same fixture here is what makes the drift loud.
  it('still writes the wrap the firmware tests itself against', async () => {
    const fixture = (await import('./fixtures/note_wrap_from_wallet.json', {with: {type: 'json'}})).default as {
      wrap: Event
      sender: string
      recipient_secret: string
      url: string
    }
    const bob = identityFromSecret(fixture.recipient_secret)
    const opened = unwrapNote(fixture.wrap, bob)
    expect(opened.sender).toBe(fixture.sender)
    expect(opened.note.noteUrl).toBe(resolveNoteInput(fixture.url))
    expect(noteK1(opened.note.noteUrl)).toBe('ab'.repeat(32))
    expect(opened.note.amountMsat).toBe(21_000)
    expect(opened.note.host).toBe('mint.example/w')

    // And a wrap written now, from the same keys, is one this wallet still
    // reads back identically. The bytes cannot match - a gift wrap is
    // sealed under an ephemeral key with a fuzzed timestamp - so the
    // fixture pins the format and this pins that we still emit it.
    const alice = identityFromSecret('11'.repeat(32))
    const fresh = wrapNote(fixture.url, 21_000, bob.pubkey, alice)
    expect(fresh.kind).toBe(GIFT_WRAP_KIND)
    const reopened = unwrapNote(fresh, bob)
    expect(reopened.sender).toBe(alice.pubkey)
    expect(reopened.note).toEqual(opened.note)
  })
})

// A NIP-05 address is a better thing to hand someone than 63 characters of
// npub, and unlike an npub it can be pointed at a new key later.
describe('resolving a recipient', () => {
  const wellKnown = (names: Record<string, string>): typeof fetch =>
    (async (url: string | URL) => ({
      ok: true,
      status: 200,
      json: async () => {
        const name = new URL(String(url)).searchParams.get('name')
        return {names: name && names[name] ? {[name]: names[name]} : {}}
      }
    })) as unknown as typeof fetch

  const KEY = 'da19f1cd34beca44be74da4b306d9d1dd86b6343cef94ce22c49c6f59816e5bd'

  it('takes an npub, hex or NIP-05', async () => {
    expect(await resolveRecipient(KEY)).toBe(KEY)
    expect(await resolveRecipient(npubOf(KEY))).toBe(KEY)
    expect(await resolveRecipient('alice@example.com', wellKnown({alice: KEY}))).toBe(KEY)
  })

  it('lowercases the address before asking, as NIP-05 requires', async () => {
    expect(await resolveRecipient('ALICE@EXAMPLE.COM', wellKnown({alice: KEY}))).toBe(KEY)
  })

  it('says which part failed rather than a bare throw', async () => {
    await expect(resolveRecipient('nobody@example.com', wellKnown({}))).rejects.toThrow(
      /lists no key for nobody/
    )
    await expect(resolveRecipient('not-an-address')).rejects.toThrow(/npub, a 64-hex/)
  })

  it('refuses a host that answers with something that is not a key', async () => {
    const bad = wellKnown({alice: 'not-hex'})
    await expect(resolveRecipient('alice@example.com', bad)).rejects.toThrow(/lists no key/)
  })
})
