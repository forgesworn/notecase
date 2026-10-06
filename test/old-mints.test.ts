import {afterEach, describe, expect, it} from 'vitest'
import {createFakeBackend, createMoneyer, fakeBolt11} from '@forgesworn/moneyer'
import {createFakeBackend as createLegacyFakeBackend, createMoneyer as createLegacyMoneyer} from 'moneyer-legacy'
import {createMockMint as createLegacyMockMint} from 'lnurlcash-conformance-0-13/mock-mint'
import {bytesToHex, randomBytes} from '@noble/hashes/utils.js'
import {
  NoteSpentError,
  buildNoteUrl,
  fetchNoteInfo,
  hashK1,
  isCs1WithAmount,
  noteSignature,
  mergeNotesWithHash,
  probeBurnedNote,
  requestInvoice,
  rotateNoteWithHash,
  splitNoteWithHash
} from '../src/lnurlcash.js'
import {freshK1, makeWallet, waitMs} from './helpers.ts'

// Every bearer-note operation, against every mint generation still in
// service. LUD-25 renamed its wire forms on 29 Sep 2026 (`h` became `p`,
// `p1`/`p2`; certificates moved from `sig` over h to `c` = cs1<amount> over
// the note's Q; a mint quote is named by `comment`), and mints did not all
// move at once:
//
//   - moneyer 0.17: the current protocol. Reads `p`/`p1`/`p2` and their
//     older names, looks a note up by `k1` or `p`, certifies with `c`.
//   - moneyer 0.3.1: before it. Looks a note up only by `k1`, reads only
//     `h`/`h2` on its callback, binds a quote only by `h` (and silently mints
//     to the payment preimage without one), certifies with `sig` = hex over h.
//   - lnurlcash-conformance 0.13.1's mock mint: the protocol the reference lnurl-mint
//     still speaks. Lookups by `k1` only, `h`/`h2` on the callback, a quote
//     named by a 64-hex `comment` and nothing else, `sig` over h.
//
// Nothing is mocked but the Lightning node behind each moneyer.

type Generation = 'moneyer 0.17' | 'moneyer 0.3.1' | 'conformance 0.13.1 mock'

type TestMint = {
  generation: Generation
  legacy: boolean
  url: string
  host: string
  close: () => Promise<void>
  // Brings a note worth amountMsat into existence under k1, the way a
  // wallet of the mint's own generation buys one.
  issue: (k1: string, amountMsat: number) => Promise<void>
  // Pays a mint invoice, by its payment hash.
  settle: (paymentHash: string) => Promise<void>
}

let open: TestMint | null = null
afterEach(async () => {
  await open?.close()
  open = null
})

const moneyerConfig = () => ({
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
  backend: {kind: 'fake' as const},
  verify: true,
  maxK1s: 21,
  sunset: false
})

const startMint = async (generation: Generation): Promise<TestMint> => {
  let mint: TestMint
  if (generation === 'moneyer 0.17') {
    const backend = createFakeBackend()
    const moneyer = await createMoneyer(moneyerConfig(), {backend, confirmDelaysMs: [0, 10]})
    mint = {
      generation,
      legacy: false,
      url: moneyer.url,
      host: new URL(moneyer.url).host,
      close: () => moneyer.close(),
      issue: async (k1, amountMsat) => {
        const quote = (await (
          await fetch(`${moneyer.url}/p/cb?amount=${amountMsat}&comment=${hashK1(k1)}`)
        ).json()) as {pr: string; verify: string}
        backend.control.settleInvoice(quote.verify.split('/').pop()!)
      },
      settle: async paymentHash => backend.control.settleInvoice(paymentHash)
    }
  } else if (generation === 'moneyer 0.3.1') {
    const backend = createLegacyFakeBackend()
    const moneyer = await createLegacyMoneyer(moneyerConfig(), {backend, confirmDelaysMs: [0, 10]})
    mint = {
      generation,
      legacy: true,
      url: moneyer.url,
      host: new URL(moneyer.url).host,
      close: () => moneyer.close(),
      issue: async (k1, amountMsat) => {
        const quote = (await (
          await fetch(`${moneyer.url}/p/cb?amount=${amountMsat}&h=${hashK1(k1)}`)
        ).json()) as {pr: string; verify: string}
        backend.control.settleInvoice(quote.verify.split('/').pop()!)
      },
      settle: async paymentHash => backend.control.settleInvoice(paymentHash)
    }
  } else {
    const mock = await createLegacyMockMint({testHooks: true})
    mint = {
      generation,
      legacy: true,
      url: mock.url,
      host: new URL(mock.url).host,
      close: () => mock.close(),
      issue: async (k1, amountMsat) => {
        mock.state.creditNote(k1, amountMsat)
      },
      settle: async paymentHash => {
        await fetch(`${mock.url}/_test/settle?payment_hash=${paymentHash}`)
      }
    }
  }
  open = mint
  return mint
}

