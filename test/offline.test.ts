import {afterEach, describe, expect, it} from 'vitest'
import {createMockMint} from 'lnurlcash-conformance/mock-mint'
import {NoteSpentError} from 'lnurlcash-kit'
import {BadSignatureError, InsufficientFundsError, WalletUsageError} from '../src/wallet.ts'
import {freshK1, makeWallet} from './helpers.ts'

// The offline cash drawer. LUD-25's offline story assumes the payer can
// hand over the right amount without touching the mint and the receiver
// can take it on a signature; neither is possible with one big note, so
// this is about keeping change and spending it with nothing on the wire.

type Mint = Awaited<ReturnType<typeof createMockMint>>
let mint: Mint | null = null
const start = async (options: Record<string, unknown> = {}): Promise<Mint> => {
  mint = await createMockMint(options)
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

const hostOf = (theMint: Mint): string => new URL(theMint.url).host

describe('the cash drawer', () => {
  it('cuts what is missing, costs what it quoted, and does nothing the second time', async () => {
    const theMint = await start({baseFeeMsat: 5_000})
    const {wallet} = makeWallet()
    await wallet.addMint(`mint@${hostOf(theMint)}`)
    await wallet.setLadder(hostOf(theMint), [10, 20], 2)
    await wallet.receive(fund(theMint, 100_000))

    const plan = wallet.ladderPlan(hostOf(theMint))
    expect(plan.cut).toEqual([20_000, 20_000, 10_000, 10_000])
    expect(plan.feeMsat).toBe(20_000)
    expect(plan.short).toEqual([])

    const before = wallet.balanceMsat()
    const done = await wallet.prepareOffline(hostOf(theMint))
    expect(done.made).toHaveLength(4)
    expect(done.feeMsat).toBe(plan.feeMsat)
    // the fee quoted before is the fee taken
    expect(before - wallet.balanceMsat()).toBe(plan.feeMsat)
    expect(
      wallet
        .liveNotes()
        .map(note => note.amountMsat)
        .sort((a, b) => a - b)
    ).toEqual([10_000, 10_000, 20_000, 20_000, 20_000])

    // re-runnable: the drawer is full, so a second run cuts nothing
    const again = await wallet.prepareOffline(hostOf(theMint))
    expect(again.made).toEqual([])
    expect(again.feeMsat).toBe(0)
  })

  it('says which denominations nothing is big enough to cut', async () => {
    const theMint = await start({baseFeeMsat: 5_000})
    const {wallet} = makeWallet()
    await wallet.addMint(`mint@${hostOf(theMint)}`)
    await wallet.setLadder(hostOf(theMint), [10, 500], 1)
    await wallet.receive(fund(theMint, 30_000))

    const plan = wallet.ladderPlan(hostOf(theMint))
    expect(plan.cut).toEqual([10_000])
    expect(plan.short).toEqual([500_000])
  })
})

describe('handing notes over offline', () => {
  const stocked = async () => {
    const theMint = await start()
    const {wallet} = makeWallet()
    await wallet.addMint(`mint@${hostOf(theMint)}`)
    for (const amount of [10_000, 20_000, 50_000]) await wallet.receive(fund(theMint, amount))
    return {theMint, wallet}
  }

  it('picks an exact subset and touches no mint at all', async () => {
    const {theMint, wallet} = await stocked()
    const before = theMint.state.notes.size
    const handed = await wallet.sendOffline(30_000)

    expect(handed.totalMsat).toBe(30_000)
    expect(handed.overpayMsat).toBe(0)
    expect(handed.notes.map(note => note.amountMsat).sort((a, b) => a - b)).toEqual([10_000, 20_000])
    expect(handed.notes.every(note => note.state === 'sent' && note.sentOffline === true)).toBe(true)
    expect(handed.urls).toHaveLength(2)
    expect(handed.urls.every(url => url.includes('sig='))).toBe(true)
    expect(wallet.balanceMsat()).toBe(50_000)
    // nothing was minted, burned or asked about
    expect(theMint.state.notes.size).toBe(before)
    for (const note of handed.notes) expect(theMint.state.noteState(note.k1)).toBe('outstanding')
  })

  it('refuses an amount no notes make exactly, and names the overpay', async () => {
    const {wallet} = await stocked()
    await expect(wallet.sendOffline(15_000)).rejects.toThrow(WalletUsageError)
    const plan = wallet.planOfflineSend(15_000)
    expect(plan.totalMsat).toBe(20_000)
    expect(plan.overpayMsat).toBe(5_000)
    // and nothing was handed over by asking
    expect(wallet.balanceMsat()).toBe(80_000)

    const handed = await wallet.sendOffline(15_000, undefined, {acceptOverpay: true})
    expect(handed.totalMsat).toBe(20_000)
    expect(wallet.balanceMsat()).toBe(60_000)
  })

  it('refuses when the case simply does not hold enough', async () => {
    const {wallet} = await stocked()
    await expect(wallet.sendOffline(500_000)).rejects.toThrow(InsufficientFundsError)
  })
})

describe('taking a note offline', () => {
  it('refuses a mint this wallet has never spoken to', async () => {
    const theMint = await start()
    const sender = makeWallet()
    await sender.wallet.receive(fund(theMint, 21_000))
    const handed = await sender.wallet.sendOffline(21_000)

    const stranger = makeWallet()
    await expect(stranger.wallet.receiveOffline(handed.urls[0]!)).rejects.toThrow(WalletUsageError)
    expect(stranger.data.notes).toHaveLength(0)
  })

  it('refuses a note whose signature does not verify', async () => {
    const theMint = await start()
    const {wallet} = makeWallet()
    await wallet.receive(fund(theMint, 21_000))
    const k1 = freshK1()
    const signature = theMint.state.creditNote(k1, 5_000)!
    const tampered = `${signature.slice(0, -2)}${signature.slice(-2) === 'ff' ? '00' : 'ff'}`
    await expect(
      wallet.receiveOffline(`${theMint.url}/w?k1=${k1}&amount=5000&sig=${tampered}`)
    ).rejects.toThrow(BadSignatureError)
  })

  it('refuses a note carrying no signature to check', async () => {
    const theMint = await start()
    const {wallet} = makeWallet()
    await wallet.receive(fund(theMint, 21_000))
    await expect(wallet.receiveOffline(fund(theMint, 5_000))).rejects.toThrow(WalletUsageError)
  })

  it('takes it on the signature, keeps it unrotated, and rotates on the next reconcile', async () => {
    const theMint = await start()
    const sender = makeWallet()
    await sender.wallet.receive(fund(theMint, 50_000))
    const handed = await sender.wallet.sendOffline(50_000)

    const taker = makeWallet()
    // one online receive pins the mint's key; that pin is what makes an
    // offline check possible at all
    await taker.wallet.receive(fund(theMint, 1_000))
    const before = theMint.state.notes.size

    const taken = await taker.wallet.receiveOffline(handed.urls[0]!)
    expect(taken.note.amountMsat).toBe(50_000)
    expect(taken.note.unrotated).toBe(true)
    expect(taken.warnings.some(warning => warning.includes('still knows the secret'))).toBe(true)
    expect(taker.wallet.balanceMsat()).toBe(51_000)
    expect(taker.wallet.unrotatedMsat()).toBe(50_000)
    expect(taker.wallet.needsReconcile()).toBe(true)
    // still nothing on the wire
    expect(theMint.state.notes.size).toBe(before)
    expect(theMint.state.noteState(taken.note.k1)).toBe('outstanding')

    const events = await taker.wallet.reconcile()
    expect(events.some(event => event.kind === 'offline-note-rotated')).toBe(true)
    expect(theMint.state.noteState(taken.note.k1)).toBe('burned')
    expect(taker.wallet.unrotatedMsat()).toBe(0)
    expect(taker.wallet.balanceMsat()).toBe(51_000)
    expect(taker.wallet.needsReconcile()).toBe(false)

    // and the giver finds out the money is gone the moment they ask
    await expect(sender.wallet.reclaim(handed.notes[0]!)).rejects.toThrow(NoteSpentError)
    await sender.wallet.markTaken(handed.notes[0]!)
    expect(sender.wallet.balanceMsat()).toBe(0)
  })

  it('stops counting an offline note the giver spent first, and settles it', async () => {
    const theMint = await start()
    const sender = makeWallet()
    await sender.wallet.receive(fund(theMint, 50_000))
    const handed = await sender.wallet.sendOffline(50_000)

    const taker = makeWallet()
    await taker.wallet.receive(fund(theMint, 1_000))
    const taken = await taker.wallet.receiveOffline(handed.urls[0]!)
    // the giver kept a copy and spent it before the taker got online
    theMint.state.settleMelt(taken.note.k1)

    // The mint's "already spent" is also what it would say to a repeat of
    // a rotate that had gone through, so the first pass parks it rather
    // than believing either story, and the money stops being counted.
    await taker.wallet.reconcile()
    expect(taken.note.state).toBe('ambiguous')
    expect(taker.wallet.balanceMsat()).toBe(1_000)

    // The second pass probes and settles it: the note really is burned.
    await taker.wallet.reconcile()
    expect(taken.note.state).toBe('spent')
    expect(taker.wallet.balanceMsat()).toBe(1_000)
  })

  it('says plainly when a note from a mint it holds nothing else of is already gone', async () => {
    const theMint = await start()
    const sender = makeWallet()
    await sender.wallet.receive(fund(theMint, 50_000))
    const handed = await sender.wallet.sendOffline(50_000)

    // A taker holding a pin for this mint but no note of it: there is no
    // callback to borrow, so reconcile has to ask the mint for one - and
    // that is where it finds out the note is gone.
    const taker = makeWallet()
    taker.data.pubkeyPins[hostOf(theMint)] = theMint.state.pubkey
    const taken = await taker.wallet.receiveOffline(handed.urls[0]!)
    expect(taken.note.callback).toBe('')
    theMint.state.settleMelt(taken.note.k1)

    const events = await taker.wallet.reconcile()
    expect(events.some(event => event.kind === 'offline-note-lost')).toBe(true)
    expect(taken.note.state).toBe('spent')
    expect(taken.note.detail).toContain('spent it first')
    expect(taker.wallet.balanceMsat()).toBe(0)
  })

  it('is swept by the check like any other note', async () => {
    const theMint = await start()
    const sender = makeWallet()
    await sender.wallet.receive(fund(theMint, 50_000))
    const handed = await sender.wallet.sendOffline(50_000)

    const taker = makeWallet()
    await taker.wallet.receive(fund(theMint, 1_000))
    const taken = await taker.wallet.receiveOffline(handed.urls[0]!)
    theMint.state.settleMelt(taken.note.k1)

    const report = await taker.wallet.checkNotes()
    expect(report.spent.map(note => note.id)).toEqual([taken.note.id])
  })
})
