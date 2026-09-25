import {describe, expect, it} from 'vitest'
import {bytesToHex, hexToBytes} from '@noble/hashes/utils.js'
import {
  ProtocolError,
  bearerNoteId,
  decodeCp1,
  decodeCw1,
  encodeCk1,
  encodeCp1,
  encodeCw1,
  noteIdOf,
  signNoteOwnership
} from '../src/lnurlcash.js'
import {NUMS_H, tapLeafHash, taprootTweak} from '../src/spend.ts'
import {BadSignatureError, Wallet, WalletUsageError} from '../src/wallet.ts'
import {emptyWallet, type WalletData} from '../src/types.ts'
import {certify} from './helpers.ts'

// The wallet's own paths against LUD-25's vectors (25.md at lnurl/luds
// 6e865b1): a ck1 it signs while scanning its branch, the certified bearer
// note the spec prints, and a cw1 in hand. The mint is a small fake on
// mint.example that files notes by Q and certifies them over Q, as a mint
// following the change does.

const MINT_KEY = hexToBytes('a8358061952ee158b42ffe1607c00adda3e63098247f837f08a4ef9492b4f798')
const MINT_PUBKEY = '035acdbd57663f858be6d61ec4bfcbc99492699010f1451e30a6550f26295e813d'
const PK0 = '690ac33892c64aa53874b0066ab1332f0ef45cb7c0e017eae0828916f52aa99f'
const V5 = {
  preimage: '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',
  h: '630dcd2966c4336691125448bbb25b4ff412a49c732db2c8abc1b8581bd710dd',
  q: 'd18b619687343df2fc7a47e1daf25260b909bb563fb4b4b11e59e2bd64880982',
  cw1: 'cw1qqqqqq8lllll7qpr4qsxxrwd99nvgvmxjyf9gj9mkfd5laqj5jw8xtdjez4urwzcr0t3phv8qqsuq5yjnd6vrgzf2jmckjmqxh5h5hs83fdq728vjm2500lwnt8gqwkqqqsqqqgzqvzq2ps8pqys5zcvp58q7yq3zgf3g9gkzuvpjxsmrsw3u8c6x6a4c',
  // the spec's own certified note, in short form
  url: 'lnurlw://mint.example/w?k1=000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f&sig=cs10n1caxh3wxfa0g2zxj6lt90rlksv8dgemtavcj7dqymvfxa7683d268mawdsvygd0maru024z9ehtdv5fptumsr3t0v0vuv2x3e953557qq5c70z5'
}

// Files notes by hex(Q), answers a lookup by p (cp1 or a bearer h) and, for a
// spend it is handed on the GET itself, echoes it. Every certificate is over
// Q. What the wallet sent is kept, so a test can say what went on the wire.
const fakeMint = () => {
  const notes = new Map<string, number>()
  const seen: URL[] = []
  // A cp1, or a bearer note's h in its place.
  const qOf = (value: string): string => (/^[0-9a-f]{64}$/i.test(value) ? bearerNoteId(value) : bytesToHex(decodeCp1(value)!))
  const withdrawRequest = (q: string, extra: Record<string, unknown> = {}) => ({
    tag: 'withdrawRequest',
    callback: 'https://mint.example/cb',
    minWithdrawable: 1000,
    maxWithdrawable: notes.get(q)!,
    mintPubkey: MINT_PUBKEY,
    sig: certify(MINT_KEY, notes.get(q)!, q),
    ...extra
  })
  const fetchImpl: typeof globalThis.fetch = async input => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url)
    seen.push(url)
    const q = url.searchParams
    if (url.pathname === '/w') {
      const lookup = q.get('p') ?? q.get('h')
      if (lookup) {
        const id = qOf(lookup)
        return Response.json(notes.has(id) ? withdrawRequest(id) : {status: 'ERROR', reason: 'Unknown note.'})
      }
      const k1 = q.get('k1')!
      const id = noteIdOf(k1)!
      return Response.json(notes.has(id) ? withdrawRequest(id, {k1}) : {status: 'ERROR', reason: 'Unknown note.'})
    }
    if (url.pathname === '/cb') {
      const inputs = q.getAll('k1').map(k1 => noteIdOf(k1)!)
      const output = q.get('p1') ?? q.get('h')!
      if (inputs.some(id => !notes.has(id))) return Response.json({status: 'ERROR', reason: 'Note already spent.'})
      const total = inputs.reduce((sum, id) => sum + notes.get(id)!, 0)
      for (const id of inputs) notes.delete(id)
      const out = qOf(output)
      notes.set(out, total)
      return Response.json({status: 'OK', sig: certify(MINT_KEY, total, out)})
    }
    return Response.json({status: 'ERROR', reason: 'Not found.'}, {status: 404})
  }
  return {notes, seen, fetchImpl}
}

