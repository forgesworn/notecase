import {afterEach, describe, expect, it} from 'vitest'
import {createFakeBackend, createMoneyer, type Moneyer, type FakeBackend} from '@forgesworn/moneyer'
import {bolt11PaymentHash} from 'farrier-kit/bolt11'
import {bytesToHex, randomBytes} from '@noble/hashes/utils.js'
import {makeWallet} from './helpers.ts'

// Moving value between two mints, which is the one shape a single-mint
// setup cannot test at all. The mints share no state: A pays a real
// invoice B issued, while B credits the wallet-chosen destination secret.
//
// The pair is wired as direct channel peers, which is what moneyer.dev and
// mint.forgesworn.dev actually are - A's funding source settles B's invoice
// and hands back B's settlement preimage, exactly as a one-hop payment would.

type Mint = {moneyer: Moneyer; backend: FakeBackend; host: string; address: string}

const open: Mint[] = []
afterEach(async () => {
  for (const mint of open.splice(0)) await mint.moneyer.close()
})

const startMint = async (
  overrides: Partial<Parameters<typeof createMoneyer>[0]> = {},
  wrap?: (backend: FakeBackend) => FakeBackend
): Promise<Mint> => {
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
      sunset: false,
      ...overrides
    },
    {backend: wrap ? wrap(backend) : backend, confirmDelaysMs: [0, 10]}
  )
  const host = new URL(moneyer.url).host
  const mint = {moneyer, backend, host, address: `mint@${host}`}
  open.push(mint)
  return mint
}

// A's funding source, taught to actually reach B: paying an invoice B
// issued settles it there and brings back B's true preimage.
const peeredWith = (peer: () => Mint | null) => (backend: FakeBackend): FakeBackend => ({
  ...backend,
  async payInvoice(args) {
    const destination = peer()
    const paymentHash = bolt11PaymentHash(args.pr)
    const invoice = paymentHash ? destination?.backend.control.invoiceByHash(paymentHash) : undefined
    if (paymentHash && invoice) {
      destination!.backend.control.settleInvoice(paymentHash)
      backend.control.registerPaymentPreimage(paymentHash, invoice.preimageHex)
    }
    return backend.payInvoice(args)
  }
})

