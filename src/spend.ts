import {sha256} from '@noble/hashes/sha2.js'
import {schnorr, secp256k1} from '@noble/curves/secp256k1.js'
import {bytesToHex, hexToBytes, utf8ToBytes} from '@noble/hashes/utils.js'
import {bech32, bech32m} from '@scure/base'
import {
  TAPLEAF_VERSION,
  bearerNote,
  bearerNoteIdOfPreimage,
  ck1Pubkey,
  decodeCk1,
  decodeCw1 as decodeCw1Fields,
  deriveNotePubkey as deriveKitNotePubkey,
  deriveNoteSecretKey as deriveKitNoteSecretKey,
  deriveScriptPathCommitment,
  encodeCs1WithAmount,
  isCs1WithAmount,
  recoverNoteOwnershipPubkey,
  spendDomainOf,
  verifyNoteSignatureForKey,
  type AddressProofAction,
  type Cw1
} from '@lnurlcash/kit'

// LUD-25 notes and their spends, from the wallet's side.
//
// Every note is a BIP-341 taproot output key Q, and a mint files, burns and
// certifies it under hex(Q). A `k1` this wallet holds is a spend of one:
//
//   64 hex          a bearer note's preimage, the short form of its cw1
//   ck1<Q || sig>   key path: a BIP-340 signature by Q
//   cw1<...>        script path: a leaf of Q's tree, its control block and
//                   the witness that satisfies it
//
// The kit (@lnurlcash/kit 0.20) carries the primitives: the canonical spend's
// sighash, the bearer note, the ck1/cw1/cs1 codecs, ck1 signing and
// verification, certificate checks over Q, the address proof and purposed
// key derivation. What stays here is wallet policy the kit leaves to its
// callers: which spends this wallet will judge offline, the ids it files
// notes under (and filed them under before), and the one ladder the kit no
// longer derives.

const HEX32 = /^[0-9a-f]{64}$/i
// BIP-342 keeps the 520-byte cap on every initial stack element.
const MAX_STACK_ELEMENT = 520
const CURVE_ORDER = secp256k1.Point.CURVE().n

const equalBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((byte, i) => byte === b[i])

// The Q a leaf and its control block commit to, or null if the control
// block is malformed or its parity bit is not Q's. The kit computes the
// commitment; the parity is checked here, so a Q returned is exactly the one
// a mint would hold the spend valid against.
export const outputKeyOf = (script: Uint8Array, controlBlock: Uint8Array): Uint8Array | null => {
  const commitment = deriveScriptPathCommitment(script, controlBlock)
  if (!commitment || commitment.parity !== (controlBlock[0]! & 1)) return null
  return commitment.outputKey
}

// A cw1 and the Q it commits to, or null if it is not one.
export const decodeCw1 = (value: string): (Cw1 & {outputKey: Uint8Array}) | null => {
  const fields = decodeCw1Fields(value)
  if (!fields) return null
  const outputKey = outputKeyOf(fields.script, fields.controlBlock)
  return outputKey ? {...fields, outputKey} : null
}

// Stricter than the kit's, which reads the encoding only: a cw1 here also
// has to commit to a Q.
export const isCw1 = (value: string): boolean => decodeCw1(value) !== null

// The `h` inside a leaf, if the leaf is exactly a bearer note's.
export const bearerHashOfLeaf = (script: Uint8Array): Uint8Array | null =>
  script.length === 35 && script[0] === 0xa8 && script[1] === 0x20 && script[34] === 0x87 ? script.subarray(2, 34) : null

// BIP-342's OP_SUCCESSx: 80, 98, 126-129, 131-134, 137-138, 141-142,
// 149-153, 187-254.
const OP_SUCCESS = new Set<number>([80, 98, 137, 138, 141, 142])
for (const [from, to] of [
  [126, 129],
  [131, 134],
  [149, 153],
  [187, 254]
] as const) {
  for (let op = from; op <= to; op++) OP_SUCCESS.add(op)
}

