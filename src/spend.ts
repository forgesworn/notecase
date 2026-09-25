import {sha256} from '@noble/hashes/sha2.js'
import {schnorr, secp256k1} from '@noble/curves/secp256k1.js'
import {bytesToHex, concatBytes, hexToBytes, utf8ToBytes} from '@noble/hashes/utils.js'
import {bech32m} from '@scure/base'
import {decodeCk1, fromLud17, verifyNoteSignatureHash} from '@lnurlcash/kit'

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
// Every signature signs the BIP-341 sighash of input 0 of one fixed,
// never-broadcast transaction whose prevout is bound to the mint's domain,
// so a ck1 one mint has seen cannot be replayed at another.
//
// The primitives here follow moneyer's src/spend.ts field for field, and the
// reference kit's own; this wallet's pinned kit predates them. The ck1 codec
// and the cs1 check still come from the kit.

export const TAPLEAF_VERSION = 0xc0
export const KEY_PATH_LOCKTIME = 0
export const KEY_PATH_SEQUENCE = 0xffffffff

// BIP-341's nothing-up-my-sleeve point. Nobody knows its discrete log, so a
// note built on it has no key path: only its leaf can spend it.
export const NUMS_H = hexToBytes('50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0')

const HEX32 = /^[0-9a-f]{64}$/i
const MAX_MERKLE_DEPTH = 128
// BIP-342 keeps the 520-byte cap on every initial stack element.
const MAX_STACK_ELEMENT = 520
// No URL gets near this; it only stops a hostile string costing work.
const MAX_BECH32_CHARS = 8192
const CURVE_ORDER = secp256k1.Point.CURVE().n

const taggedHash = (tag: string, ...parts: Uint8Array[]): Uint8Array => schnorr.utils.taggedHash(tag, ...parts)

const compactSize = (n: number): Uint8Array => {
  if (n < 0xfd) return new Uint8Array([n])
  if (n <= 0xffff) return new Uint8Array([0xfd, n & 0xff, n >> 8])
  const out = new Uint8Array(5)
  out[0] = 0xfe
  new DataView(out.buffer).setUint32(1, n, true)
  return out
}

const u32le = (n: number): Uint8Array => {
  const out = new Uint8Array(4)
  new DataView(out.buffer).setUint32(0, n, true)
  return out
}

const equalBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((byte, i) => byte === b[i])

const liftX = (x: Uint8Array) => {
  if (x.length !== 32) return null
  try {
    return schnorr.utils.lift_x(BigInt(`0x${bytesToHex(x)}`))
  } catch {
    return null
  }
}

export const isXOnlyPoint = (x: Uint8Array): boolean => liftX(x) !== null

export const tapLeafHash = (script: Uint8Array, version = TAPLEAF_VERSION): Uint8Array =>
  taggedHash('TapLeaf', new Uint8Array([version]), compactSize(script.length), script)

// Q = lift_x(P) + tagged_hash("TapTweak", P || root)·G, with Q's parity.
// Null if P is not a point or the tweak is out of range.
export const taprootTweak = (
  internalKey: Uint8Array,
  merkleRoot: Uint8Array
): {outputKey: Uint8Array; parity: 0 | 1} | null => {
  const p = liftX(internalKey)
  if (!p) return null
  const t = BigInt(`0x${bytesToHex(taggedHash('TapTweak', internalKey, merkleRoot))}`)
  if (t >= CURVE_ORDER) return null
  const q = p.add(secp256k1.Point.BASE.multiply(t))
  if (q.equals(secp256k1.Point.ZERO)) return null
  return {outputKey: schnorr.utils.pointToBytes(q), parity: q.y % 2n === 0n ? 0 : 1}
}

// The Q a leaf and its control block commit to, or null if the control
// block is malformed. The parity bit is checked too, so a Q returned here is
// exactly the one the spend is valid against.
export const outputKeyOf = (script: Uint8Array, controlBlock: Uint8Array): Uint8Array | null => {
  if (controlBlock.length < 33 || (controlBlock.length - 33) % 32 !== 0) return null
  if ((controlBlock.length - 33) / 32 > MAX_MERKLE_DEPTH) return null
  let node = tapLeafHash(script, controlBlock[0]! & 0xfe)
  for (let i = 33; i < controlBlock.length; i += 32) {
    const sibling = controlBlock.subarray(i, i + 32)
    node = bytesToHex(node) < bytesToHex(sibling)
      ? taggedHash('TapBranch', node, sibling)
      : taggedHash('TapBranch', sibling, node)
  }
  const tweaked = taprootTweak(controlBlock.subarray(1, 33), node)
  if (!tweaked || tweaked.parity !== (controlBlock[0]! & 1)) return null
  return tweaked.outputKey
}

