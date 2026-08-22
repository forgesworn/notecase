import {afterEach, describe, expect, it} from 'vitest'
import {createMockMint} from 'lnurlcash-conformance/mock-mint'
import {matchFilter, type Event, type Filter} from 'nostr-tools'
import {MINT_BACKUP_D_TAG, MINT_BACKUP_KIND, decodeMintBackup, mintBackupKey} from '../src/mintbackup.ts'
import type {NostrTransport} from '../src/nostr.ts'
import {makeWallet} from './helpers.ts'
import {hexToBytes} from '@noble/hashes/utils.js'

// Backing the mint LIST up.
//
// Re-deriving note secrets from a seed is the hard half of recovery, and
// the easy half beats it alone: a fresh wallet does not know which mints
// to ask, so twelve words recover nothing without a file. These tests pin
// what travels, what does not, and that a wallet built from words alone
// really does find its way back.

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
        // Addressable: one event per (author, kind, d), newest kept, as a
        // real relay does for kind 30078.
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

/** A wallet with a seed, relays set, and the backup switched on. */
const backedUp = async () => {
  const made = makeWallet()
  made.data.seedHex = SEED
  await made.wallet.setNostrRelays(RELAYS)
  await made.wallet.setMintBackup(true)
  return made
}

/** A wallet that knows nothing but the words. */
const fromWordsAlone = async () => {
  const made = makeWallet()
  made.data.seedHex = SEED
  await made.wallet.setNostrRelays(RELAYS)
  return made
}

describe('the backup key', () => {
  it('is derived from the seed, and is not the wallet identity', async () => {
    const made = await backedUp()
    expect(made.wallet.mintBackupPubkey()).toBe(mintBackupKey(hexToBytes(SEED)).pubkey)

    // The whole point: knowing the holder's npub must not find this.
    const identity = await made.wallet.ensureNostrIdentity()
    expect(made.wallet.mintBackupPubkey()).not.toBe(identity.pubkey)
  })

  it('is the same for the same seed and different for another', () => {
    expect(mintBackupKey(hexToBytes(SEED)).pubkey).toBe(mintBackupKey(hexToBytes(SEED)).pubkey)
    expect(mintBackupKey(hexToBytes(SEED)).pubkey).not.toBe(
      mintBackupKey(hexToBytes('cd'.repeat(32))).pubkey
    )
  })

  it('refuses to switch on for a wallet with no seed', async () => {
    const made = makeWallet()
    await expect(made.wallet.setMintBackup(true)).rejects.toThrow(/no seed/)
  })
})

describe('what travels', () => {
  it('carries the mints, the pins and the default, and is encrypted', async () => {
    const mint = await start()
    const {transport, stored} = fakeRelays()
    const made = await backedUp()
    await made.wallet.addMint(`mint@${hostOf(mint)}`)
    made.data.pubkeyPins[hostOf(mint)] = mint.state.pubkey

    await made.wallet.pushMintBackup(transport)

    const event = stored.get(RELAYS[0]!)![0]!
    expect(event.kind).toBe(MINT_BACKUP_KIND)
    expect(dTag(event)).toBe(MINT_BACKUP_D_TAG)
    // The list must not be readable off the relay.
    expect(event.content).not.toContain(hostOf(mint))

    const payload = decodeMintBackup(mintBackupKey(hexToBytes(SEED)), event)!
    expect(payload.mints.map(m => m.host)).toEqual([hostOf(mint)])
    expect(payload.pins[hostOf(mint)]).toBe(mint.state.pubkey)
    expect(payload.defaultMintHost).toBe(hostOf(mint))
  })

  it('carries no note, no secret and no balance', async () => {
    const mint = await start()
    const {transport, stored} = fakeRelays()
    const made = await backedUp()
    await made.wallet.addMint(`mint@${hostOf(mint)}`)

    const k1 = 'cd'.repeat(32)
    mint.state.creditNote(k1, 21_000)
    await made.wallet.receive(`${mint.url}/w?k1=${k1}&amount=21000`)
    await made.wallet.pushMintBackup(transport)

    const payload = decodeMintBackup(
      mintBackupKey(hexToBytes(SEED)),
      stored.get(RELAYS[0]!)!.find(e => e.kind === MINT_BACKUP_KIND)!
    )!
    const asText = JSON.stringify(payload)
    expect(asText).not.toContain(k1)
    expect(asText).not.toContain('21000')
    expect(asText).not.toContain('notes')
  })

  it('cannot be read by another seed', async () => {
    const mint = await start()
    const {transport, stored} = fakeRelays()
    const made = await backedUp()
    await made.wallet.addMint(`mint@${hostOf(mint)}`)
    await made.wallet.pushMintBackup(transport)

    expect(decodeMintBackup(mintBackupKey(hexToBytes('99'.repeat(32))), stored.get(RELAYS[0]!)![0]!)).toBeNull()
  })
})

