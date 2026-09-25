import {describe, expect, it} from 'vitest'
import {schnorr} from '@noble/curves/secp256k1.js'
import {sha256} from '@noble/hashes/sha2.js'
import {bytesToHex, hexToBytes, utf8ToBytes} from '@noble/hashes/utils.js'
import {
  bearerHashOf,
  bearerNote,
  bearerNoteIdOfPreimage,
  certificateIdsOf,
  checkSpendOffline,
  decodeCw1,
  encodeCk1,
  encodeCp1,
  encodeCw1,
  keyPathSighash,
  legacyNoteIdOf,
  noteIdOf,
  signAddressProof,
  signNoteOwnership,
  spendDomainOf,
  spendPrevout,
  spendSigMsg,
  tapLeafHash,
  verifyCk1,
  verifyNoteCertificate
} from '../src/lnurlcash.js'
import {bech32m} from '@scure/base'
import {NUMS_H, taprootTweak} from '../src/spend.ts'
import {certify, legacyEcdsaCk1, legacySchnorrCk1} from './helpers.ts'

// LUD-25's own test vectors (lnurl/luds 25.md at 50d740a), byte for byte.
// Every spend in them was accepted by Bitcoin Core's interpreter against the
// canonical spend transaction, so matching them is matching the chain's rules.

// Vector 1, purpose 0, i = 0: the key-path note vectors 3 and 4 spend and certify.
const V1 = {
  sk0: '3616b02290a133da73e758a54dbff1bf6439b4067a820cb51ca873fa4a13a96a',
  pk0: '690ac33892c64aa53874b0066ab1332f0ef45cb7c0e017eae0828916f52aa99f',
  cp1: 'cp1dy9vxwyjce922wr5kqrx4vfn9u80gh9hcrsp06hqs2y3daf24x0sxpcl6z'
}

const V3 = {
  domain: 'mint.example',
  prevout: 'd5ac2de3423432e37713bcb133cfea7938ff6b2f8ea4174dfcec84bea705d6b2',
  sigMsg:
    '00020000000000000030b1cba17526057f8343b434d78c6e2daf43429c3a38e236d22cf5f5b78b9024af5570f5a1810b7af78caf4bc70a660f0df51e42baf91d4de5b2328de0e83dfc6ca88527eb01d83d9c7eec6d169b4813ee5567ac7b83a83b5da812fac542d09dad95131bc0b799c0b1af477fb14fcf26a6a9f76079e48bf090acb7e8367bfd0e3e7077fd2f66d689e0cee6a7cf5b37bf2dca7c979af356d0a31cbc5c85605c7d0000000000',
  sighash: 'e97bb6831a916ff83919046f50a39c18ab98bf43079cf68cd364d251f7de527f',
  sig: 'fc3491f1c6bca73dcd76b38fc6b7a82aef0f1fa67212ceb7d7f64dbc41c8bfe77e0db6077624bf117badb65efe0445e382ac9f4cd582f7a5cc366c7aeb4580d4',
  ck1: 'ck1dy9vxwyjce922wr5kqrx4vfn9u80gh9hcrsp06hqs2y3daf24x0lcdy378rtefeae4mt8r7xk75z4mc0r7n8yykwkltlvndug8ytlem7pkmqwa3yhughhtdktmlqg30rs2kf7nx4stm6tnpkd3awk3vq6smm20wz'
}

const ck1At = (sk: string, domain: string): string => {
  const {pubkeyXOnly, signature} = signNoteOwnership(hexToBytes(sk), domain)
  return encodeCk1(pubkeyXOnly, signature)
}

const V4 = {
  mintKey: 'a8358061952ee158b42ffe1607c00adda3e63098247f837f08a4ef9492b4f798',
  mintPubkey: '035acdbd57663f858be6d61ec4bfcbc99492699010f1451e30a6550f26295e813d',
  cs1At1000:
    'cs10n1xrfz2zj6jln6a6x7nupfdjl92r6v3rwzausqfwtnzqyu0hxjma85mhvhfszfw8gfm8ez50ls5ly6yjwv2fnnmsd6d3g8rq2c3xlfj5gqqstd9v',
  cs1At21m:
    'cs210u1e589gd5s4e3vr7nsy7dad4qxwvmnnqpuxcduar9xxwuntk6ey34q3kmlyh4ldk5z5j6zanyt470f0nujzdrh5c5fzz74pgxjpy54nvcpd0rph6'
}