// ---- the bearer note ----
//
// NUMS internal key, one `OP_SHA256 <h> OP_EQUAL` leaf: spent by revealing
// the preimage, with no signature and so bound to no mint. Everything but the
// preimage follows from h, which is why its short forms work, and why this
// wallet can go on disclosing h on the wire while filing the note under Q.

export const bearerLeaf = (h: Uint8Array): Uint8Array => {
  if (h.length !== 32) throw new Error('h must be 32 bytes.')
  return concatBytes(new Uint8Array([0xa8, 0x20]), h, new Uint8Array([0x87]))
}

export const bearerNote = (h: Uint8Array): {outputKey: Uint8Array; controlBlock: Uint8Array; leaf: Uint8Array} => {
  const leaf = bearerLeaf(h)
  const tweaked = taprootTweak(NUMS_H, tapLeafHash(leaf))
  // NUMS_H is a point and a hash is never out of range in practice.
  if (!tweaked) throw new Error('Bearer note tweak failed.')
  return {
    outputKey: tweaked.outputKey,
    controlBlock: concatBytes(new Uint8Array([TAPLEAF_VERSION | tweaked.parity]), NUMS_H),
    leaf
  }
}

// hex(Q) of the bearer note whose hash is `hHex`.
export const bearerNoteId = (hHex: string): string => bytesToHex(bearerNote(hexToBytes(hHex.toLowerCase())).outputKey)

// hex(Q) of the bearer note a hex preimage opens.
export const bearerNoteIdOfPreimage = (k1Hex: string): string =>
  bytesToHex(bearerNote(sha256(hexToBytes(k1Hex.trim().toLowerCase()))).outputKey)

// The `h` inside a leaf, if the leaf is exactly a bearer note's.
export const bearerHashOfLeaf = (script: Uint8Array): Uint8Array | null =>
  script.length === 35 && script[0] === 0xa8 && script[1] === 0x20 && script[34] === 0x87 ? script.subarray(2, 34) : null

// ---- what a signature signs ----

// The bare lowercase hostname a spend at `value` is bound to - a note URL
// (lnurlw:// included), a mint's origin, or the host[:port] this wallet files
// a mint under - never its scheme or port.
export const spendDomainOf = (value: string): string => {
  const expanded = fromLud17(value.trim())
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(expanded) ? expanded : `https://${expanded}`
  const host = new URL(candidate).hostname.toLowerCase()
  if (!host) throw new Error('A spend domain needs a hostname.')
  return host
}

export const spendPrevout = (domain: string): Uint8Array => {
  if (!domain) throw new Error('A spend domain is required.')
  return taggedHash('LNURLcash/mint', utf8ToBytes(domain.toLowerCase()))
}

const I64_ZERO = new Uint8Array(8)

// BIP-341's SigMsg for input 0 of the canonical spend transaction under
// SIGHASH_DEFAULT, with BIP-342's extension when a leaf is given.
export const spendSigMsg = (args: {
  outputKey: Uint8Array
  domain: string
  locktime: number
  sequence: number
  leafScript?: Uint8Array
}): Uint8Array => {
  if (args.outputKey.length !== 32) throw new Error('Q must be 32 bytes.')
  const scriptPubKey = concatBytes(new Uint8Array([0x51, 0x20]), args.outputKey)
  const parts = [
    new Uint8Array([0x00]), // hash_type
    u32le(2), // nVersion
    u32le(args.locktime),
    sha256(concatBytes(spendPrevout(args.domain), u32le(0))), // sha_prevouts
    sha256(I64_ZERO), // sha_amounts
    sha256(concatBytes(new Uint8Array([scriptPubKey.length]), scriptPubKey)), // sha_scriptpubkeys
    sha256(u32le(args.sequence)), // sha_sequences
    sha256(concatBytes(I64_ZERO, new Uint8Array([0x00]))), // sha_outputs
    new Uint8Array([args.leafScript ? 0x02 : 0x00]), // spend_type, no annex
    u32le(0) // input_index
  ]
  if (args.leafScript) {
    parts.push(tapLeafHash(args.leafScript), new Uint8Array([0x00]), new Uint8Array([0xff, 0xff, 0xff, 0xff]))
  }
  return concatBytes(...parts)
}

