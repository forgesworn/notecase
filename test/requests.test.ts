import {afterEach, describe, expect, it} from 'vitest'
import {createMockMint} from 'lnurlcash-conformance/mock-mint'
import {matchFilter, type Event, type Filter} from 'nostr-tools'
import {decodePaymentRequest, isPaymentRequest} from 'lnurlcash-kit'
import {WalletUsageError} from '../src/wallet.ts'
import {buildNoteRumor, type NostrTransport} from '../src/nostr.ts'
import {freshK1, makeWallet} from './helpers.ts'

// Payment requests.
//
// "Send me 500 sat, at one of these mints." The payer scans it, cuts a
// note to the exact amount and gift-wraps it; the payee matches the note
// back to what they asked for. Neither side touches a lightning address.

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

const RELAYS = ['wss://relay.one']

const fakeRelays = (): {transport: NostrTransport} => ({
  transport: (() => {
    const stored: Event[] = []
    return {
      subscribe: () => ({close() {}}),
      async query(_relays, filter: Filter) {
        return stored.filter(e => matchFilter(filter, e))
      },
      async publish(relays, event) {
        stored.push(event)
        return {ok: [...relays], failed: []}
      },
      close() {}
    } satisfies NostrTransport
  })()
})

const hostOf = (mint: Mint): string => new URL(mint.url).host

/** A wallet at `mint`, with `amountMsat` in it and Nostr ready. */
const funded = async (mint: Mint, amountMsat: number) => {
  const made = makeWallet()
  await made.wallet.setNostrRelays(RELAYS)
  await made.wallet.addMint(`mint@${hostOf(mint)}`)
  if (amountMsat > 0) {
    const k1 = freshK1()
    mint.state.creditNote(k1, amountMsat)
    await made.wallet.receive(`${mint.url}/w?k1=${k1}&amount=${amountMsat}`)
  }
  return made
}

describe('asking for money', () => {
  it('encodes something a payer can read, naming this wallet and its mints', async () => {
    const mint = await start()
    const payee = await funded(mint, 0)

    const request = await payee.wallet.createRequest({amountMsat: 21_000, memo: 'lunch'})
    expect(isPaymentRequest(request.encoded)).toBe(true)

    const decoded = decodePaymentRequest(request.encoded)
    expect(decoded.amount).toBe('21')
    expect(decoded.currency).toBe('sat')
    expect(decoded.memo).toBe('lunch')
    expect(decoded.methodDetails.mints).toEqual([hostOf(mint)])
    // The payee's own npub, so the note has somewhere to go.
    expect(decoded.to).toMatch(/^npub1/)
    expect(payee.wallet.requests()[0]!.state).toBe('open')
  })

  it('will not ask for a fraction of a sat, or for nothing', async () => {
    const mint = await start()
    const payee = await funded(mint, 0)
    // The wire carries whole sats. Rounding would ask for one figure and
    // show another.
    await expect(payee.wallet.createRequest({amountMsat: 21_500})).rejects.toThrow(/whole number of sats/)
    await expect(payee.wallet.createRequest({amountMsat: 0})).rejects.toThrow(/positive amount/)
  })

  it('will not ask before there is anywhere to be paid at', async () => {
    const made = makeWallet()
    await expect(made.wallet.createRequest({amountMsat: 21_000})).rejects.toThrow(/Add a mint first/)
  })
})

describe('paying one', () => {
  it('sends a note of the exact amount, and the payee matches it back', async () => {
    const mint = await start()
    const {transport} = fakeRelays()
    const payee = await funded(mint, 0)
    const payer = await funded(mint, 100_000)

    const request = await payee.wallet.createRequest({amountMsat: 21_000, memo: 'lunch'})
    const paid = await payer.wallet.payRequest(transport, request.encoded)

    expect(paid.note.amountMsat).toBe(21_000)
    expect(paid.note.requestId).toBe(request.id)
    expect(paid.note.memo).toBe('lunch')
    // Change stayed put rather than being sent along.
    expect(payer.wallet.balanceMsat()).toBe(79_000)

    const collected = await payee.wallet.receiveFromNostr(transport)
    expect(collected.received).toHaveLength(1)
    const note = collected.received[0]!.note
    expect(note.amountMsat).toBe(21_000)
    expect(note.memo).toBe('lunch')
    expect(note.requestId).toBe(request.id)

    const settled = payee.wallet.requestById(request.id)!
    expect(settled.state).toBe('paid')
    expect(settled.paidBy).toBe(note.id)
    expect(payee.wallet.balanceMsat()).toBe(21_000)
  })

  it('says which problem it is when it cannot pay', async () => {
    const mint = await start()
    const elsewhere = await start()
    const {transport} = fakeRelays()
    const payee = await funded(mint, 0)
    const request = await payee.wallet.createRequest({amountMsat: 21_000})

    // No account at that mint at all - a different problem from having no
    // money there, and a different fix.
    const stranger = await funded(elsewhere, 100_000)
    await expect(stranger.wallet.payRequest(transport, request.encoded)).rejects.toThrow(/add one of those mints/)

    // Right mint, nothing in it.
    const broke = await funded(mint, 1_000)
    await expect(broke.wallet.payRequest(transport, request.encoded)).rejects.toThrow(/transfer some there first/)
  })

  it('refuses an expired request rather than sending into the void', async () => {
    const mint = await start()
    const {transport} = fakeRelays()
    const payee = await funded(mint, 0)
    const payer = await funded(mint, 100_000)

    const request = await payee.wallet.createRequest({amountMsat: 21_000, expiresInSecs: 1})
    await new Promise(resolve => setTimeout(resolve, 1100))
    await expect(payer.wallet.payRequest(transport, request.encoded)).rejects.toThrow(/expired/)
    expect(payer.wallet.balanceMsat()).toBe(100_000)
  })

  it('refuses something that is not a request', async () => {
    const mint = await start()
    const {transport} = fakeRelays()
    const payer = await funded(mint, 100_000)
    await expect(payer.wallet.payRequest(transport, 'lnurlcashreq1nonsense')).rejects.toThrow(WalletUsageError)
    expect(payer.wallet.balanceMsat()).toBe(100_000)
  })
})

