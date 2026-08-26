import {afterEach, describe, expect, it} from 'vitest'
import {createFakeBackend, createMoneyer, fakeBolt11, type Moneyer, type FakeBackend} from '@forgesworn/moneyer'
import {bolt11PaymentHash} from 'farrier-kit/bolt11'
import {fetchInvoiceVerification} from 'lnurlcash-kit'
import {bytesToHex, randomBytes} from '@noble/hashes/utils.js'
import {sha256} from '@noble/hashes/sha2.js'
import {hexToBytes} from '@noble/hashes/utils.js'
import {payWithNwc} from '../src/nwc.ts'
import {createFakeNwcWallet} from './nwc-fake.ts'
import {makeWallet} from './helpers.ts'

// The whole ForgeSworn stack in one room: notecase (this wallet) against
// moneyer (our mint), with an NWC wallet on the side paying and receiving
// - every library in the dogfood matrix exercised end to end, value
// conserved at every step, both sides' books balancing.

let mint: {moneyer: Moneyer; backend: FakeBackend} | null = null
const startMint = async (overrides: {mintFee?: {baseFeeMsat: number; feePpm: number}} = {}) => {
  const backend = createFakeBackend()
  const moneyer = await createMoneyer(
    {
      host: '127.0.0.1',
      port: 0,
      username: 'mint',
      description: 'an LNURLcash note',
      minSendableMsat: 1000,
      maxSendableMsat: 100_000_000,
      minMintMsat: 1000,
      mintFee: null,
      ...overrides,
      signingKey: bytesToHex(randomBytes(32)),
      dbPath: ':memory:',
      backend: {kind: 'fake'},
      verify: true,
      maxK1s: 21,
      sunset: false
    },
    {backend, confirmDelaysMs: [0, 10]}
  )
  mint = {moneyer, backend}
  return mint
}
afterEach(async () => {
  await mint?.moneyer.close()
  mint = null
})

