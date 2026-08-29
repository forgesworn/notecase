import {afterEach, describe, expect, it} from 'vitest'
import {createMockMint} from 'lnurlcash-conformance/mock-mint'
import {InsufficientFundsError, WalletUsageError} from '../src/wallet.ts'
import {fakeBolt11} from '@forgesworn/moneyer'
import {freshK1, makeWallet} from './helpers.ts'

// Choosing which notes to spend.
//
// The wallet picks for you by default, and that is right for almost every
// payment. But notes are visible objects with histories - one came from a
// stranger, one is the change from something else - and a holder who wants
// to spend a particular one should be able to say so. What must not happen
// is being quietly overruled: a selection that cannot work is refused, with
// the reason, rather than silently swapped for one that can.

type Mint = Awaited<ReturnType<typeof createMockMint>>
const open: Mint[] = []
const start = async (): Promise<Mint> => {
  const mint = await createMockMint()
  open.push(mint)
  return mint
}
afterEach(async () => {
  for (const mint of open.splice(0)) await mint.close()
})

const fund = async (made: ReturnType<typeof makeWallet>, mint: Mint, msat: number) => {
  const k1 = freshK1()
  mint.state.creditNote(k1, msat)
  const received = await made.wallet.receive(`${mint.url}/w?k1=${k1}&amount=${msat}`)
  return received.note
}

describe('spending notes the holder chose', () => {
  it('splits the chosen note and leaves the others alone', async () => {
    const mint = await start()
    const made = makeWallet()
    await made.wallet.addMint(`mint@${new URL(mint.url).host}`)
    const keep = await fund(made, mint, 40_000)
    const spend = await fund(made, mint, 60_000)

    const prepared = await made.wallet.prepareExactFrom(25_000, [spend.id])

    expect(prepared.amountMsat).toBe(25_000)
    expect(prepared.state).toBe('live')
    // The one not chosen was not touched, even though the wallet's own
    // picker would have reached for it first as the smaller note.
    expect(made.wallet.noteById(keep.id)?.state).toBe('live')
    expect(made.wallet.noteById(spend.id)?.state).toBe('spent')
    expect(made.wallet.balanceMsat()).toBe(100_000)
  })

  it('combines several chosen notes when one is not enough', async () => {
    const mint = await start()
    const made = makeWallet()
    await made.wallet.addMint(`mint@${new URL(mint.url).host}`)
    const a = await fund(made, mint, 20_000)
    const b = await fund(made, mint, 20_000)
    const spare = await fund(made, mint, 90_000)

    const prepared = await made.wallet.prepareExactFrom(30_000, [a.id, b.id])

    expect(prepared.amountMsat).toBe(30_000)
    expect(made.wallet.noteById(spare.id)?.state).toBe('live')
    expect(made.wallet.balanceMsat()).toBe(130_000)
  })

  it('refuses a selection that is short, rather than reaching for another note', async () => {
    const mint = await start()
    const made = makeWallet()
    await made.wallet.addMint(`mint@${new URL(mint.url).host}`)
    const small = await fund(made, mint, 10_000)
    const plenty = await fund(made, mint, 90_000)

    await expect(made.wallet.prepareExactFrom(50_000, [small.id])).rejects.toThrow(InsufficientFundsError)
    // Being overruled without being told is worse than being refused: the
    // note the holder did not choose is untouched.
    expect(made.wallet.noteById(plenty.id)?.state).toBe('live')
    expect(made.wallet.noteById(small.id)?.state).toBe('live')
    expect(made.wallet.balanceMsat()).toBe(100_000)
  })

  it('refuses a note that is not spendable, and an empty choice', async () => {
    const mint = await start()
    const made = makeWallet()
    await made.wallet.addMint(`mint@${new URL(mint.url).host}`)
    const note = await fund(made, mint, 50_000)

    await expect(made.wallet.prepareExactFrom(10_000, [])).rejects.toThrow(/at least one note/)
    await expect(made.wallet.prepareExactFrom(10_000, ['00'.repeat(32)])).rejects.toThrow(WalletUsageError)

    const sent = await made.wallet.send(10_000)
    await expect(made.wallet.prepareExactFrom(5_000, [sent.id])).rejects.toThrow(/sent/)
    expect(made.wallet.noteById(note.id)?.state).toBe('spent')
  })

  it('refuses notes from two different mints', async () => {
    const one = await start()
    const two = await start()
    const made = makeWallet()
    await made.wallet.addMint(`mint@${new URL(one.url).host}`)
    await made.wallet.addMint(`mint@${new URL(two.url).host}`)
    const here = await fund(made, one, 50_000)
    const there = await fund(made, two, 50_000)

    await expect(made.wallet.prepareExactFrom(60_000, [here.id, there.id])).rejects.toThrow(
      /different mints/
    )
    expect(made.wallet.balanceMsat()).toBe(100_000)
  })

  it('melts from a chosen note, spending it and not the other', async () => {
    const mint = await start()
    const made = makeWallet()
    await made.wallet.addMint(`mint@${new URL(mint.url).host}`)
    const keep = await fund(made, mint, 40_000)
    const spend = await fund(made, mint, 60_000)

    const pr = fakeBolt11({amountMsat: 21_000, paymentHashHex: freshK1()})
    await made.wallet.melt(pr, 'invoice', undefined, {noteIds: [spend.id]})

    // The chosen note funded it; the other is exactly as it was.
    expect(made.wallet.noteById(keep.id)?.state).toBe('live')
    expect(made.wallet.noteById(spend.id)?.state).toBe('spent')
    // 40k untouched + 39k change from the 60k, with 21k in flight
    expect(made.wallet.balanceMsat()).toBe(79_000)
    expect(made.data.melts).toHaveLength(1)
    expect(made.data.melts[0]!.amountMsat).toBe(21_000)
  })
})