// What a ck1's signature signs.
export const keyPathSighash = (outputKey: Uint8Array, domain: string): Uint8Array =>
  taggedHash(
    'TapSighash',
    new Uint8Array([0x00]),
    spendSigMsg({outputKey, domain, locktime: KEY_PATH_LOCKTIME, sequence: KEY_PATH_SEQUENCE})
  )

// ---- cw1: a script-path spend ----

export type Cw1 = {
  locktime: number
  sequence: number
  script: Uint8Array
  controlBlock: Uint8Array
  // Bottom of the stack first, script and control block excluded.
  witness: Uint8Array[]
}

export const encodeCw1 = (spend: Cw1): string => {
  const head = new Uint8Array(8)
  new DataView(head.buffer).setUint32(0, spend.locktime, false)
  new DataView(head.buffer).setUint32(4, spend.sequence, false)
  const items = [spend.script, spend.controlBlock, ...spend.witness].map(item => {
    const len = new Uint8Array(2)
    new DataView(len.buffer).setUint16(0, item.length, false)
    return concatBytes(len, item)
  })
  return bech32m.encode('cw', bech32m.toWords(concatBytes(head, ...items)), MAX_BECH32_CHARS)
}

// A cw1 and the Q its leaf and control block commit to, or null if it is not
// one. Length prefixes must consume the payload exactly, as a mint demands.
export const decodeCw1 = (value: string): (Cw1 & {outputKey: Uint8Array}) | null => {
  const trimmed = value.trim().toLowerCase()
  if (!trimmed.startsWith('cw1')) return null
  let data: Uint8Array
  try {
    const decoded = bech32m.decode(trimmed as `${string}1${string}`, MAX_BECH32_CHARS)
    if (decoded.prefix !== 'cw') return null
    data = bech32m.fromWords(decoded.words)
  } catch {
    return null
  }
  if (data.length < 8) return null
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const parts: Uint8Array[] = []
  let i = 8
  while (i < data.length) {
    if (i + 2 > data.length) return null
    const n = view.getUint16(i, false)
    i += 2
    if (i + n > data.length) return null
    parts.push(data.slice(i, i + n))
    i += n
  }
  if (parts.length < 2) return null
  const outputKey = outputKeyOf(parts[0]!, parts[1]!)
  if (!outputKey) return null
  return {
    outputKey,
    locktime: view.getUint32(0, false),
    sequence: view.getUint32(4, false),
    script: parts[0]!,
    controlBlock: parts[1]!,
    witness: parts.slice(2)
  }
}

export const isCw1 = (value: string): boolean => decodeCw1(value) !== null

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

// ---- ck1: a key-path spend ----

// The deprecated fixed messages a ck1 signed before spends moved onto the
// canonical transaction. Never signed here any more; only read, as the
// reference mint still reads them, so notes already handed out keep working.
const LEGACY_OWNERSHIP_MESSAGE = utf8ToBytes('LNURLcash')
const LEGACY_OWNERSHIP_DIGEST = sha256(LEGACY_OWNERSHIP_MESSAGE)
const LEGACY_ECDSA_DIGEST = sha256(sha256(utf8ToBytes('Lightning Signed Message:LNURLcash')))

const recoverLegacyCk1 = (signature: Uint8Array): Uint8Array | null => {
  if (signature.length !== 65) return null
  try {
    const recidLeading = concatBytes(new Uint8Array([signature[64]!]), signature.subarray(0, 64))
    return secp256k1.recoverPublicKey(recidLeading, LEGACY_ECDSA_DIGEST, {prehash: false}).subarray(1)
  } catch {
    return null
  }
}

const schnorrVerifies = (signature: Uint8Array, message: Uint8Array, key: Uint8Array): boolean => {
  try {
    return schnorr.verify(signature, message, key)
  } catch {
    return false
  }
}