const V5 = {
  preimage: '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',
  h: '630dcd2966c4336691125448bbb25b4ff412a49c732db2c8abc1b8581bd710dd',
  leaf: 'a820630dcd2966c4336691125448bbb25b4ff412a49c732db2c8abc1b8581bd710dd87',
  tapleafHash: 'edffc9fa683d8844ded0ba5ec4215d5940ae436b0675257c1344bcb082516b50',
  q: 'd18b619687343df2fc7a47e1daf25260b909bb563fb4b4b11e59e2bd64880982',
  control: 'c050929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0',
  cp1: 'cp16x9kr958xs7l9lr6glsa4ujjvzusnw6k876tfvg7t83t6eygpxpq6we0xc',
  cw1: 'cw1qqqqqq8lllll7qpr4qsxxrwd99nvgvmxjyf9gj9mkfd5laqj5jw8xtdjez4urwzcr0t3phv8qqsuq5yjnd6vrgzf2jmckjmqxh5h5hs83fdq728vjm2500lwnt8gqwkqqqsqqqgzqvzq2ps8pqys5zcvp58q7yq3zgf3g9gkzuvpjxsmrsw3u8c6x6a4c',
  cs1:
    'cs10n1caxh3wxfa0g2zxj6lt90rlksv8dgemtavcj7dqymvfxa7683d268mawdsvygd0maru024z9ehtdv5fptumsr3t0v0vuv2x3e953557qq5c70z5'
}

describe('test vector 5: a bearer note', () => {
  it('builds the hashlock leaf, its NUMS-keyed Q and its control block', () => {
    const note = bearerNote(hexToBytes(V5.h))
    expect(bytesToHex(note.leaf)).toBe(V5.leaf)
    expect(bytesToHex(tapLeafHash(note.leaf))).toBe(V5.tapleafHash)
    expect(bytesToHex(note.outputKey)).toBe(V5.q)
    expect(bytesToHex(note.controlBlock)).toBe(V5.control)
    expect(encodeCp1(note.outputKey)).toBe(V5.cp1)
    expect(bytesToHex(NUMS_H)).toBe(V5.control.slice(2))
  })

  it('files the preimage and its full cw1 under the same Q, which is not h', () => {
    expect(bytesToHex(sha256(hexToBytes(V5.preimage)))).toBe(V5.h)
    expect(noteIdOf(V5.preimage)).toBe(V5.q)
    expect(bearerNoteIdOfPreimage(V5.preimage)).toBe(V5.q)
    expect(noteIdOf(V5.cw1)).toBe(V5.q)
    // the id a wallet filed it under before, and the h it still discloses
    expect(legacyNoteIdOf(V5.preimage)).toBe(V5.h)
    expect(legacyNoteIdOf(V5.cw1)).toBe(V5.h)
    expect(bearerHashOf(V5.preimage)).toBe(V5.h)
    expect(bearerHashOf(V5.cw1)).toBe(V5.h)
  })

  it('encodes and decodes its cw1 exactly', () => {
    const decoded = decodeCw1(V5.cw1)!
    expect(decoded.locktime).toBe(0)
    expect(decoded.sequence).toBe(0xffffffff)
    expect(bytesToHex(decoded.script)).toBe(V5.leaf)
    expect(bytesToHex(decoded.controlBlock)).toBe(V5.control)
    expect(decoded.witness.map(bytesToHex)).toEqual([V5.preimage])
    expect(bytesToHex(decoded.outputKey)).toBe(V5.q)
    const {outputKey: _q, ...spend} = decoded
    expect(encodeCw1(spend)).toBe(V5.cw1)
  })

  it('opens at any domain, since its leaf checks no signature', () => {
    for (const domain of ['mint.example', 'elsewhere.example']) {
      expect(checkSpendOffline(V5.preimage, domain)).toEqual({ok: true, noteId: V5.q})
      expect(checkSpendOffline(V5.cw1, domain)).toEqual({ok: true, noteId: V5.q})
    }
  })

  it("takes vector 4's certificate over Q, and an older mint's over h after it", () => {
    expect(certificateIdsOf(V5.preimage)).toEqual([V5.q, V5.h])
    expect(verifyNoteCertificate(V5.preimage, 1000, V5.cs1, V4.mintPubkey)).toBe(true)
    expect(verifyNoteCertificate(V5.cw1, 1000, V5.cs1, V4.mintPubkey)).toBe(true)
    const overH = certify(hexToBytes(V4.mintKey), 1000, V5.h)
    expect(verifyNoteCertificate(V5.preimage, 1000, overH, V4.mintPubkey)).toBe(true)
    expect(verifyNoteCertificate(V5.cw1, 1000, overH, V4.mintPubkey)).toBe(true)
  })

  it('refuses a certificate under neither id, or for another amount, exactly as before', () => {
    expect(verifyNoteCertificate(V5.preimage, 2000, V5.cs1, V4.mintPubkey)).toBe(false)
    const otherNote = certify(hexToBytes(V4.mintKey), 1000, 'ab'.repeat(32))
    expect(verifyNoteCertificate(V5.preimage, 1000, otherNote, V4.mintPubkey)).toBe(false)
    // sha256(h) is neither Q nor h
    const hashOfH = certify(hexToBytes(V4.mintKey), 1000, bytesToHex(sha256(hexToBytes(V5.h))))
    expect(verifyNoteCertificate(V5.preimage, 1000, hashOfH, V4.mintPubkey)).toBe(false)
    // another mint's key
    const stranger = certify(hexToBytes('11'.repeat(32)), 1000, V5.q)
    expect(verifyNoteCertificate(V5.preimage, 1000, stranger, V4.mintPubkey)).toBe(false)
  })
})