const walletAt = (mint: ReturnType<typeof fakeMint>, seedHex?: string) => {
  const data: WalletData = emptyWallet()
  if (seedHex) data.seedHex = seedHex
  data.mints.push({
    input: 'mint@mint.example',
    host: 'mint.example',
    payUrl: 'https://mint.example/.well-known/lnurlp/mint',
    baseUrl: 'https://mint.example/w',
    addedAt: 1
  })
  return {data, wallet: new Wallet(data, async () => {}, {fetch: mint.fetchImpl})}
}

describe('a ck1 this wallet signs', () => {
  it("signs for test vector 1's Lightning Address key when it finds its own note while scanning its branch", async () => {
    const mint = fakeMint()
    // test vector 1's purpose-2 (Lightning Address) key at index 0, where a
    // mint pays a name; the scan does not walk purpose 0, vector 3's key
    const q = 'acff3482453b4671e410d2158fd93ab7d4c3e8c1b9554ce1190deb021fd2cd4c'
    const sk = hexToBytes('845e8f836a4cf64e9c03dab9d20bda0d3032d6b5ee7c2fa3014ef9d8f501faa8')
    mint.notes.set(q, 21_000)
    const {wallet} = walletAt(mint, '000102030405060708090a0b0c0d0e0f')

    const scan = await wallet.scanAddress('mint.example', {gap: 1})
    expect(scan.received.map(result => result.note.amountMsat)).toEqual([21_000])
    // the note was looked up by its key and spent with a ck1 by the spec's
    // sk for it, signed as vector 3 signs: over mint.example's sighash
    const {pubkeyXOnly, signature} = signNoteOwnership(sk, 'mint.example')
    expect(bytesToHex(pubkeyXOnly)).toBe(q)
    const ck1 = encodeCk1(pubkeyXOnly, signature)
    const spent = mint.seen.find(url => url.pathname === '/cb')!
    expect(spent.searchParams.getAll('k1')).toEqual([ck1])
    expect(mint.seen.some(url => url.pathname === '/w' && url.searchParams.get('k1') === ck1)).toBe(false)
    expect(wallet.balanceMsat()).toBe(21_000)
  })

  it('refuses a note whose ck1 is bound to another mint, before anything is stored', async () => {
    const mint = fakeMint()
    const sk = hexToBytes('33'.repeat(32))
    const {pubkeyXOnly, signature} = signNoteOwnership(sk, 'other.example')
    mint.notes.set(bytesToHex(pubkeyXOnly), 21_000)
    const {wallet, data} = walletAt(mint)
    await expect(wallet.receive(`https://mint.example/w?k1=${encodeCk1(pubkeyXOnly, signature)}`)).rejects.toThrow(ProtocolError)
    expect(data.notes).toEqual([])
    expect(mint.seen).toEqual([])
  })
})

