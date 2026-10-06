import {describe, expect, it} from 'vitest'
import {bytesToHex, hexToBytes} from '@noble/hashes/utils.js'
import {
  NOTE_PURPOSE_CHANGE,
  NOTE_PURPOSE_LIGHTNING_ADDRESS,
  NOTE_PURPOSE_WALLET,
  deriveNotePubkey,
  decodeCs1WithAmount,
  deriveNoteSecretKey,
  noteDeclaredAmount,
  noteSignature,
  rotateNoteWithHash,
  splitNoteWithHash,
  type NotePurpose
} from '../src/lnurlcash.js'
import {schnorr} from '@noble/curves/secp256k1.js'

// LUD-25 (lnurl/luds 50d740a): a branch's keys per purpose, test vectors 1
// and 2, and the renames that came with them.

const V1 = {
  p: 'b783d2930dc053a971f019054ca43e7c9de50e0769de872dd1ddde5d0bf4c9d1',
  chain: 'ab91cc11aea395ea6b62292a6147f51ef4150ebea04e745137b68719e238f904'
}
const V2 = {
  p: '64885a9cab93ec051761b8a0b80e1854a61865878d58f72a365dfd640850f675',
  chain: '6b95795f9807ada85c8ca50ec93c921483a183abfed4a3b4abe6b95c89880306'
}
const key = (v: typeof V1, purpose: NotePurpose, index: number) =>
  bytesToHex(deriveNotePubkey(hexToBytes(v.p), hexToBytes(v.chain), purpose, index))

describe('note keys by purpose', () => {
  it('derives test vector 1 on every purpose (odd-y branch key)', () => {
    expect(key(V1, NOTE_PURPOSE_WALLET, 0)).toBe('690ac33892c64aa53874b0066ab1332f0ef45cb7c0e017eae0828916f52aa99f')
    expect(key(V1, NOTE_PURPOSE_WALLET, 1)).toBe('3e76b56c1a90bc64c4bf594be91a3cb8861a150232da92705cff6ee3714bb384')
    expect(key(V1, NOTE_PURPOSE_WALLET, 2)).toBe('20146298f9b6439027ead2b4a15738a10721b26c425b58c634baac6147ee7fc7')
    expect(key(V1, NOTE_PURPOSE_WALLET, 5)).toBe('c64ed8f1cd0f4d23aba8ddd739d9ae7e1a7ba2719cb54437384498fbc73788b3')
    expect(key(V1, NOTE_PURPOSE_CHANGE, 0)).toBe('e9a2d71a45a4a5a22d3378bdd761f0b3b2622b6a939d24c779668379352d8274')
    expect(key(V1, NOTE_PURPOSE_LIGHTNING_ADDRESS, 0)).toBe('acff3482453b4671e410d2158fd93ab7d4c3e8c1b9554ce1190deb021fd2cd4c')
  })

  it('derives test vector 2 (even-y branch key)', () => {
    expect(key(V2, NOTE_PURPOSE_WALLET, 0)).toBe('01fee34e378bf66de6afa1bfa6e30f5c89551fd92bc1b089dca93c52b7ab61bc')
    expect(key(V2, NOTE_PURPOSE_WALLET, 1)).toBe('7c5434c33d25bc24d98c35b2610dd484cb2a3d4a7854de354f7747e9b10597b8')
    expect(key(V2, NOTE_PURPOSE_WALLET, 2)).toBe('2517f8221468e33cb7aafdffde313950446da0cf4d790c9b758b373dc67a5686')
  })

  it("keeps the ladder from before purposes, as the spec's earlier vector 1 printed it", () => {
    expect(key(V1, null, 0)).toBe('aad3a0e36c083eb0d2d92ec0860977dc46d10c952f31830e6443b1faa1997634')
  })

  it('gives each secret the key its public half derives, on either parity', () => {
    for (const branchSecret of ['11'.repeat(32), '22'.repeat(32)]) {
      const sk = hexToBytes(branchSecret)
      const p = schnorr.getPublicKey(sk)
      const chain = hexToBytes('ab'.repeat(32))
      for (const purpose of [NOTE_PURPOSE_WALLET, NOTE_PURPOSE_CHANGE, NOTE_PURPOSE_LIGHTNING_ADDRESS, null] as const) {
        expect(bytesToHex(schnorr.getPublicKey(deriveNoteSecretKey(sk, chain, purpose, 7)))).toBe(
          bytesToHex(deriveNotePubkey(p, chain, purpose, 7))
        )
      }
    }
  })
})

