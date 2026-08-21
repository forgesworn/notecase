import {afterEach, describe, expect, it} from 'vitest'
import {createFakeBackend, createMoneyer, type Moneyer, type FakeBackend} from '@forgesworn/moneyer'
import {bolt11PaymentHash} from 'farrier-kit/bolt11'
import {bytesToHex, randomBytes} from '@noble/hashes/utils.js'
import {makeWallet} from './helpers.ts'

// Moving value between two mints, which is the one shape a single-mint
// setup cannot test at all. The mints share no state: A pays a real
// invoice B issued, and B's payment preimage is the note that lands.
//
// The pair is wired as direct channel peers, which is what moneyer.dev and
// mint.forgesworn.dev actually are - A's funding source settles B's invoice
// and hands back B's own preimage, exactly as a one-hop payment would.

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
    // 50_000 gross, less 5_000 flat, less 50 ppm-part = 44_950.
    expect(moved.pending.expectedNetMsat).toBe(44_950)
    expect(moved.result!.note.amountMsat).toBe(44_950)
    expect(moved.result!.warnings).toEqual([])
    // The source paid the full 50_000; the difference is the destination's
    // fee, not value lost in the wallet.
    expect(moved.melt.amountMsat).toBe(50_000)
  })

  it('refuses a transfer to the mint it came from', async () => {
    const only = await startMint()
    const wallet = makeWallet()
    await wallet.wallet.addMint(only.address)
    await expect(wallet.wallet.transfer(1_000, only.host, only.host)).rejects.toThrow(
      /two different mints/
    )
  })

  it('will not burn a note for a destination that cannot hand back the preimage', async () => {
    let destination: Mint | null = null
    const source = await startMint({}, peeredWith(() => destination))
    // No LUD-21 verify: nothing could ever learn the preimage, and the
    // preimage IS the note.
    destination = await startMint({verify: false})

    const wallet = makeWallet()
    await wallet.wallet.addMint(source.address)
    await wallet.wallet.addMint(destination.address)

    const {pending: seed} = await wallet.wallet.startMint(30_000, source.host)
    source.backend.control.settleInvoice(seed.id)
    await wallet.wallet.awaitMint(seed, {timeoutMs: 5_000, intervalMs: 5})
    expect(wallet.wallet.balanceMsat()).toBe(30_000)

    await expect(
      wallet.wallet.transfer(10_000, source.host, destination.host)
    ).rejects.toThrow(/no LUD-21 verify/)
    // Nothing was burned at the source.
    expect(wallet.wallet.balanceMsat()).toBe(30_000)
  })
})