describe("test vector 5's certified note, taken offline", () => {
  const pinned = () => {
    const mint = fakeMint()
    const made = walletAt(mint)
    made.data.pubkeyPins['mint.example'] = MINT_PUBKEY
    return made
  }

  it('verifies against the pinned key and is filed under its Q', async () => {
    const {wallet} = pinned()
    expect(wallet.verifyNoteOffline(V5.url)).toEqual({valid: true, reason: 'signed by the pinned key for mint.example'})
    const {note} = await wallet.receiveOffline(V5.url)
    expect(note.id).toBe(V5.q)
    expect(note.amountMsat).toBe(1000)
    expect(note.unrotated).toBe(true)
  })

  it('knows its full cw1 is the same note', async () => {
    const {wallet} = pinned()
    await wallet.receiveOffline(V5.url)
    await expect(wallet.receiveOffline(V5.url.replace(V5.preimage, V5.cw1))).rejects.toThrow('already in the wallet')
  })

  it("takes an older mint's certificate over h, and refuses one under neither id", async () => {
    const {wallet} = pinned()
    const overH = `lnurlw://mint.example/w?k1=${V5.preimage}&sig=${certify(MINT_KEY, 1000, V5.h)}`
    expect(wallet.verifyNoteOffline(overH).valid).toBe(true)
    const overNeither = `lnurlw://mint.example/w?k1=${V5.preimage}&sig=${certify(MINT_KEY, 1000, 'ab'.repeat(32))}`
    expect(wallet.verifyNoteOffline(overNeither).valid).toBe(false)
    await expect(wallet.receiveOffline(overNeither)).rejects.toThrow(BadSignatureError)
    const {note} = await wallet.receiveOffline(overH)
    expect(note.id).toBe(V5.q)
  })
})

describe('a cw1 in hand', () => {
  it('is looked up by its h and spent verbatim, when it is a bearer note', async () => {
    const mint = fakeMint()
    mint.notes.set(V5.q, 21_000)
    const {wallet} = walletAt(mint)
    const {note} = await wallet.receive(`https://mint.example/w?k1=${V5.cw1}`)
    expect(note.amountMsat).toBe(21_000)
    expect(note.origin).toBe('rotate')
    const lookup = mint.seen.find(url => url.pathname === '/w')!
    expect(lookup.searchParams.get('h')).toBe(V5.h)
    expect(lookup.searchParams.has('k1')).toBe(false)
    expect(mint.seen.find(url => url.pathname === '/cb')!.searchParams.getAll('k1')).toEqual([V5.cw1])
  })

  // A leaf a key must sign for: only the mint's interpreter can judge it.
  const scripted = () => {
    const script = new Uint8Array([0x20, ...hexToBytes(PK0), 0xac])
    const {parity} = taprootTweak(NUMS_H, tapLeafHash(script))!
    return encodeCw1({
      locktime: 0,
      sequence: 0xffffffff,
      script,
      controlBlock: new Uint8Array([0xc0 | parity, ...NUMS_H]),
      witness: [new Uint8Array(64)]
    })
  }

  it('can only be checked online when its script is anything else', async () => {
    const mint = fakeMint()
    const {wallet, data} = walletAt(mint)
    data.pubkeyPins['mint.example'] = MINT_PUBKEY
    const cw1 = scripted()
    const url = `lnurlw://mint.example/w?k1=${cw1}&sig=${certify(MINT_KEY, 1000, noteIdOf(cw1)!)}`
    expect(wallet.verifyNoteOffline(url)).toMatchObject({valid: false, reason: expect.stringContaining('only be checked online')})
    await expect(wallet.receiveOffline(url)).rejects.toThrow(WalletUsageError)
    expect(data.notes).toEqual([])
  })

  it('is handed to the mint verbatim to judge, online', async () => {
    const mint = fakeMint()
    const cw1 = scripted()
    mint.notes.set(noteIdOf(cw1)!, 21_000)
    const {wallet} = walletAt(mint)
    const {note} = await wallet.receive(`https://mint.example/w?k1=${cw1}`)
    expect(note.amountMsat).toBe(21_000)
    expect(mint.seen.find(url => url.pathname === '/w')!.searchParams.get('k1')).toBe(cw1)
    expect(mint.seen.find(url => url.pathname === '/cb')!.searchParams.getAll('k1')).toEqual([cw1])
  })

  it('opens a bearer hashlock under the same Q whichever spend is shown', () => {
    const decoded = decodeCw1(V5.cw1)!
    expect(encodeCp1(decoded.outputKey)).toBe(encodeCp1(hexToBytes(V5.q)))
  })
})