describe('when it publishes', () => {
  it('is due after a change and not due again until the next one', async () => {
    const mint = await start()
    const {transport} = fakeRelays()
    const made = await backedUp()
    await made.wallet.addMint(`mint@${hostOf(mint)}`)

    expect(made.wallet.mintBackupNeedsPush()).toBe(true)
    await made.wallet.pushMintBackup(transport)
    expect(made.wallet.mintBackupNeedsPush()).toBe(false)

    made.data.pubkeyPins['other.example'] = '02' + 'ab'.repeat(32)
    expect(made.wallet.mintBackupNeedsPush()).toBe(true)
  })

  it('does not count a push no relay took', async () => {
    const mint = await start()
    const {transport, down} = fakeRelays()
    for (const relay of RELAYS) down.add(relay)
    const made = await backedUp()
    await made.wallet.addMint(`mint@${hostOf(mint)}`)

    expect((await made.wallet.pushMintBackup(transport)).ok).toEqual([])
    // Believing this was published would mean the NEXT change is the first
    // thing anyone ever sees, with these mints silently missing.
    expect(made.wallet.mintBackupNeedsPush()).toBe(true)
  })

  it('is never due while the holder has not asked for it', async () => {
    const mint = await start()
    const made = makeWallet()
    made.data.seedHex = SEED
    await made.wallet.addMint(`mint@${hostOf(mint)}`)
    expect(made.wallet.mintBackupEnabled()).toBe(false)
    expect(made.wallet.mintBackupNeedsPush()).toBe(false)
  })
})

describe('a wallet built from words alone', () => {
  it('finds its mints, its pins and its default', async () => {
    const mint = await start()
    const {transport} = fakeRelays()
    const host = hostOf(mint)

    const first = await backedUp()
    await first.wallet.addMint(`mint@${host}`)
    first.data.pubkeyPins[host] = mint.state.pubkey
    await first.wallet.pushMintBackup(transport)

    const fresh = await fromWordsAlone()
    expect(fresh.data.mints).toEqual([])

    const pulled = await fresh.wallet.pullMintBackup(transport)
    expect(pulled.found).toBe(true)
    expect(pulled.added).toEqual([host])
    expect(pulled.pins).toBe(1)
    expect(fresh.data.pubkeyPins[host]).toBe(mint.state.pubkey)
    expect(fresh.data.settings.defaultMintHost).toBe(host)
  })

  it('says plainly when nothing was ever published', async () => {
    const {transport} = fakeRelays()
    const fresh = makeWallet()
    fresh.data.seedHex = '77'.repeat(32)
    await fresh.wallet.setNostrRelays(RELAYS)
    expect(await fresh.wallet.pullMintBackup(transport)).toEqual({added: [], pins: 0, found: false})
  })

  it('never overwrites a pin it made itself', async () => {
    const mint = await start()
    const {transport} = fakeRelays()
    const host = hostOf(mint)

    const first = await backedUp()
    await first.wallet.addMint(`mint@${host}`)
    first.data.pubkeyPins[host] = '02' + 'aa'.repeat(32)
    await first.wallet.pushMintBackup(transport)

    // A wallet that has already met this mint for itself. Its own first
    // contact is the trusted one; a backup is somebody's earlier copy.
    const second = await fromWordsAlone()
    second.data.pubkeyPins[host] = '03' + 'bb'.repeat(32)

    expect((await second.wallet.pullMintBackup(transport)).pins).toBe(0)
    expect(second.data.pubkeyPins[host]).toBe('03' + 'bb'.repeat(32))
  })
})

// The failure that only showed up by restoring for real, against a live
// relay. Every test above passed while this was broken.
describe('a fresh wallet must not erase the thing it needs', () => {
  it('refuses to publish an emptiness it never had a list to lose', async () => {
    const mint = await start()
    const {transport, stored} = fakeRelays()
    const host = hostOf(mint)

    const first = await backedUp()
    await first.wallet.addMint(`mint@${host}`)
    await first.wallet.pushMintBackup(transport)
    const published = stored.get(RELAYS[0]!)!.length

    // A fresh wallet on the same seed switches the backup on. It knows no
    // mints, and pushing that would replace a good list with nothing at
    // the exact moment the holder needs it.
    const fresh = await fromWordsAlone()
    await fresh.wallet.setMintBackup(true)
    expect((await fresh.wallet.pushMintBackup(transport)).ok).toEqual([])
    expect(stored.get(RELAYS[0]!)!.length).toBe(published)

    // And the list is still there to be found.
    const other = await fromWordsAlone()
    expect((await other.wallet.pullMintBackup(transport)).added).toEqual([host])
  })

  it('looks for a list when switched on, rather than overwriting one', async () => {
    const mint = await start()
    const {transport} = fakeRelays()
    const host = hostOf(mint)

    const first = await backedUp()
    await first.wallet.addMint(`mint@${host}`)
    await first.wallet.pushMintBackup(transport)

    // Switching it on IS the recovery, for a wallet made from words.
    const fresh = await fromWordsAlone()
    await fresh.wallet.setMintBackup(true, transport)
    expect(fresh.data.mints.map(m => m.host)).toEqual([host])
  })

  it('still publishes an empty list once the holder really empties one', async () => {
    const mint = await start()
    const {transport} = fakeRelays()
    const host = hostOf(mint)

    const made = await backedUp()
    await made.wallet.addMint(`mint@${host}`)
    await made.wallet.pushMintBackup(transport)

    // Removing the last mint is a real thing to say, and this wallet has
    // published before, so it is entitled to say it.
    await made.wallet.removeMint(host)
    expect(made.wallet.mintBackupNeedsPush()).toBe(true)
    expect((await made.wallet.pushMintBackup(transport)).ok.length).toBeGreaterThan(0)

    const fresh = await fromWordsAlone()
    const pulled = await fresh.wallet.pullMintBackup(transport)
    expect(pulled.found).toBe(true)
    expect(pulled.added).toEqual([])
  })
})