describe('notecase against moneyer', () => {
  it('runs the full circle: NWC-paid mint, send, receive, melt back to NWC', async () => {
    const {moneyer, backend} = await startMint()
    const mintAddress = `mint@${new URL(moneyer.url).host}`

    // The NWC wallet "pays" mint invoices by settling them at moneyer's
    // funding source and handing back the true preimage, exactly as a real
    // Lightning payment would.
    const nwc = createFakeNwcWallet({
      payInvoice: ({invoice}) => {
        const paymentHash = bolt11PaymentHash(invoice)!
        backend.control.settleInvoice(paymentHash)
        const preimage = backend.control.invoiceByHash(paymentHash)!.preimageHex
        return {preimage, fees_paid: 0}
      },
      makeInvoice: ({amount, description}) => {
        const preimage = bytesToHex(randomBytes(32))
        const paymentHash = bytesToHex(sha256(hexToBytes(preimage)))
        backend.control.registerPaymentPreimage(paymentHash, preimage)
        return {
          type: 'incoming',
          invoice: fakeBolt11({amountMsat: amount, paymentHashHex: paymentHash, ...(description ? {memo: description} : {})}),
          payment_hash: paymentHash,
          amount
        }
      },
      getBalance: () => ({balance: 1_000_000})
    })

    // --- Alice mints 50k msat, paying through NWC ---
    const alice = makeWallet()
    await alice.wallet.addMint(mintAddress)
    const {pending} = await alice.wallet.startMint(50_000)
    const paid = await payWithNwc(nwc.uri, pending.pr, {transport: nwc.transport})
    const minted = await alice.wallet.claimMint(pending, paid.preimageHex)
    expect(minted.note.amountMsat).toBe(50_000)
    expect(minted.note.state).toBe('live')
    expect(alice.wallet.balanceMsat()).toBe(50_000)

    // --- Alice sends 20k to Bob ---
    const sent = await alice.wallet.send(20_000)
    expect(alice.wallet.balanceMsat()).toBe(30_000)

    const bob = makeWallet()
    const received = await bob.wallet.receive(alice.wallet.noteUrlFor(sent))
    expect(received.note.amountMsat).toBe(20_000)
    expect(received.warnings).toEqual([])
    expect(bob.wallet.balanceMsat()).toBe(20_000)

    // Alice can no longer reclaim what Bob rotated.
    await expect(alice.wallet.receive(alice.wallet.noteUrlFor(sent))).rejects.toThrow()

    // --- Bob melts his 20k into his NWC wallet ---
    const {invoiceFromNwc} = await import('../src/nwc.ts')
    const invoice = await invoiceFromNwc(nwc.uri, 20_000, 'bob cashes out', {transport: nwc.transport})
    const {melt} = await bob.wallet.melt(invoice.pr, 'nwc')
    expect(melt.state).toBe('in-flight')

    // moneyer pays asynchronously; give it a beat, then reconcile.
    await new Promise(resolve => setTimeout(resolve, 100))
    const events = await bob.wallet.reconcile()
    expect(events.some(event => event.kind === 'melt-settled')).toBe(true)
    expect(bob.wallet.balanceMsat()).toBe(0)
    // the melt proof round-tripped: the mint's verify served the true
    // preimage of the invoice the NWC wallet issued
    expect(bob.wallet.data.melts[0]!.proofPreimage).toBeDefined()

    // --- the books balance ---
    // Alice holds 30k of notes; everything else left the mint's liability.
    expect(alice.wallet.balanceMsat()).toBe(30_000)
    expect(moneyer.store.outstandingLiabilityMsat()).toBe(30_000)

    // The NWC conversation really happened over the wire ceremony.
    expect(nwc.requests.map(request => request.method)).toContain('pay_invoice')
    expect(nwc.requests.map(request => request.method)).toContain('make_invoice')
  })

  it('claims a manually paid mint through LUD-21 polling', async () => {
    const {moneyer, backend} = await startMint()
    const wallet = makeWallet()
    await wallet.wallet.addMint(`mint@${new URL(moneyer.url).host}`)

    const {pending} = await wallet.wallet.startMint(21_000)
    // someone pays the invoice out of band
    backend.control.settleInvoice(pending.id)
    const result = await wallet.wallet.awaitMint(pending, {timeoutMs: 5_000, intervalMs: 20})
    expect(result).not.toBeNull()
    expect(result!.note.amountMsat).toBe(21_000)
    expect(wallet.wallet.balanceMsat()).toBe(21_000)
    // The note was named at quote time, so the payment preimage was never
    // a note here at all - not one that got burned on claim, one the mint
    // never credited. Which is the point: the mint publishes that preimage
    // to anyone holding the invoice.
    expect(pending.namedK1).toBeDefined()
    expect(moneyer.store.noteById(pending.id)).toBeFalsy()
  })

  it('recovers a melt moneyer restores after a failed payment', async () => {
    const {moneyer, backend} = await startMint()
    const wallet = makeWallet()
    await wallet.wallet.addMint(`mint@${new URL(moneyer.url).host}`)

    const {pending} = await wallet.wallet.startMint(21_000)
    backend.control.settleInvoice(pending.id)
    await wallet.wallet.awaitMint(pending, {timeoutMs: 5_000, intervalMs: 20})

    backend.control.setPayMode('fail-clean')
    const pr = fakeBolt11({amountMsat: 21_000, paymentHashHex: bytesToHex(randomBytes(32))})
    await wallet.wallet.melt(pr, 'invoice')
    expect(wallet.wallet.balanceMsat()).toBe(0)

    await new Promise(resolve => setTimeout(resolve, 100))
    const events = await wallet.wallet.reconcile()
    expect(events.some(event => event.kind === 'melt-returned')).toBe(true)
    expect(wallet.wallet.balanceMsat()).toBe(21_000)
    expect(moneyer.store.outstandingLiabilityMsat()).toBe(21_000)
  })

  // The mint keeps whole sats: LUD-25 says nothing about rounding, and both
  // moneyer and dni's reference mint ceiling the fee, which is the LOW end
  // of what the advertised formula allows. A wallet that quotes the other
  // end promises a holder more than it can hand over. This is the arithmetic
  // that used to disagree, run against the mint itself rather than a model
  // of it.
  it('is credited the floor of the fee band, not the hope', async () => {
    // The live posture: 1 sat plus 0.2%, which on this amount leaves the
    // fee 300 msat short of a whole sat and forces the question.
    const {moneyer, backend} = await startMint({mintFee: {baseFeeMsat: 1000, feePpm: 2000}})
    const wallet = makeWallet()
    await wallet.wallet.addMint(`mint@${new URL(moneyer.url).host}`)

    const {pending} = await wallet.wallet.startMint(150_000)
    expect(pending.expectedNetMsat).toBe(148_700)
    expect(pending.minNetMsat).toBe(148_000)

    backend.control.settleInvoice(pending.id)
    const claimed = await wallet.wallet.awaitMint(pending, {timeoutMs: 5_000, intervalMs: 20})

    // What the mint actually credited. Showing expectedNetMsat would have
    // been a 700 msat lie told to the holder before they paid.
    expect(claimed?.note.amountMsat).toBe(pending.minNetMsat)
    expect(claimed!.note.amountMsat).toBeLessThan(pending.expectedNetMsat)
    expect(claimed!.note.amountMsat % 1000).toBe(0)
    expect(moneyer.store.outstandingLiabilityMsat()).toBe(claimed!.note.amountMsat)
  })

  it('states one figure when the fee lands on a whole sat anyway', async () => {
    // Nothing to hedge about here: 1 sat flat on any amount is already
    // whole, so both ends of the band agree and the wallet must not
    // manufacture a range out of it.
    const {moneyer, backend} = await startMint({mintFee: {baseFeeMsat: 1000, feePpm: 0}})
    const wallet = makeWallet()
    await wallet.wallet.addMint(`mint@${new URL(moneyer.url).host}`)

    const {pending} = await wallet.wallet.startMint(150_000)
    expect(pending.minNetMsat).toBe(pending.expectedNetMsat)

    backend.control.settleInvoice(pending.id)
    const claimed = await wallet.wallet.awaitMint(pending, {timeoutMs: 5_000, intervalMs: 20})
    expect(claimed?.note.amountMsat).toBe(149_000)
  })
})