// A note somebody hands this wallet, bare: just its k1 and amount.
const bareNote = async (mint: TestMint, amountMsat: number): Promise<{url: string; k1: string}> => {
  const k1 = freshK1()
  await mint.issue(k1, amountMsat)
  return {url: `${mint.url}/w?k1=${k1}&amount=${amountMsat}`, k1}
}

// A note carrying the certificate its mint gives, as a wallet of the mint's
// own generation would hold it: rotated once at the mint by hand, in the
// mint's own vocabulary, and handed on with what the mint answered. An old
// mint's `sig` travels as `sig` beside `amount`; a current mint's `c` as `c`.
const certifiedNote = async (mint: TestMint, amountMsat: number): Promise<{url: string; k1: string}> => {
  const first = await bareNote(mint, amountMsat)
  const k1 = freshK1()
  const callback = new URL(`${mint.url}/w/cb`)
  callback.searchParams.set('k1', first.k1)
  callback.searchParams.set(mint.legacy ? 'h' : 'p1', hashK1(k1))
  const body = (await (await fetch(callback)).json()) as {status: string; sig?: string; c?: string}
  expect(body.status).toBe('OK')
  const url = new URL(`${mint.url}/w`)
  url.searchParams.set('k1', k1)
  if (mint.legacy) {
    expect(body.sig).toMatch(/^[0-9a-f]{130}$/)
    url.searchParams.set('amount', String(amountMsat))
    url.searchParams.set('sig', body.sig!)
  } else {
    expect(isCs1WithAmount(body.c!)).toBe(true)
    url.searchParams.set('c', body.c!)
  }
  return {url: url.toString(), k1}
}

// Asked by the note's own k1, the one lookup every generation answers.
const stillLive = async (mint: TestMint, k1: string): Promise<boolean> =>
  (await probeBurnedNote(`${mint.url}/w?k1=${k1}`)) === 'live'

const GENERATIONS: Generation[] = ['moneyer 0.17', 'moneyer 0.3.1', 'conformance 0.13.1 mock']