// Offline the choice means something stronger. With no mint in the loop
// nothing can be cut to size, so the notes ticked are not a pool to search
// within - they are the hand-over itself. What that costs the payer is
// theirs to see and accept before anything leaves the wallet.
describe('handing over notes the holder chose, offline', () => {
  it('hands over exactly those notes and leaves the rest alone', async () => {
    const mint = await start()
    const made = makeWallet()
    await made.wallet.addMint(`mint@${new URL(mint.url).host}`)
    const keep = await fund(made, mint, 10_000)
    const a = await fund(made, mint, 20_000)
    const b = await fund(made, mint, 30_000)

    const handed = await made.wallet.sendOffline(50_000, undefined, {noteIds: [a.id, b.id]})

    expect(handed.notes.map(note => note.id).sort()).toEqual([a.id, b.id].sort())
    expect(handed.totalMsat).toBe(50_000)
    expect(handed.overpayMsat).toBe(0)
    expect(handed.urls).toHaveLength(2)
    // The wallet's own search would have taken the 10k and 20k and 30k in
    // whatever order it liked; the small note is untouched.
    expect(made.wallet.noteById(keep.id)?.state).toBe('live')
    expect(made.wallet.noteById(a.id)?.state).toBe('sent')
    expect(made.wallet.noteById(b.id)?.state).toBe('sent')
    expect(made.wallet.balanceMsat()).toBe(10_000)
  })

  it('shows what a chosen hand-over overpays, and refuses until that is accepted', async () => {
    const mint = await start()
    const made = makeWallet()
    await made.wallet.addMint(`mint@${new URL(mint.url).host}`)
    const exact = await fund(made, mint, 20_000)
    const big = await fund(made, mint, 50_000)

    // Nothing is committed by asking.
    const plan = made.wallet.planOfflineSend(20_000, undefined, [big.id])
    expect(plan.totalMsat).toBe(50_000)
    expect(plan.overpayMsat).toBe(30_000)
    expect(made.wallet.noteById(big.id)?.state).toBe('live')

    // And the refusal names both figures, rather than quietly reaching for
    // the note that happens to make the amount exactly.
    await expect(made.wallet.sendOffline(20_000, undefined, {noteIds: [big.id]})).rejects.toThrow(
      /50000 msat.*30000 msat more/
    )
    expect(made.wallet.noteById(exact.id)?.state).toBe('live')
    expect(made.wallet.noteById(big.id)?.state).toBe('live')

    const handed = await made.wallet.sendOffline(20_000, undefined, {noteIds: [big.id], acceptOverpay: true})
    expect(handed.totalMsat).toBe(50_000)
    expect(made.wallet.noteById(exact.id)?.state).toBe('live')
  })

  it('refuses a chosen hand-over that is short, rather than adding a note to it', async () => {
    const mint = await start()
    const made = makeWallet()
    await made.wallet.addMint(`mint@${new URL(mint.url).host}`)
    const small = await fund(made, mint, 10_000)
    const plenty = await fund(made, mint, 90_000)

    await expect(made.wallet.sendOffline(50_000, undefined, {noteIds: [small.id]})).rejects.toThrow(
      InsufficientFundsError
    )
    expect(made.wallet.noteById(small.id)?.state).toBe('live')
    expect(made.wallet.noteById(plenty.id)?.state).toBe('live')
    expect(made.wallet.balanceMsat()).toBe(100_000)
  })

  it('hands over a note that has never met its mint', async () => {
    // A note taken offline is stored unrotated: the mint has not been
    // spoken to, so there is no callback on it yet. Passing it straight on
    // asks the mint for nothing either, so it must not be refused here -
    // splitting it would be, and is.
    const mint = await start()
    const made = makeWallet()
    await made.wallet.addMint(`mint@${new URL(mint.url).host}`)
    const note = await fund(made, mint, 40_000)
    made.wallet.noteById(note.id)!.callback = ''

    await expect(made.wallet.prepareExactFrom(10_000, [note.id])).rejects.toThrow(/met its mint/)

    const handed = await made.wallet.sendOffline(40_000, undefined, {noteIds: [note.id]})
    expect(handed.totalMsat).toBe(40_000)
    expect(made.wallet.noteById(note.id)?.state).toBe('sent')
  })

  it('refuses a chosen hand-over spread across two mints', async () => {
    const one = await start()
    const two = await start()
    const made = makeWallet()
    await made.wallet.addMint(`mint@${new URL(one.url).host}`)
    await made.wallet.addMint(`mint@${new URL(two.url).host}`)
    const here = await fund(made, one, 30_000)
    const there = await fund(made, two, 30_000)

    await expect(
      made.wallet.sendOffline(60_000, undefined, {noteIds: [here.id, there.id]})
    ).rejects.toThrow(/different mints/)
    expect(made.wallet.balanceMsat()).toBe(60_000)
  })
})

