import {afterEach, describe, expect, it} from 'vitest'
import {createMockMint} from 'lnurlcash-conformance/mock-mint'
import {mintFeeBand} from 'lnurlcash-kit'
import {makeWallet} from './helpers.ts'

// What a mint says about itself.
//
// All of it is the operator's own words arriving over the wire, so the
// wallet's job is to carry it faithfully, show it as a claim, and never
// let it become a fact the wallet appears to vouch for. The discovery
// endpoint is optional and experimental, so a mint that publishes nothing
// - or cannot be reached at all - must be no worse to use than before.

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

const hostOf = (mint: Mint): string => new URL(mint.url).host

const INFO = {
  name: 'The Mock Mint',
  description: 'a mint that exists to be tested against',
  contact: {nostr: 'npub1mock', email: 'ops@mock.example', url: 'https://mock.example'},
  tosUrl: 'https://mock.example/terms',
  motd: 'Scheduled maintenance on Sunday.',
  version: '9.9.9'
}

describe('what a mint says about itself', () => {
  it('is read on add and kept', async () => {
    const mint = await start(INFO)
    const {wallet, data} = makeWallet()
    await wallet.addMint(`mint@${hostOf(mint)}`)

    const entry = data.mints[0]!
    expect(entry.info?.name).toBe(INFO.name)
    expect(entry.info?.description).toBe(INFO.description)
    expect(entry.info?.contact?.nostr).toBe(INFO.contact.nostr)
    expect(entry.info?.contact?.email).toBe(INFO.contact.email)
    expect(entry.info?.tosUrl).toBe(INFO.tosUrl)
    expect(entry.info?.motd).toBe(INFO.motd)
    expect(entry.info?.version).toBe(INFO.version)
  })

  it('takes the structured fee over parsing the payRequest prose', async () => {
    const mint = await start({baseFeeMsat: 1000, feePpm: 5000})
    const {wallet, data} = makeWallet()
    await wallet.addMint(`mint@${hostOf(mint)}`)
    expect(data.mints[0]!.mintFee).toEqual({baseFeeMsat: 1000, feePpm: 5000})
  })

  it('leaves an unset field absent rather than empty', async () => {
    // A holder reading "contact: " learns less than nothing.
    const mint = await start({name: 'Just A Name'})
    const {wallet, data} = makeWallet()
    await wallet.addMint(`mint@${hostOf(mint)}`)

    const info = data.mints[0]!.info!
    expect(info.name).toBe('Just A Name')
    expect('contact' in info).toBe(false)
    expect('motd' in info).toBe(false)
    expect('tosUrl' in info).toBe(false)
  })

  it('adds a mint that publishes nothing about itself, all the same', async () => {
    const mint = await start()
    const {wallet, data} = makeWallet()
    await expect(wallet.addMint(`mint@${hostOf(mint)}`)).resolves.toBeDefined()
    expect(data.mints).toHaveLength(1)
    // The mock always serves a description, so the absent thing to assert
    // is the one nobody set.
    expect(data.mints[0]!.info?.motd).toBeUndefined()
  })

  it('adds a mint whose discovery endpoint cannot be reached at all', async () => {
    // The endpoint is optional. Adding a mint must not turn on whether an
    // experimental extra answered.
    const mint = await start()
    const {wallet, data} = makeWallet({
      fetch: async (input, init) => {
        const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url)
        if (url.pathname.startsWith('/.well-known/lnurlw/')) throw new Error('no such endpoint')
        return fetch(input, init)
      }
    })
    await expect(wallet.addMint(`mint@${hostOf(mint)}`)).resolves.toBeDefined()
    expect(data.mints).toHaveLength(1)
    expect(data.mints[0]!.info).toBeUndefined()
  })
})