const opcodes = function* (script: Uint8Array): Generator<number> {
  let i = 0
  while (i < script.length) {
    const op = script[i]!
    i += 1
    if (op >= 1 && op <= 75) i += op
    else if (op === 0x4c) {
      if (i + 1 > script.length) return
      i += 1 + script[i]!
    } else if (op === 0x4d) {
      if (i + 2 > script.length) return
      i += 2 + (script[i]! | (script[i + 1]! << 8))
    } else if (op === 0x4e) {
      if (i + 4 > script.length) return
      i += 4 + new DataView(script.buffer, script.byteOffset + i, 4).getUint32(0, true)
    } else yield op
  }
}

// Tapscript's upgrade hooks succeed unconditionally, so a mint refuses a leaf
// using one before anything runs, and so does this wallet.
export const checkLeaf = (script: Uint8Array, controlBlock: Uint8Array): string | null => {
  if (controlBlock.length === 0 || (controlBlock[0]! & 0xfe) !== TAPLEAF_VERSION) return 'unknown tapleaf version'
  for (const op of opcodes(script)) {
    if (OP_SUCCESS.has(op)) return 'leaf uses a reserved OP_SUCCESS opcode'
  }
  return null
}

// A cw1 whose leaf is a bearer note's hashlock, with the one witness item
// that satisfies it: `OP_SHA256 <h> OP_EQUAL` over a lone element under the
// stack-element cap is the whole of what Bitcoin Core would decide about it,
// so this wallet can judge it offline exactly as it judges a preimage. Null
// for any other script, and for a hashlock whose witness does not open it.
// `canonical` is true when the cw1 is the very note the preimage's short form
// names (NUMS internal key, one leaf), so it also has the pre-Q id h.
export const bearerSpendOf = (cw1: Cw1 & {outputKey: Uint8Array}): {h: Uint8Array; canonical: boolean} | null => {
  const h = bearerHashOfLeaf(cw1.script)
  if (!h || checkLeaf(cw1.script, cw1.controlBlock)) return null
  const [preimage, ...rest] = cw1.witness
  if (!preimage || rest.length > 0 || preimage.length > MAX_STACK_ELEMENT) return null
  if (!equalBytes(sha256(preimage), h)) return null
  return {h, canonical: equalBytes(bearerNote(h).outputKey, cw1.outputKey)}
}

// Whether a ck1 opens its Q at `domain` (a note or mint URL, or a bare host),
// and that Q. Only the current shape, signing the domain-bound key-path
// sighash, does: the 65-byte ECDSA ck1 and one signed over the fixed
// "LNURLcash" message are gone from the kit, and this wallet takes neither in.
export const verifyCk1 = (ck1: string, domain: string): {outputKey: Uint8Array} | null => {
  try {
    const opened = recoverNoteOwnershipPubkey(ck1, spendDomainOf(domain))
    return opened ? {outputKey: opened.pubkeyXOnly} : null
  } catch {
    return null
  }
}

// ---- a cx1 branch's note keys ----
//
//   t    = tagged_hash("LNURLcash/derive", P || chaincode || ser32(purpose) || ser32(i)) mod n
//   pk_i = x(lift_x(P) + t·G)
//
// The kit derives every purpose. `null` is the single ladder from before
// purposes (luds 2e5be03), whose tweak has no ser32(purpose): the kit no
// longer derives it, but a mint paid names on it until it moved to purpose 2,
// and a note paid then and never collected is still sitting on it. Only ever
// walked and signed for, never handed out.
export type NotePurpose = 0 | 1 | 2 | null

const ser32 = (n: number): Uint8Array => {
  const bytes = new Uint8Array(4)
  new DataView(bytes.buffer).setUint32(0, n, false)
  return bytes
}

const liftX = (x: Uint8Array) => schnorr.utils.lift_x(BigInt(`0x${bytesToHex(x)}`))

const unpurposedTweak = (branchPubkeyXOnly: Uint8Array, chainCode: Uint8Array, index: number): bigint =>
  BigInt(`0x${bytesToHex(schnorr.utils.taggedHash('LNURLcash/derive', branchPubkeyXOnly, chainCode, ser32(index)))}`) % CURVE_ORDER

export const deriveNotePubkey = (
  branchPubkeyXOnly: Uint8Array,
  chainCode: Uint8Array,
  purpose: NotePurpose,
  index: number
): Uint8Array => {
  if (purpose !== null) return deriveKitNotePubkey(branchPubkeyXOnly, chainCode, purpose, index)
  const t = unpurposedTweak(branchPubkeyXOnly, chainCode, index)
  return schnorr.utils.pointToBytes(liftX(branchPubkeyXOnly).add(secp256k1.Point.BASE.multiply(t)))
}