describe('a request id is somebody else\'s claim', () => {
  it('settles nothing when it names no request of ours', async () => {
    const mint = await start()
    const {transport} = fakeRelays()
    const payee = await funded(mint, 0)
    const payer = await funded(mint, 100_000)

    const mine = await payee.wallet.createRequest({amountMsat: 21_000})
    // A note arrives naming a request this wallet never made.
    await payer.wallet.sendToNostr(transport, 21_000, (await payee.wallet.ensureNostrIdentity()).npub, undefined, {
      requestId: 'ff'.repeat(8)
    })

    const collected = await payee.wallet.receiveFromNostr(transport)
    expect(collected.received).toHaveLength(1)
    // The note is money and is kept; the claim about it is simply not ours.
    expect(payee.wallet.balanceMsat()).toBe(21_000)
    expect(payee.wallet.requestById(mine.id)!.state).toBe('open')
  })

  it('does not re-settle one already paid', async () => {
    const mint = await start()
    const {transport} = fakeRelays()
    const payee = await funded(mint, 0)
    const payer = await funded(mint, 100_000)

    const request = await payee.wallet.createRequest({amountMsat: 21_000})
    await payer.wallet.payRequest(transport, request.encoded)
    await payee.wallet.receiveFromNostr(transport)
    const firstNote = payee.wallet.requestById(request.id)!.paidBy

    // Somebody pays it again. The money is welcome; the request was
    // already answered, and the record of what answered it must not move.
    await payer.wallet.payRequest(transport, request.encoded)
    await payee.wallet.receiveFromNostr(transport)
    expect(payee.wallet.requestById(request.id)!.paidBy).toBe(firstNote)
    expect(payee.wallet.balanceMsat()).toBe(42_000)
  })

  it('ignores a request id that is not one, rather than storing whatever arrived', async () => {
    const mint = await start()
    const {transport} = fakeRelays()
    const payee = await funded(mint, 0)
    const payer = await funded(mint, 100_000)

    // 16 lowercase hex is the whole shape. Anything else is not an id this
    // wallet ever issued, so it is not carried as one.
    await payer.wallet.sendToNostr(transport, 21_000, (await payee.wallet.ensureNostrIdentity()).npub, undefined, {
      requestId: '../../etc/passwd'
    })
    const collected = await payee.wallet.receiveFromNostr(transport)
    expect(collected.received[0]!.note.requestId).toBeUndefined()
    // Still money, still kept.
    expect(payee.wallet.balanceMsat()).toBe(21_000)
  })

  it('bounds a memo, because it is prose from a stranger', async () => {
    const mint = await start()
    const {transport} = fakeRelays()
    const payee = await funded(mint, 0)
    const payer = await funded(mint, 100_000)

    await payer.wallet.sendToNostr(transport, 21_000, (await payee.wallet.ensureNostrIdentity()).npub, undefined, {
      memo: 'x'.repeat(5_000)
    })
    const collected = await payee.wallet.receiveFromNostr(transport)
    expect(collected.received[0]!.note.memo!.length).toBe(280)
  })
})

describe('the hardware signer', () => {
  it('sees a rumor whose extra tags it can simply ignore', () => {
    // The device reads `content` and looks tags up by name, so an unknown
    // tag is one it never sees. Checked against its parser before these
    // tags were added; pinned here so a reshuffle cannot break it quietly.
    const rumor = buildNoteRumor('lnurlw://mint.example/w?k1=' + 'ab'.repeat(32), 21_000, 'cd'.repeat(32), {
      requestId: 'ff'.repeat(8),
      memo: 'lunch'
    })
    expect(rumor.content).toBe('lnurlw://mint.example/w?k1=' + 'ab'.repeat(32))
    // The three the device does read, in the places it reads them.
    expect(rumor.tags![0]).toEqual(['p', 'cd'.repeat(32)])
    expect(rumor.tags!.find(t => t[0] === 'amount')).toEqual(['amount', '21000'])
    // And the new ones, appended after.
    expect(rumor.tags!.find(t => t[0] === 'req')).toEqual(['req', 'ff'.repeat(8)])
    expect(rumor.tags!.find(t => t[0] === 'memo')).toEqual(['memo', 'lunch'])
  })

  it('carries no extra tags when there is nothing extra to say', () => {
    const rumor = buildNoteRumor('lnurlw://mint.example/w?k1=' + 'ab'.repeat(32), 21_000, 'cd'.repeat(32))
    expect(rumor.tags!.map(t => t[0])).toEqual(['p', 'amount', 'u'])
  })
})
