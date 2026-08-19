import {afterEach, describe, expect, it} from 'vitest'
import {createFakeBackend, createMoneyer, fakeBolt11, type Moneyer, type FakeBackend} from '@forgesworn/moneyer'
import {bolt11PaymentHash} from 'farrier-kit/bolt11'
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
const startMint = async () => {
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
    // the claim rotated: the preimage the payer's wallet saw is dead
    expect(moneyer.store.noteById(pending.id)?.state).toBe('burned')
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
})