// The branch key is taken at even y first, as lift_x takes P, or the secret
// would not match the key deriveNotePubkey gives.
export const deriveNoteSecretKey = (
  branchPrivateKey: Uint8Array,
  chainCode: Uint8Array,
  purpose: NotePurpose,
  index: number
): Uint8Array => {
  if (purpose !== null) return deriveKitNoteSecretKey(branchPrivateKey, chainCode, purpose, index)
  const raw = BigInt(`0x${bytesToHex(branchPrivateKey)}`)
  const even = secp256k1.getPublicKey(branchPrivateKey, true)[0] === 2 ? raw : CURVE_ORDER - raw
  const t = unpurposedTweak(schnorr.getPublicKey(branchPrivateKey), chainCode, index)
  return hexToBytes(((even + t) % CURVE_ORDER).toString(16).padStart(64, '0'))
}

// ---- the address registration proof ----

// What LUD-25's address proof signs: sha256("LNURLcash:<action>:<domain>:<name>"),
// `domain` being the SERVICE's bare hostname. The kit signs it
// (signAddressProof) but does not export the digest, which this wallet needs
// to check a proof a heartwood signed before sending it on.
export const addressProofDigest = (action: AddressProofAction, domain: string, username: string): Uint8Array =>
  sha256(utf8ToBytes(`LNURLcash:${action}:${spendDomainOf(domain)}:${username}`))

// ---- note ids ----

// hex(Q) of whatever `k1` spends, read locally and verifying nothing: the id
// this wallet files a note under, and the one a mint burns it by. Two spends
// of one note (a preimage and its cw1, two spellings of a ck1) share it, so
// notes are compared by this, never by k1. Null if `k1` is no spend at all.
export const noteIdOf = (k1: string): string | null => {
  if (typeof k1 !== 'string') return null
  const value = k1.trim().toLowerCase()
  if (HEX32.test(value)) return bearerNoteIdOfPreimage(value)
  const cw1 = decodeCw1(value)
  if (cw1) return bytesToHex(cw1.outputKey)
  const outputKey = ck1Pubkey(value)
  return outputKey ? bytesToHex(outputKey) : null
}

// The id a wallet filed this note under before notes were keyed by Q:
// sha256(preimage) for a bearer note, the key itself for a key note. What an
// older wallet file, backup or relay record may still carry.
export const legacyNoteIdOf = (k1: string): string | null => {
  if (typeof k1 !== 'string') return null
  const value = k1.trim().toLowerCase()
  if (HEX32.test(value)) return bytesToHex(sha256(hexToBytes(value)))
  const cw1 = decodeCw1(value)
  if (cw1) {
    const bearer = bearerSpendOf(cw1)
    return bearer?.canonical ? bytesToHex(bearer.h) : bytesToHex(cw1.outputKey)
  }
  const outputKey = ck1Pubkey(value)
  return outputKey ? bytesToHex(outputKey) : null
}

// The `h` a canonical bearer note has, where it has one: a hex preimage's
// sha256, or the hash in a bearer cw1's leaf. Its short form on the wire.
export const bearerHashOf = (k1: string): string | null => {
  const value = k1.trim().toLowerCase()
  if (HEX32.test(value)) return bytesToHex(sha256(hexToBytes(value)))
  const cw1 = decodeCw1(value)
  const bearer = cw1 ? bearerSpendOf(cw1) : null
  return bearer?.canonical ? bytesToHex(bearer.h) : null
}

// ---- offline verification ----