describe('the message of the day', () => {
  it('is unread once, then read, until the words change', async () => {
    const mint = await start(INFO)
    const {wallet} = makeWallet()
    const host = hostOf(mint)
    await wallet.addMint(`mint@${host}`)

    expect(wallet.unreadMotds()).toEqual([{host, motd: INFO.motd, name: INFO.name}])

    await wallet.markMotdSeen(host)
    expect(wallet.unreadMotds()).toEqual([])
    // Marking twice is not a way to make it unread again.
    await wallet.markMotdSeen(host)
    expect(wallet.unreadMotds()).toEqual([])
  })

  it('comes back when the mint actually changes it', async () => {
    const mint = await start(INFO)
    const {wallet, data} = makeWallet()
    const host = hostOf(mint)
    await wallet.addMint(`mint@${host}`)
    await wallet.markMotdSeen(host)
    expect(wallet.unreadMotds()).toEqual([])

    // The operator posts something new.
    data.mints[0]!.info!.motd = 'The maintenance is finished.'
    expect(wallet.unreadMotds()).toEqual([
      {host, motd: 'The maintenance is finished.', name: INFO.name}
    ])
  })

  it('is not re-interrupted by re-adding the same mint', async () => {
    const mint = await start(INFO)
    const {wallet} = makeWallet()
    const host = hostOf(mint)
    await wallet.addMint(`mint@${host}`)
    await wallet.markMotdSeen(host)

    await wallet.addMint(`mint@${host}`)
    expect(wallet.unreadMotds()).toEqual([])
  })

  it('reports a fresh one from a refresh, and nothing when it is unchanged', async () => {
    const mint = await start(INFO)
    const {wallet} = makeWallet()
    const host = hostOf(mint)
    await wallet.addMint(`mint@${host}`)

    expect((await wallet.refreshMintInfo(host)).freshMotd).toBe(INFO.motd)
    await wallet.markMotdSeen(host)
    expect((await wallet.refreshMintInfo(host)).freshMotd).toBeUndefined()
  })
})

describe('a notice reaches a holder who is not looking for it', () => {
  it('arrives on the regular reconcile, and is said once', async () => {
    const mint = await start(INFO)
    const {wallet} = makeWallet()
    const host = hostOf(mint)
    await wallet.addMint(`mint@${host}`)
    await wallet.markMotdSeen(host)

    // Nothing new: a reconcile must not re-announce what has been read.
    const quiet = await wallet.reconcile()
    expect(quiet.some(event => event.kind === 'mint-notice')).toBe(false)
  })

  it('carries a changed notice without the holder running anything', async () => {
    const mint = await start(INFO)
    const host = hostOf(mint)

    // The operator posts something new, on the wire. Without the reconcile
    // refresh the wallet would only ever see this if somebody asked for it
    // by hand, which is not how a message of the day is meant to work.
    let motd = INFO.motd
    const {wallet} = makeWallet({
      fetch: async (input, init) => {
        const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url)
        const response = await fetch(input, init)
        if (!url.pathname.startsWith('/.well-known/lnurlw/')) return response
        return Response.json({...((await response.json()) as Record<string, unknown>), motd})
      }
    })
    await wallet.addMint(`mint@${host}`)
    await wallet.markMotdSeen(host)
    expect(wallet.unreadMotds()).toEqual([])

    motd = 'The maintenance is finished.'
    const events = await wallet.reconcile()

    expect(events.some(event => event.kind === 'mint-notice')).toBe(true)
    expect(events.find(event => event.kind === 'mint-notice')!.detail).toContain(
      'The maintenance is finished.'
    )
    expect(wallet.unreadMotds()).toHaveLength(1)
  })
})

// What a mint will credit, said without over-promising.
//
// LUD-25 does not say whether a mint rounds its fee, so a wallet can only
// bound the answer: the msat-exact figure at one end, the sat-ceilinged
// one at the other. moneyer and the reference both ceiling now, which is
// the LOW end - so a wallet leading with the optimistic figure tells its
// holder they will get more than they will, and then hands over less.
describe('predicting what a mint will credit', () => {
  it('bounds it at both ends when the fee has a fraction of a sat in it', () => {
    // 150000 - 1000 - 300 = 148700 exact; 150000 - 2000 = 148000 ceilinged.
    const band = mintFeeBand(150_000, {baseFeeMsat: 1000, feePpm: 2000})
    expect(band.maxNetMsat).toBe(148_700)
    expect(band.minNetMsat).toBe(148_000)
    expect(band.minNetMsat).toBeLessThan(band.maxNetMsat)
  })

  it('collapses to one figure when there is nothing to round', () => {
    const band = mintFeeBand(150_000, {baseFeeMsat: 1000, feePpm: 0})
    expect(band.minNetMsat).toBe(band.maxNetMsat)
    expect(band.maxNetMsat).toBe(149_000)
    // Nothing to hedge about, so the wallet states the figure flatly.
  })

  it('never promises more than a fee-free mint would give', () => {
    const band = mintFeeBand(150_000, {baseFeeMsat: 0, feePpm: 0})
    expect(band.minNetMsat).toBe(150_000)
    expect(band.maxNetMsat).toBe(150_000)
  })
})