describe.each(GENERATIONS)('a wallet at a %s', generation => {
  it('looks a note up, live and then spent', async () => {
    const mint = await startMint(generation)
    const note = await bareNote(mint, 21_000)
    const info = await fetchNoteInfo(note.url)
    expect(info.maxWithdrawable).toBe(21_000)
    expect(await probeBurnedNote(note.url)).toBe('live')

    const {wallet} = makeWallet()
    await wallet.receive(note.url)
    await expect(fetchNoteInfo(note.url)).rejects.toBeInstanceOf(NoteSpentError)
    expect(await probeBurnedNote(note.url)).toBe('gone')
  })

  it('rotates, splits and merges on the wire, naming each output so the mint reads it', async () => {
    const mint = await startMint(generation)
    const a = await bareNote(mint, 10_000)
    const b = await bareNote(mint, 3_000)
    const callback = `${mint.url}/w/cb`

    const rotated = freshK1()
    const rotate = await rotateNoteWithHash(callback, a.k1, hashK1(rotated))
    expect(rotate.signature).toBeTruthy()
    expect(await stillLive(mint, a.k1)).toBe(false)

    const [part, change] = [freshK1(), freshK1()]
    const split = await splitNoteWithHash(callback, [rotated], 4_000, hashK1(part), hashK1(change))
    expect(split.signature).toBeTruthy()
    expect(split.changeSignature).toBeTruthy()

    const merged = freshK1()
    await mergeNotesWithHash(callback, [part, change, b.k1], hashK1(merged))
    expect((await fetchNoteInfo(buildNoteUrl(`${mint.url}/w`, merged))).maxWithdrawable).toBe(13_000)
  })

  it('receives a bare note and rotates it away from the sender', async () => {
    const mint = await startMint(generation)
    const note = await bareNote(mint, 21_000)
    const {wallet} = makeWallet()
    const received = await wallet.receive(note.url)
    expect(received.note.state).toBe('live')
    expect(received.note.amountMsat).toBe(21_000)
    expect(received.note.k1).not.toBe(note.k1)
    expect(await stillLive(mint, note.k1)).toBe(false)
    expect(await stillLive(mint, received.note.k1)).toBe(true)
    // and the rotate came back certified, in whichever shape the mint uses
    expect(received.note.signature).toBeTruthy()
  })

  it("receives a certified note once the mint's key is pinned", async () => {
    const mint = await startMint(generation)
    const {wallet, data} = makeWallet()
    await wallet.receive((await bareNote(mint, 5_000)).url)
    expect(data.pubkeyPins[mint.host]).toBeTruthy()

    const note = await certifiedNote(mint, 21_000)
    const received = await wallet.receive(note.url)
    expect(received.note.amountMsat).toBe(21_000)
    expect(wallet.balanceMsat()).toBe(26_000)
  })

  it('takes a certified note offline, and checks it offline', async () => {
    const mint = await startMint(generation)
    const {wallet} = makeWallet()
    await wallet.receive((await bareNote(mint, 5_000)).url)
    const note = await certifiedNote(mint, 21_000)
    expect(wallet.verifyNoteOffline(note.url).valid).toBe(true)
    const taken = await wallet.receiveOffline(note.url)
    expect(taken.note.amountMsat).toBe(21_000)
  })

  it('splits, merges and rotates', async () => {
    const mint = await startMint(generation)
    const {wallet} = makeWallet()
    await wallet.receive((await bareNote(mint, 30_000)).url)
    await wallet.receive((await bareNote(mint, 12_000)).url)

    const exact = await wallet.prepareExact(7_000)
    expect(exact.amountMsat).toBe(7_000)
    expect(wallet.balanceMsat()).toBe(42_000)
    expect(wallet.liveNotes()).toHaveLength(3)

    const combined = await wallet.combine(wallet.liveNotes().map(note => note.id))
    expect(combined.amountMsat).toBe(42_000)
    expect(wallet.liveNotes()).toHaveLength(1)

    const rotated = await wallet.rotateLive(combined)
    expect(rotated.amountMsat).toBe(42_000)
    expect(await stillLive(mint, combined.k1)).toBe(false)
    expect(await stillLive(mint, rotated.k1)).toBe(true)
  })

  it('checks every held note against the mint', async () => {
    const mint = await startMint(generation)
    const {wallet} = makeWallet()
    await wallet.receive((await bareNote(mint, 21_000)).url)
    await wallet.receive((await bareNote(mint, 9_000)).url)
    const report = await wallet.checkNotes()
    expect(report.unreachable).toEqual([])
    expect(report.checked).toBe(2)
    expect(report.spent).toEqual([])
    expect(report.unknown).toEqual([])
  })

  it('sends a note another wallet can take, certificate and all', async () => {
    const mint = await startMint(generation)
    const sender = makeWallet().wallet
    await sender.receive((await bareNote(mint, 30_000)).url)
    const recipient = makeWallet().wallet
    // pinned first, so the certificate on what arrives is checked
    await recipient.receive((await bareNote(mint, 1_000)).url)

    const sent = await sender.send(12_000)
    const handed = sender.noteUrlFor(sent)
    expect(noteSignature(handed)).toBeTruthy()
    // an old mint's certificate carries no amount, so it travels under the
    // names it was issued with; a current one as c, its amount inside it
    const params = new URL(handed).searchParams
    if (mint.legacy) {
      expect([params.has('sig'), params.get('amount'), params.has('c')]).toEqual([true, '12000', false])
    } else {
      expect([params.has('c'), params.has('sig')]).toEqual([true, false])
    }
    const taken = await recipient.receive(handed)
    expect(taken.note.amountMsat).toBe(12_000)
    expect(recipient.balanceMsat()).toBe(13_000)
    expect(await stillLive(mint, sent.k1)).toBe(false)
  })

  it('melts a note into an invoice', async () => {
    const mint = await startMint(generation)
    const {wallet} = makeWallet()
    await wallet.receive((await bareNote(mint, 21_000)).url)
    const pr = fakeBolt11({amountMsat: 21_000, paymentHashHex: freshK1()})
    const {melt, ambiguous} = await wallet.melt(pr, 'an invoice')
    expect(ambiguous).toBe(false)
    const melted = wallet.noteById(melt.noteId)!
    for (let tries = 0; tries < 100 && (await stillLive(mint, melted.k1)); tries++) await waitMs(10)
    expect(await stillLive(mint, melted.k1)).toBe(false)
  })

  it('names the note it buys, so the mint credits that one', async () => {
    const mint = await startMint(generation)
    const k1 = freshK1()
    const pay = (await (await fetch(`${mint.url}/.well-known/lnurlp/mint`)).json()) as {callback: string}
    const invoice = await requestInvoice(pay.callback, 21_000, hashK1(k1))
    await mint.settle(invoice.verify?.split('/').pop() ?? '')
    expect((await fetchNoteInfo(buildNoteUrl(`${mint.url}/w`, k1))).maxWithdrawable).toBe(21_000)
  })

  it('restores from its words', async () => {
    const mint = await startMint(generation)
    const seedHex = freshK1()
    const first = makeWallet()
    first.data.seedHex = seedHex
    await first.wallet.addMint(`mint@${mint.host}`)
    await first.wallet.receive((await bareNote(mint, 21_000)).url)

    const second = makeWallet()
    second.data.seedHex = seedHex
    await second.wallet.addMint(`mint@${mint.host}`)
    if (mint.legacy) {
      // An old mint has no lookup that keeps the secret back, so a restore
      // there needs the holder's say-so before it walks by secret.
      await expect(second.wallet.restoreFromMint(mint.host)).rejects.toThrow(/does not answer lookups by hash/)
      const restored = await second.wallet.restoreFromMint(mint.host, {allowSecretDisclosure: true})
      expect(restored.found.map(note => note.amountMsat)).toEqual([21_000])
    } else {
      const restored = await second.wallet.restoreFromMint(mint.host)
      expect(restored.found.map(note => note.amountMsat)).toEqual([21_000])
    }
  })
})

// The conformance mock invents invoices no BOLT-11 decoder reads, so the
// whole mint flow is graded on the two moneyers; the mock's quote is graded
// at the wire above.
describe.each(['moneyer 0.17', 'moneyer 0.3.1'] as const)('minting at a %s', generation => {
  it('mints to the secret it named, and claims it', async () => {
    const mint = await startMint(generation)
    const {wallet} = makeWallet()
    await wallet.addMint(`mint@${mint.host}`)
    const {pending} = await wallet.startMint(21_000)
    await mint.settle(pending.id)
    const minted = await wallet.awaitMint(pending, {timeoutMs: 3_000, intervalMs: 20})
    expect(minted?.note.amountMsat).toBe(21_000)
    // the note the mint credited is the one the wallet named, rotated since
    expect(await probeBurnedNote(buildNoteUrl(`${mint.url}/w`, pending.namedK1!))).toBe('gone')
    expect(await stillLive(mint, minted!.note.k1)).toBe(true)
  })
})