// The Q a ck1 names, decoded only: nothing is verified. The 65-byte ECDSA
// shape from before LUD-25 carries no Q, so it is recovered, and recovery is
// its whole check.
export const ck1OutputKey = (ck1: string): Uint8Array | null => {
  const decoded = decodeCk1(ck1)
  if (!decoded) return null
  return decoded.legacy ? recoverLegacyCk1(decoded.signature) : decoded.pubkeyXOnly
}

// Whether a ck1 opens its Q at `domain`, and that Q. The current shape signs
// the domain-bound sighash; `legacy` marks one signed over a deprecated fixed
// message, which opens its note at any mint that still reads them.
export const verifyCk1 = (ck1: string, domain: string): {outputKey: Uint8Array; legacy: boolean} | null => {
  const decoded = decodeCk1(ck1)
  if (!decoded) return null
  if (decoded.legacy) {
    const outputKey = recoverLegacyCk1(decoded.signature)
    return outputKey ? {outputKey, legacy: true} : null
  }
  const {pubkeyXOnly: outputKey, signature} = decoded
  let sighash: Uint8Array
  try {
    sighash = keyPathSighash(outputKey, spendDomainOf(domain))
  } catch {
    return null
  }
  if (schnorrVerifies(signature, sighash, outputKey)) return {outputKey, legacy: false}
  if (
    schnorrVerifies(signature, LEGACY_OWNERSHIP_DIGEST, outputKey) ||
    schnorrVerifies(signature, LEGACY_OWNERSHIP_MESSAGE, outputKey)
  ) {
    return {outputKey, legacy: true}
  }
  return null
}

// BIP-340's aux_rand hardens a signer that signs the same thing repeatedly
// under fault attack; it is not what makes one signature secure. LUD-25 asks
// for all-zero here so a key's ck1 at a mint is a pure function of the key
// and the domain: a note found again by a scan re-derives the same ck1, byte
// for byte, which is what test vector 3 pins.
const ZERO_AUX_RAND = new Uint8Array(32)

// A key's ck1 signature for the note at `domain` (a note or mint URL, or a
// bare host). Returns Q alongside it; encodeCk1 joins the two.
export const signNoteOwnership = (
  secretKey: Uint8Array,
  domain: string
): {pubkeyXOnly: Uint8Array; signature: Uint8Array} => {
  const pubkeyXOnly = schnorr.getPublicKey(secretKey)
  return {
    pubkeyXOnly,
    signature: schnorr.sign(keyPathSighash(pubkeyXOnly, spendDomainOf(domain)), secretKey, ZERO_AUX_RAND)
  }
}

// ---- the address registration proof ----

// ---- a cx1 branch's note keys ----
//
//   t    = tagged_hash("LNURLcash/derive", P || chaincode || ser32(purpose) || ser32(i)) mod n
//   pk_i = x(lift_x(P) + t·G)
//
// `purpose` splits a branch into independent counters: 0 for a wallet's own
// notes (and the address proof's index 0), 1 for split change, 2 for what a
// Lightning Address or an internal transfer delivers. `null` is the single
// ladder before purposes (luds 2e5be03): notes already paid to it stay there,
// and heartwood firmware still derives it.
export const NOTE_PURPOSE_WALLET = 0
export const NOTE_PURPOSE_CHANGE = 1
export const NOTE_PURPOSE_LIGHTNING_ADDRESS = 2
export type NotePurpose = typeof NOTE_PURPOSE_WALLET | typeof NOTE_PURPOSE_CHANGE | typeof NOTE_PURPOSE_LIGHTNING_ADDRESS | null

const ser32 = (n: number): Uint8Array => {
  const bytes = new Uint8Array(4)
  new DataView(bytes.buffer).setUint32(0, n, false)
  return bytes
}

const noteTweak = (branchPubkeyXOnly: Uint8Array, chainCode: Uint8Array, purpose: NotePurpose, index: number): bigint => {
  const counter = purpose === null ? [ser32(index)] : [ser32(purpose), ser32(index)]
  return BigInt(`0x${bytesToHex(taggedHash('LNURLcash/derive', branchPubkeyXOnly, chainCode, ...counter))}`) % CURVE_ORDER
}