// Does `certificate` certify this note at this amount under `mintPubkey`?
//
// LUD-25 certifies every note over hex(Q), as a cs1<amount>, and the kit
// does the recovery. A mint from before that change certified a bearer note
// over its h instead, as 65 bytes of hex (`sig`), or as the fixed-HRP cs1
// with no amount in it - and such a mint still answers only in that shape,
// so a note it issued, or rotated, carries nothing else. Those are checked
// under the rule they were made under, for a bearer preimage only: the
// digest is the same Lightning signed-message construction with h in place
// of hex(Q), so the kit checks it once the signature is re-wrapped as a
// cs1<amount>. Both byte layouts the old rule took (recovery id trailing, and
// leading, as lnurl-mint once emitted it) are tried. It accepts nothing but a
// real signature by this mint's key over this note's h and this amount.
//
// A cs1<amount> over h, or any older shape on a ck1 or a cw1, certifies
// nothing here: no mint ever issued one.
export const verifyNoteCertificate = (
  k1: string,
  amountMsat: number,
  certificate: string,
  mintPubkey: string
): boolean => {
  const value = certificate.trim()
  if (isCs1WithAmount(value)) {
    const id = noteIdOf(k1)
    return id !== null && verifyNoteSignatureForKey(id, amountMsat, value, mintPubkey)
  }
  const signature = legacyCertificateBytes(value)
  const preimage = k1.trim().toLowerCase()
  if (!signature || !HEX32.test(preimage)) return false
  const h = bytesToHex(sha256(hexToBytes(preimage)))
  for (const layout of [signature, new Uint8Array([...signature.subarray(1), signature[0]!])]) {
    try {
      if (verifyNoteSignatureForKey(h, amountMsat, encodeCs1WithAmount(amountMsat, layout), mintPubkey)) return true
    } catch {
      // not a certificate under this layout
    }
  }
  return false
}

const LEGACY_HEX_CERTIFICATE = /^[0-9a-f]{130}$/i

// The 65 signature bytes of a certificate in a shape from before LUD-25's
// cs1<amount>: plain hex, or the fixed-HRP cs1 (bech32m, or bech32 from an
// encoder that used it). Null for anything else, a cs1<amount> included.
const legacyCertificateBytes = (value: string): Uint8Array | null => {
  const trimmed = value.trim()
  if (LEGACY_HEX_CERTIFICATE.test(trimmed)) return hexToBytes(trimmed.toLowerCase())
  for (const codec of [bech32m, bech32]) {
    try {
      const decoded = codec.decode(trimmed.toLowerCase() as `${string}1${string}`, false)
      if (decoded.prefix !== 'cs') continue
      const bytes = codec.fromWords(decoded.words)
      if (bytes.length === 65) return bytes
    } catch {
      // try the next variant
    }
  }
  return null
}

// Whether a certificate is one of those older shapes. Such a certificate
// travels as `sig` beside `amount`, the names it was issued under, since it
// carries no amount of its own.
export const isLegacyCertificate = (value: string): boolean => legacyCertificateBytes(value) !== null

export type SpendCheck =
  | {ok: true; noteId: string}
  | {ok: false; reason: string; onlineOnly: boolean}

// LUD-25's offline step 2: does this spend open its note, as a mint would
// judge it, at the note URL's `domain`? A preimage always does. A ck1 must
// sign for this mint. A bearer cw1 is judged here like a preimage. Any other
// script needs a script interpreter, which this wallet does not carry: only
// the mint can judge it, online, and `onlineOnly` says so.
export const checkSpendOffline = (k1: string, domain: string): SpendCheck => {
  const value = k1.trim().toLowerCase()
  if (HEX32.test(value)) return {ok: true, noteId: bearerNoteIdOfPreimage(value)}
  const cw1 = decodeCw1(value)
  if (cw1) {
    const leafProblem = checkLeaf(cw1.script, cw1.controlBlock)
    if (leafProblem) return {ok: false, reason: `this cw1 can never be spent: ${leafProblem}`, onlineOnly: false}
    if (bearerHashOfLeaf(cw1.script)) {
      return bearerSpendOf(cw1)
        ? {ok: true, noteId: bytesToHex(cw1.outputKey)}
        : {ok: false, reason: 'this cw1 carries a witness that does not open its hashlock', onlineOnly: false}
    }
    return {
      ok: false,
      reason: 'this note is locked by a script only its mint can judge, so it can only be checked online',
      onlineOnly: true
    }
  }
  if (!decodeCk1(value)) return {ok: false, reason: 'that k1 is not a spend of any note', onlineOnly: false}
  const opened = verifyCk1(value, domain)
  return opened
    ? {ok: true, noteId: bytesToHex(opened.outputKey)}
    : {ok: false, reason: `this ck1 does not sign for its note at ${spendDomainOf(domain)}`, onlineOnly: false}
}