describe('transfer between two mints', () => {
  it('melts at the source to mint at the destination, and the note lands', async () => {
    let destination: Mint | null = null
    const source = await startMint({}, peeredWith(() => destination))
    destination = await startMint()

    const wallet = makeWallet()
    await wallet.wallet.addMint(source.address)
    await wallet.wallet.addMint(destination.address)

    // Fund the source directly: the point under test is the move, not the
    // first mint.
    const {pending: seed} = await wallet.wallet.startMint(60_000, source.host)
    source.backend.control.settleInvoice(seed.id)
    const funded = await wallet.wallet.awaitMint(seed, {timeoutMs: 5_000, intervalMs: 5})
    expect(funded?.note.mintHost).toBe(source.host)
    expect(wallet.wallet.balanceMsat()).toBe(60_000)

    const moved = await wallet.wallet.transfer(20_000, source.host, destination.host, {
      timeoutMs: 5_000,
      intervalMs: 5
    })

    expect(moved.ambiguous).toBe(false)
    expect(moved.result).not.toBeNull()
    expect(moved.result!.note.mintHost).toBe(destination.host)
    expect(moved.result!.note.amountMsat).toBe(20_000)
    // Rotated on arrival, as every claimed note is.
    expect(moved.result!.note.origin).toBe('rotate')

    // Value conserved across the pair: 60k in, 20k moved, both ends agree.
    const atSource = wallet.wallet
      .liveNotes()
      .filter(note => note.mintHost === source.host)
      .reduce((sum, note) => sum + note.amountMsat, 0)
    const atDestination = wallet.wallet
      .liveNotes()
      .filter(note => note.mintHost === destination.host)
      .reduce((sum, note) => sum + note.amountMsat, 0)
    expect(atDestination).toBe(20_000)
    expect(atSource + atDestination).toBe(60_000)
  })

  it('lands the destination fee net, which is what both our mints charge', async () => {
    let destination: Mint | null = null
    const source = await startMint({}, peeredWith(() => destination))
    // 5 sat flat + 0.1%, the shape moneyer.dev actually runs.
    destination = await startMint({mintFee: {baseFeeMsat: 5_000, feePpm: 1_000}})

    const wallet = makeWallet()
    await wallet.wallet.addMint(source.address)
    await wallet.wallet.addMint(destination.address)

    const {pending: seed} = await wallet.wallet.startMint(100_000, source.host)
    source.backend.control.settleInvoice(seed.id)
    await wallet.wallet.awaitMint(seed, {timeoutMs: 5_000, intervalMs: 5})

    const moved = await wallet.wallet.transfer(50_000, source.host, destination.host, {
      timeoutMs: 5_000,
      intervalMs: 5
    })

    expect(moved.fee).toEqual({baseFeeMsat: 5_000, feePpm: 1_000})
    // 50_000 gross, less 5_000 flat, less the 50 msat ppm-part = 44_950 by
    // the exact formula. The mint ceilings the fee to a whole sat, so it
    // keeps 6_000 and the note lands on 44_000 - the floor of the band the
    // wallet quoted, and a whole number of sats, which is the point.
    expect(moved.pending.expectedNetMsat).toBe(44_950)
    expect(moved.pending.minNetMsat).toBe(44_000)
    expect(moved.result!.note.amountMsat).toBe(44_000)
    expect(moved.result!.note.amountMsat % 1000).toBe(0)
    expect(moved.result!.warnings).toEqual([])
    // The source paid the full 50_000; the difference is the destination's
    // fee, not value lost in the wallet.
    expect(moved.melt.amountMsat).toBe(50_000)
  })

  it('leaves no pending mint behind when the source cannot pay', async () => {
    let destination: Mint | null = null
    const source = await startMint({}, peeredWith(() => destination))
    destination = await startMint()

    const wallet = makeWallet()
    await wallet.wallet.addMint(source.address)
    await wallet.wallet.addMint(destination.address)

    // Nothing at the source, so the melt refuses definitively and burns
    // nothing. The invoice we asked the destination for can then never be
    // paid, and a pending mint left 'awaiting' would make the wallet
    // report an unresolved outcome that reconcile has no answer for.
    await expect(
      wallet.wallet.transfer(10_000, source.host, destination.host)
    ).rejects.toThrow()
    expect(wallet.data.pendingMints).toEqual([])
    expect(wallet.wallet.needsReconcile()).toBe(false)
  })

  it('refuses a transfer to the mint it came from', async () => {
    const only = await startMint()
    const wallet = makeWallet()
    await wallet.wallet.addMint(only.address)
    await expect(wallet.wallet.transfer(1_000, only.host, only.host)).rejects.toThrow(
      /two different mints/
    )
  })

  it('transfers to a destination without verify because the wallet already holds the mint secret', async () => {
    let destination: Mint | null = null
    const source = await startMint({}, peeredWith(() => destination))
    // No LUD-21 verify. Current minting is comment-bound, so Notecase polls
    // the named note rather than waiting for a payment preimage.
    destination = await startMint({verify: false})

    const wallet = makeWallet()
    await wallet.wallet.addMint(source.address)
    await wallet.wallet.addMint(destination.address)

    const {pending: seed} = await wallet.wallet.startMint(30_000, source.host)
    source.backend.control.settleInvoice(seed.id)
    await wallet.wallet.awaitMint(seed, {timeoutMs: 5_000, intervalMs: 5})
    expect(wallet.wallet.balanceMsat()).toBe(30_000)

    const moved = await wallet.wallet.transfer(10_000, source.host, destination.host, {
      timeoutMs: 5_000,
      intervalMs: 5
    })
    expect(moved.ambiguous).toBe(false)
    expect(moved.result?.note.mintHost).toBe(destination.host)
    expect(moved.result?.note.amountMsat).toBe(10_000)
    expect(wallet.wallet.balanceMsat()).toBe(30_000)
  })
})

// The fee-rounding question, from the wallet's side. dni's lnurl-mint
// ceilings its fee to a whole sat; moneyer is msat-exact. A wallet that
// predicts one number tells the holder the other mint short-changed them.
// The fee-rounding question, from the wallet's side. dni's lnurl-mint
// ceilings its fee to a whole sat; moneyer is msat-exact. A wallet that
// predicts one number tells the holder the other mint short-changed them.
describe('a mint that ceilings its fee to a whole sat', () => {
  it('lands inside the band without warning, as the reference does', async () => {
    let destination: Mint | null = null
    const source = await startMint({}, peeredWith(() => destination))
    // mint.forgesworn.dev's real advertised fee. 40_000 gross gives a
    // 1_040 msat fee, which the reference ceilings to 2_000.
    destination = await startMint({
      mintFee: {baseFeeMsat: 1000, feePpm: 1000},
      roundFeeToSat: true
    })

    const wallet = makeWallet()
    await wallet.wallet.addMint(source.address)
    await wallet.wallet.addMint(destination.address)

    const {pending: seed} = await wallet.wallet.startMint(100_000, source.host)
    source.backend.control.settleInvoice(seed.id)
    await wallet.wallet.awaitMint(seed, {timeoutMs: 5_000, intervalMs: 5})

    const moved = await wallet.wallet.transfer(40_000, source.host, destination.host, {
      timeoutMs: 5_000,
      intervalMs: 5
    })

    // Exactly what mint.forgesworn.dev credited on 2026-08-21.
    expect(moved.result!.note.amountMsat).toBe(38_000)
    expect(moved.pending.expectedNetMsat).toBe(38_960)
    expect(moved.pending.minNetMsat).toBe(38_000)
    // The mint did what it documents, so the wallet says nothing.
    expect(moved.result!.warnings).toEqual([])
  })
})