// Folding several notes into one, as an end in itself.
//
// prepareExactFrom already merges, but only on the way to cutting an amount
// to hand over. A case that has accumulated nine notes off nine bits of
// change wants the same merge with nothing on the other side of it: fewer,
// larger notes cost fewer rotates to keep fresh, and the mint refunds the
// base fee it charged on each split that made them.
describe('combining notes the holder chose', () => {
  // LUD-25 bounds a merge by URL length, and mints cap the k1 count besides
  // (moneyer at 21 by default). Folding a large hand in one request builds
  // something the mint refuses, or that a proxy truncates into a malformed
  // one. It must be folded in batches instead.
  it('folds a hand too large for one request', async () => {
    const mint = await start()
    // A local server happily accepts a 2000+ character URL, so the mock
    // cannot show this bug. What matters is what goes on the wire: real
    // proxies truncate, and mints cap the k1 count besides.
    const sent: string[] = []
    const spyFetch: typeof fetch = (input, init) => {
      sent.push(input.toString())
      return fetch(input as string, init)
    }
    const made = makeWallet({fetch: spyFetch})
    await made.wallet.addMint(`mint@${new URL(mint.url).host}`)
    const notes = []
    for (let i = 0; i < 30; i++) notes.push(await fund(made, mint, 2_000))
    const before = made.wallet.balanceMsat()
    sent.length = 0

    const one = await made.wallet.combine(notes.map(n => n.id))

    const longest = Math.max(...sent.map(u => u.length))
    expect(longest).toBeLessThanOrEqual(2000)
    const widest = Math.max(
      ...sent.map(u => (u.match(/[?&]k1=/g) ?? []).length)
    )
    expect(widest).toBeLessThanOrEqual(20)

    expect(one.state).toBe('live')
    expect(one.origin).toBe('merge')
    // Nothing is lost to the batching: every input is spent, one note is
    // live, and the wallet is worth what it was plus the merge refunds.
    expect(made.wallet.balanceMsat()).toBeGreaterThanOrEqual(before)
    for (const n of notes) {
      expect(made.data.notes.find(r => r.id === n.id)?.state).toBe('spent')
    }
    expect(made.data.notes.filter(r => r.state === 'live').length).toBe(1)
  })

  it('folds several notes into one and refunds a base fee for each merged away', async () => {
    const mint = await start()
    const made = makeWallet()
    await made.wallet.addMint(`mint@${new URL(mint.url).host}`)
    const a = await fund(made, mint, 20_000)
    const b = await fund(made, mint, 30_000)
    const c = await fund(made, mint, 40_000)
    const spare = await fund(made, mint, 15_000)
    const before = made.wallet.balanceMsat()

    const one = await made.wallet.combine([a.id, b.id, c.id])

    expect(one.state).toBe('live')
    expect(one.origin).toBe('merge')
    // Three in, one out: the two base fees those splits paid come back, so
    // the note is worth AT LEAST the sum and never less than it.
    expect(one.amountMsat).toBeGreaterThanOrEqual(90_000)
    expect(made.wallet.balanceMsat()).toBeGreaterThanOrEqual(before)
    for (const gone of [a, b, c]) expect(made.wallet.noteById(gone.id)?.state).toBe('spent')
    // The note nobody chose is exactly where it was.
    expect(made.wallet.noteById(spare.id)?.state).toBe('live')
    expect(made.wallet.noteById(spare.id)?.amountMsat).toBe(15_000)
  })

  it('refuses one note, an empty choice, and a note that is not in the wallet', async () => {
    const mint = await start()
    const made = makeWallet()
    await made.wallet.addMint(`mint@${new URL(mint.url).host}`)
    const only = await fund(made, mint, 50_000)

    await expect(made.wallet.combine([])).rejects.toThrow(/at least one note/)
    await expect(made.wallet.combine([only.id])).rejects.toThrow(/at least two notes/)
    await expect(made.wallet.combine([only.id, '00'.repeat(32)])).rejects.toThrow(WalletUsageError)
    // Refused means untouched, not half-done.
    expect(made.wallet.noteById(only.id)?.state).toBe('live')
    expect(made.wallet.balanceMsat()).toBe(50_000)
  })

  it('refuses notes from two different mints, and a note already handed over', async () => {
    const one = await start()
    const two = await start()
    const made = makeWallet()
    await made.wallet.addMint(`mint@${new URL(one.url).host}`)
    await made.wallet.addMint(`mint@${new URL(two.url).host}`)
    const here = await fund(made, one, 50_000)
    const there = await fund(made, two, 50_000)

    await expect(made.wallet.combine([here.id, there.id])).rejects.toThrow(/different mints/)
    expect(made.wallet.balanceMsat()).toBe(100_000)

    const keep = await fund(made, one, 40_000)
    const spend = await fund(made, one, 40_000)
    // drawn from `spend` on purpose, so `keep` is still live and the only
    // thing wrong with the pair below is the state of the other one
    const sent = await made.wallet.send(10_000, undefined, [spend.id])
    await expect(made.wallet.combine([keep.id, sent.id])).rejects.toThrow(/sent/)
    expect(made.wallet.noteById(keep.id)?.state).toBe('live')
  })
})