describe('test vector 3: a key-path spend bound to its mint', () => {
  it('builds the prevout, SigMsg and sighash field for field', () => {
    const q = hexToBytes(V1.pk0)
    expect(bytesToHex(spendPrevout(V3.domain))).toBe(V3.prevout)
    expect(bytesToHex(spendSigMsg({outputKey: q, domain: V3.domain, locktime: 0, sequence: 0xffffffff}))).toBe(V3.sigMsg)
    expect(bytesToHex(keyPathSighash(q, V3.domain))).toBe(V3.sighash)
  })

  it('signs the same ck1 every time, with an all-zero aux_rand', () => {
    const signed = signNoteOwnership(hexToBytes(V1.sk0), V3.domain)
    expect(bytesToHex(signed.pubkeyXOnly)).toBe(V1.pk0)
    expect(bytesToHex(signed.signature)).toBe(V3.sig)
    expect(encodeCk1(signed.pubkeyXOnly, signed.signature)).toBe(V3.ck1)
    // a note URL, an origin with a port, or a host: always the bare hostname
    for (const at of ['https://mint.example/w?k1=x', 'lnurlw://mint.example/w', 'mint.example:8443', 'MINT.EXAMPLE']) {
      expect(spendDomainOf(at)).toBe(V3.domain)
      expect(ck1At(V1.sk0, at)).toBe(V3.ck1)
    }
    expect(ck1At(V1.sk0, 'other.example')).not.toBe(V3.ck1)
  })

  it('opens its note at mint.example and nowhere else', () => {
    expect(noteIdOf(V3.ck1)).toBe(V1.pk0)
    expect(encodeCp1(verifyCk1(V3.ck1, 'https://mint.example/w')!.outputKey)).toBe(V1.cp1)
    expect(verifyCk1(V3.ck1, V3.domain)!.legacy).toBe(false)
    expect(verifyCk1(V3.ck1, 'other.example')).toBeNull()
    expect(checkSpendOffline(V3.ck1, 'mint.example')).toEqual({ok: true, noteId: V1.pk0})
    expect(checkSpendOffline(V3.ck1, 'other.example')).toMatchObject({ok: false, onlineOnly: false})
  })

  it('still reads the deprecated shapes, which open their Q at any mint', () => {
    const sk = hexToBytes(V1.sk0)
    for (const old of [legacySchnorrCk1(sk), legacyEcdsaCk1(sk)]) {
      expect(noteIdOf(old)).toBe(V1.pk0)
      for (const domain of ['mint.example', 'other.example']) {
        expect(verifyCk1(old, domain)).toEqual({outputKey: hexToBytes(V1.pk0), legacy: true})
      }
    }
    // the raw nine-byte message, from before that
    const raw = encodeCk1(hexToBytes(V1.pk0), schnorr.sign(utf8ToBytes('LNURLcash'), sk, new Uint8Array(32)))
    expect(verifyCk1(raw, 'mint.example')!.legacy).toBe(true)
  })

  it('refuses a Q paired with a signature by another key', () => {
    const forged = encodeCk1(hexToBytes(V1.pk0), signNoteOwnership(hexToBytes('22'.repeat(32)), V3.domain).signature)
    expect(noteIdOf(forged)).toBe(V1.pk0)
    expect(verifyCk1(forged, V3.domain)).toBeNull()
    expect(checkSpendOffline(forged, V3.domain).ok).toBe(false)
  })
})

describe('test vector 4: a certificate over a key note', () => {
  it('verifies at both amounts, and at no other', () => {
    expect(certificateIdsOf(V3.ck1)).toEqual([V1.pk0])
    expect(verifyNoteCertificate(V3.ck1, 1000, V4.cs1At1000, V4.mintPubkey)).toBe(true)
    expect(verifyNoteCertificate(V3.ck1, 21_000_000, V4.cs1At21m, V4.mintPubkey)).toBe(true)
    expect(verifyNoteCertificate(V3.ck1, 1001, V4.cs1At1000, V4.mintPubkey)).toBe(false)
    expect(verifyNoteCertificate(V3.ck1, 21_000_000, V4.cs1At1000, V4.mintPubkey)).toBe(false)
  })
})