describe('the renames', () => {
  const cs1 =
    'cs10n1xrfz2zj6jln6a6x7nupfdjl92r6v3rwzausqfwtnzqyu0hxjma85mhvhfszfw8gfm8ez50ls5ly6yjwv2fnnmsd6d3g8rq2c3xlfj5gqqstd9v'

  it("reads a note URL's certificate as c, or as sig before it", () => {
    expect(noteSignature(`lnurlw://mint.example/w?k1=00&c=${cs1}`)).toBe(cs1)
    expect(noteSignature(`lnurlw://mint.example/w?k1=00&sig=${cs1}`)).toBe(cs1)
    expect(noteDeclaredAmount(`lnurlw://mint.example/w?k1=00&c=${cs1}`)).toBe(1000)
  })

  // What goes on the wire for a bearer output: its 64-hex h under both of
  // its names, p1 (LUD-25's) and h (what a mint from before the rename
  // reads), so every generation finds it; a current mint requires the two
  // to agree. The certificate is read from c/c2.
  const answering = (body: unknown) => {
    const seen: URL[] = []
    const fetch = (async (url: string | URL) => {
      seen.push(new URL(String(url)))
      return new Response(JSON.stringify(body), {headers: {'content-type': 'application/json'}})
    }) as typeof globalThis.fetch
    return {seen, fetch}
  }

  it('names a bearer output under p1 and h alike, and reads the certificate from c', async () => {
    const h = 'aa'.repeat(32)
    const {seen, fetch} = answering({status: 'OK', c: cs1})
    const result = await rotateNoteWithHash('https://mint.example/cb', '01'.repeat(32), h, {fetch})
    const params = seen[0]!.searchParams
    expect(params.getAll('p1')).toEqual([h])
    expect(params.getAll('h')).toEqual([h])
    expect(result.signature).toBe(cs1)
  })

  it("names a split's two outputs under p1/h and p2/h2, and reads c and c2", async () => {
    const {seen, fetch} = answering({status: 'OK', c: cs1, c2: cs1})
    const result = await splitNoteWithHash('https://mint.example/cb', ['01'.repeat(32)], 500, 'aa'.repeat(32), 'bb'.repeat(32), {fetch})
    const params = seen[0]!.searchParams
    expect([params.get('p1'), params.get('h')]).toEqual(['aa'.repeat(32), 'aa'.repeat(32)])
    expect([params.get('p2'), params.get('h2')]).toEqual(['bb'.repeat(32), 'bb'.repeat(32)])
    expect(params.get('amount')).toBe('500')
    expect(result).toEqual({signature: cs1, changeSignature: cs1})
  })

  it('reads sig only in the shape a mint from before the rename sends it', async () => {
    // a cs1<amount> under the old name is no mint's answer: nothing is read
    const {fetch} = answering({status: 'OK', sig: cs1})
    expect(await rotateNoteWithHash('https://mint.example/cb', '01'.repeat(32), 'aa'.repeat(32), {fetch})).toEqual({})
    // 65 bytes of hex is what such a mint sends, and is kept for check to judge
    const hex = bytesToHex(decodeCs1WithAmount(cs1)!.signature)
    const old = answering({status: 'OK', sig: hex, sig2: hex})
    expect(await rotateNoteWithHash('https://mint.example/cb', '01'.repeat(32), 'aa'.repeat(32), {fetch: old.fetch})).toEqual({signature: hex})
    expect(
      await splitNoteWithHash('https://mint.example/cb', ['01'.repeat(32)], 500, 'aa'.repeat(32), 'bb'.repeat(32), {fetch: old.fetch})
    ).toEqual({signature: hex, changeSignature: hex})
  })
})