export const deriveNotePubkey = (
  branchPubkeyXOnly: Uint8Array,
  chainCode: Uint8Array,
  purpose: NotePurpose,
  index: number
): Uint8Array => {
  const p = liftX(branchPubkeyXOnly)
  if (!p) throw new Error('The branch key is not on the curve.')
  return schnorr.utils.pointToBytes(p.add(secp256k1.Point.BASE.multiply(noteTweak(branchPubkeyXOnly, chainCode, purpose, index))))
}

// The branch key is taken at even y first, as lift_x takes P, or the secret
// would not match the key deriveNotePubkey gives.
export const deriveNoteSecretKey = (
  branchPrivateKey: Uint8Array,
  chainCode: Uint8Array,
  purpose: NotePurpose,
  index: number
): Uint8Array => {
  const raw = BigInt(`0x${bytesToHex(branchPrivateKey)}`)
  const even = secp256k1.getPublicKey(branchPrivateKey, true)[0] === 2 ? raw : CURVE_ORDER - raw
  const t = noteTweak(schnorr.getPublicKey(branchPrivateKey), chainCode, purpose, index)
  return hexToBytes(((even + t) % CURVE_ORDER).toString(16).padStart(64, '0'))
}

export type AddressProofAction = 'register' | 'unregister'

// LUD-25's proof that a cx1 branch agrees to a name pointing at it, or away
// from it: its purpose-0 index-0 key signing sha256("LNURLcash:<action>:<domain>:<name>").
// `domain` is the SERVICE's own hostname, so a proof one mint has seen cannot
// be replayed at another. Zero aux_rand, so a retried request resends the
// same proof rather than a fresh one that is equally valid.
export const addressProofDigest = (action: AddressProofAction, domain: string, username: string): Uint8Array =>
  sha256(utf8ToBytes(`LNURLcash:${action}:${spendDomainOf(domain)}:${username}`))

export const signAddressProof = (
  branchIndexZeroSecretKey: Uint8Array,
  action: AddressProofAction,
  domain: string,
  username: string
): Uint8Array => schnorr.sign(addressProofDigest(action, domain, username), branchIndexZeroSecretKey, ZERO_AUX_RAND)

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
  const outputKey = ck1OutputKey(value)
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
  const outputKey = ck1OutputKey(value)
  return outputKey ? bytesToHex(outputKey) : null
}

// The `h` a canonical bearer note discloses on the wire, where it has one:
// a hex preimage's sha256, or the hash in a bearer cw1's leaf.
export const bearerHashOf = (k1: string): string | null => {
  const value = k1.trim().toLowerCase()
  if (HEX32.test(value)) return bytesToHex(sha256(hexToBytes(value)))
  const cw1 = decodeCw1(value)
  const bearer = cw1 ? bearerSpendOf(cw1) : null
  return bearer?.canonical ? bytesToHex(bearer.h) : null
}

// ---- offline verification ----

// What a mint's cs1 for this note may be signed over. Every note is now
// certified over hex(Q). A mint from before that certified a bearer note over
// its h instead, so for a bearer note h is tried after Q, and a certificate
// under neither is refused exactly as before.
export const certificateIdsOf = (k1: string): string[] => {
  const id = noteIdOf(k1)
  if (!id) return []
  const h = bearerHashOf(k1)
  return h && h !== id ? [id, h] : [id]
}

// Does `signature` (plain hex or cs1) certify this note at this amount under
// `mintPubkey`? The kit does the recovery; this only chooses what it is over.
export const verifyNoteCertificate = (
  k1: string,
  amountMsat: number,
  signature: string,
  mintPubkey: string
): boolean => certificateIdsOf(k1).some(id => verifyNoteSignatureHash(id, amountMsat, signature, mintPubkey))

export type SpendCheck =
  | {ok: true; noteId: string}
  | {ok: false; reason: string; onlineOnly: boolean}

// LUD-25's offline step 2: does this spend open its note, as a mint would
// judge it, at the note URL's `domain`? A preimage always does. A ck1 must
// sign for this mint (or be one of the deprecated shapes a mint still reads).
// A bearer cw1 is judged here like a preimage. Any other script needs a
// script interpreter, which this wallet does not carry: only the mint can
// judge it, online, and `onlineOnly` says so.
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