describe('test vector 2: the address registration proof', () => {
  const sk0 = hexToBytes('bc1e4427b38f7b48ef379ff7cefbef6612cf84a0f582b06c90bf6b51d2c89f29')
  const pk0 = hexToBytes('23bf26d94335b65e84b8383eb0a8baec8c32e2ebc561a204a386bb720b4cd130')
  const register =
    '9d96780fe55f602a9e238a4b2640a9f8ca939cacbbcde109cfd6ba94a6f9d46ff4aaf56ba1e4e72696f7c0e8833445bd194bd06155a133cf524eb587d52e8d22'
  const unregister =
    '7250ab2403333eb5ed73f7a212ac4f35b58f426fe5c2acb8b2194a112881332bfbeebeba0bc4615bcf361bc125d5a4149ddbe4b6ea3b755b711fefd8bba58728'

  it('signs register and unregister over the domain-bound digests', () => {
    expect(bytesToHex(signAddressProof(sk0, 'register', 'cash.example.com', 'alice'))).toBe(register)
    expect(bytesToHex(signAddressProof(sk0, 'unregister', 'cash.example.com', 'alice'))).toBe(unregister)
    // the service's URL is reduced to its hostname, as it verifies
    expect(bytesToHex(signAddressProof(sk0, 'register', 'https://cash.example.com:8443/.well-known/lnurlw/mint', 'alice'))).toBe(register)
    expect(
      schnorr.verify(hexToBytes(register), sha256(utf8ToBytes('LNURLcash:register:cash.example.com:alice')), pk0)
    ).toBe(true)
  })

  it('binds the domain, so a proof for one service is refused at another', () => {
    const elsewhere = signAddressProof(sk0, 'register', 'other.example', 'alice')
    expect(bytesToHex(elsewhere)).not.toBe(register)
    expect(
      schnorr.verify(elsewhere, sha256(utf8ToBytes('LNURLcash:register:cash.example.com:alice')), pk0)
    ).toBe(false)
  })
})

describe('script-path spends a wallet cannot judge', () => {
  // A leaf a key must sign for, under the NUMS key: only an interpreter with
  // the canonical transaction can say whether its witness opens it.
  const keyed = (script: Uint8Array) => {
    const leaf = script
    const {parity} = taprootTweak(NUMS_H, tapLeafHash(leaf))!
    const control = new Uint8Array([0xc0 | parity, ...NUMS_H])
    return encodeCw1({locktime: 0, sequence: 0xffffffff, script: leaf, controlBlock: control, witness: [new Uint8Array(64)]})
  }

  it('says a signature leaf can only be checked online', () => {
    const cw1 = keyed(new Uint8Array([0x20, ...hexToBytes(V1.pk0), 0xac]))
    const id = noteIdOf(cw1)
    expect(id).toMatch(/^[0-9a-f]{64}$/)
    expect(certificateIdsOf(cw1)).toEqual([id])
    expect(checkSpendOffline(cw1, 'mint.example')).toMatchObject({ok: false, onlineOnly: true})
  })

  it('refuses a leaf using an OP_SUCCESS upgrade hook outright', () => {
    expect(checkSpendOffline(keyed(new Uint8Array([0x50])), 'mint.example')).toMatchObject({ok: false, onlineOnly: false})
  })

  it('refuses a bearer hashlock whose witness does not open it', () => {
    const decoded = decodeCw1(V5.cw1)!
    const wrong = encodeCw1({...decoded, witness: [new Uint8Array(32)]})
    expect(checkSpendOffline(wrong, 'mint.example')).toMatchObject({ok: false, onlineOnly: false})
    expect(bearerHashOf(wrong)).toBeNull()
  })

  it('refuses a cw1 whose length prefixes do not consume it, or that lacks a control block', () => {
    const payload = bech32m.fromWords(bech32m.decode(V5.cw1 as `${string}1${string}`, 8192).words)
    const raw = (bytes: Uint8Array) => bech32m.encode('cw', bech32m.toWords(bytes), 8192)
    expect(noteIdOf(raw(payload))).toBe(V5.q)
    expect(decodeCw1(raw(new Uint8Array([...payload, 0x00])))).toBeNull()
    expect(decodeCw1(raw(payload.slice(0, -1)))).toBeNull()
    // locktime, sequence and a script, with no control block after it
    expect(decodeCw1(raw(payload.slice(0, 8 + 2 + 35)))).toBeNull()
  })
})
