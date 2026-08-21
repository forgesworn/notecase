import {afterEach, describe, expect, it} from 'vitest'
import {createMockMint} from 'lnurlcash-conformance/mock-mint'
import {PinMismatchError, Wallet} from '../src/wallet.ts'
import {freshK1, makeWallet} from './helpers.ts'

// A mint rotating its signing key. Every outstanding signature stops
// verifying against the pin at once, and a wallet that treats that as an
// attack tells its holder their mint has been replaced when it has simply
// changed a key and said so.

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

// The mint's key changes to `newKey`, and its discovery says (or does not
// say) that the old one is retired. Everything else answers as before, so
// the notes it already signed are signed by the OLD key - which is the
// whole situation a rotation puts a wallet in.
const rotatedTo = (mint: Mint, newKey: string, options: {publishOldKey: boolean}) => {
  const oldKey = mint.state.pubkey
  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url)
    const response = await fetch(input, init)
    if (url.pathname === '/w' && url.searchParams.has('k1')) {
      const body = (await response.json()) as Record<string, unknown>
      return Response.json({...body, mintPubkey: newKey})
    }
    if (url.pathname.startsWith('/.well-known/lnurlw/')) {
      const body = (await response.json()) as Record<string, unknown>
      return Response.json({
        ...body,
        mintPubkey: newKey,
        ...(options.publishOldKey ? {previousPubkeys: [oldKey]} : {})
      })
    }
    return response
  }
  return fetchImpl
}

const fund = (mint: Mint, amountMsat: number): string => {
  const k1 = freshK1()
  mint.state.creditNote(k1, amountMsat)
  return `${mint.url}/w?k1=${k1}&amount=${amountMsat}`
}

describe('a mint that rotates its signing key', () => {
  const pinnedWallet = async (mint: Mint) => {
    const wallet = makeWallet()
    await wallet.wallet.addMint(`mint@${hostOf(mint)}`)
    await wallet.wallet.receive(fund(mint, 21_000))
    expect(wallet.data.pubkeyPins[hostOf(mint)]).toBe(mint.state.pubkey)
    return wallet
  }

  it('is accepted when the mint publishes the old key as retired', async () => {
    const mint = await start()
    // any other valid mint key: the mock derives one from a private key
    const other = await start({privateKey: freshK1()})
    const oldKey = mint.state.pubkey
    const wallet = await pinnedWallet(mint)

    // the same wallet, now seeing the rotated mint
    const rotated = new Wallet(wallet.data, async () => {}, {
      timeoutMs: 3_000,
      fetch: rotatedTo(mint, other.state.pubkey, {publishOldKey: true})
    })
    const received = await rotated.receive(fund(mint, 5_000))

    expect(wallet.data.pubkeyPins[hostOf(mint)]).toBe(other.state.pubkey)
    expect(rotated.pubkeyHistoryFor(hostOf(mint))).toEqual([oldKey])
    expect(received.warnings.some(warning => warning.includes('rotated its signing key'))).toBe(true)
    expect(rotated.balanceMsat()).toBe(26_000)

    // and it is said once, plainly, on the next reconcile
    const events = await rotated.reconcile()
    expect(events.some(event => event.kind === 'mint-key-rotated')).toBe(true)
    const again = await rotated.reconcile()
    expect(again.some(event => event.kind === 'mint-key-rotated')).toBe(false)
  })

  it('is refused when the mint says nothing about the old key', async () => {
    const mint = await start()
    const other = await start({privateKey: freshK1()})
    const wallet = await pinnedWallet(mint)
    const oldKey = mint.state.pubkey

    const rotated = new Wallet(wallet.data, async () => {}, {
      timeoutMs: 3_000,
      fetch: rotatedTo(mint, other.state.pubkey, {publishOldKey: false})
    })
    await expect(rotated.receive(fund(mint, 5_000))).rejects.toThrow(PinMismatchError)
    expect(wallet.data.pubkeyPins[hostOf(mint)]).toBe(oldKey)
    expect(rotated.pubkeyHistoryFor(hostOf(mint))).toEqual([])
  })

  it('keeps verifying notes the retired key signed, offline and in the sweep', async () => {
    const mint = await start()
    const other = await start({privateKey: freshK1()})
    const wallet = await pinnedWallet(mint)
    const held = wallet.wallet.liveNotes()[0]!

    const rotated = new Wallet(wallet.data, async () => {}, {
      timeoutMs: 3_000,
      fetch: rotatedTo(mint, other.state.pubkey, {publishOldKey: true})
    })
    await rotated.receive(fund(mint, 5_000))

    // the note it already holds was signed by the key now retired
    const verdict = rotated.verifyNoteOffline(rotated.noteUrlFor(held))
    expect(verdict.valid).toBe(true)
    expect(verdict.reason).toContain('retired')

    // and the sweep offers to re-sign it under the key in use now, which
    // a rotate does for nothing
    const report = await rotated.checkNotes()
    expect(report.staleSignature.map(note => note.id)).toContain(held.id)
    expect(report.spent).toEqual([])
  })

  it('reports nothing stale while the mint is still using the key it pinned', async () => {
    const mint = await start()
    const wallet = await pinnedWallet(mint)
    const report = await wallet.wallet.checkNotes()
    expect(report.staleSignature).toEqual([])
    expect(wallet.wallet.verifyNoteOffline(wallet.wallet.noteUrlFor(wallet.wallet.liveNotes()[0]!)).reason).toContain(
      'pinned key'
    )
  })
})