// LUD-25 lets a wallet name the note it is buying, and a mint that honours
// it credits that hash instead of the payment preimage. It matters more
// than it looks: leave the note unnamed and its k1 IS the preimage, which
// the mint publishes at a LUD-21 verify URL anyone holding the invoice can
// build from its payment hash.
describe('naming the note being minted', () => {
  it('mints to a secret the mint never sees, and the preimage buys nothing', async () => {
    const {moneyer, backend} = await startMint()
    const alice = makeWallet()
    await alice.wallet.addMint(`mint@${new URL(moneyer.url).host}`)

    // no seed on this wallet: naming does not need one, and most wallets
    // in the wild do not have one
    const {pending} = await alice.wallet.startMint(50_000)
    expect(pending.namedK1).toBeDefined()
    expect(pending.namedIndex).toBeUndefined()

    backend.control.settleInvoice(bolt11PaymentHash(pending.pr)!)

    // Claimed with no preimage at all.
    const minted = await alice.wallet.claimMint(pending)
    expect(minted.note.amountMsat).toBe(50_000)
    // receive() rotates on arrival, so the note the wallet ends up holding
    // is a further secret again - the named one was only ever the handover
    expect(alice.wallet.balanceMsat()).toBe(50_000)

    // And the preimage the mint publishes to anyone holding the invoice is
    // worth nothing here: it is not this note, and never was.
    const verification = await fetchInvoiceVerification(pending.verifyUrl!)
    expect(verification.settled).toBe(true)
    const bob = makeWallet()
    await expect(
      bob.wallet.receive(`${pending.baseUrl}?k1=${verification.preimage}`)
    ).rejects.toThrow()
  })

  it('leaves the counter past the named index, so nothing reuses it', async () => {
    const {moneyer} = await startMint()
    const alice = makeWallet()
    const host = new URL(moneyer.url).host
    await alice.wallet.addMint(`mint@${host}`)

    const first = await alice.wallet.startMint(50_000)
    const second = await alice.wallet.startMint(50_000)
    expect(first.pending.namedK1).not.toBe(second.pending.namedK1)
    expect(host).toBeTruthy()
  })
})
