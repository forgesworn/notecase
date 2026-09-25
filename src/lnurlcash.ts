// Notecase's integration boundary. Protocol behaviour comes from the
// reference wallet package; deterministic recovery, payment requests and
// per-wallet transport configuration remain application policy here.
import {decodeCs1WithAmount, isCk1, isPreimage, noteK1, resolveLnurlInput} from '@lnurlcash/kit'
import {isCw1} from './spend.ts'
export * from '@lnurlcash/kit'
// Every note is a taproot output key now (LUD-25's unified verification).
// The pinned kit still ids a bearer note by its hash, signs a ck1 over a fixed
// message and knows no cw1, so these names are this wallet's own and shadow
// the kit's: a caller importing from here cannot reach the old behaviour.
export {
  TAPLEAF_VERSION,
  NUMS_H,
  addressProofDigest,
  bearerNote,
  bearerNoteId,
  bearerNoteIdOfPreimage,
  bearerHashOf,
  bearerSpendOf,
  certificateIdsOf,
  checkLeaf,
  checkSpendOffline,
  ck1OutputKey,
  decodeCw1,
  deriveNotePubkey,
  deriveNoteSecretKey,
  encodeCw1,
  isCw1,
  keyPathSighash,
  legacyNoteIdOf,
  noteIdOf,
  outputKeyOf,
  signAddressProof,
  signNoteOwnership,
  spendDomainOf,
  spendPrevout,
  spendSigMsg,
  tapLeafHash,
  verifyCk1,
  verifyNoteCertificate,
  verifyNoteCertificate as verifyNoteSignature,
  NOTE_PURPOSE_WALLET,
  NOTE_PURPOSE_CHANGE,
  NOTE_PURPOSE_LIGHTNING_ADDRESS,
  type NotePurpose,
  type AddressProofAction,
  type Cw1,
  type SpendCheck
} from './spend.ts'

// A note's k1 is a spend: a bearer preimage, a ck1, or a cw1.
export const isValidK1 = (value: string): boolean => isPreimage(value) || isCk1(value) || isCw1(value)

// The kit's own, admitting a cw1 as well: an input is a note only if it
// resolves to a URL carrying a spend.
export const resolveNoteInput = (value: string): string | null => {
  const url = resolveLnurlInput(value)
  const k1 = url ? noteK1(url) : null
  if (!url || !k1 || !isValidK1(k1)) return null
  return url
}

export const isValidNoteInput = (value: string): boolean => resolveNoteInput(value) !== null

// LUD-25 renamed a note URL's certificate from `sig` to `c`. Both are read,
// the new name first, so a note from either kind of wallet keeps its
// certificate here.
export const noteSignature = (url: string): string | null => {
  try {
    const params = new URL(url).searchParams
    return params.get('c') ?? params.get('sig')
  } catch {
    return null
  }
}

export const noteDeclaredAmount = (url: string): number | null => {
  try {
    const raw = new URL(url).searchParams.get('amount')
    if (raw !== null) {
      const n = Number(raw)
      return Number.isFinite(n) ? n : null
    }
    const certificate = noteSignature(url)
    return certificate ? decodeCs1WithAmount(certificate)?.amountMsat ?? null : null
  } catch {
    return null
  }
}
export * from './cash.js'
export {deriveNoteRoot, deriveNoteSecret} from './legacy-secrets.js'
export * from './payment-request.js'
export * from './restore.js'
export {
  defaultRandomSecret,
  mintFeeBand,
  deriveCashAddressNode,
  deriveLegacyCashAddressNode,
  cashNodeToCx1,
  deriveNostrCashSeed,
  deriveNostrAddressNode,
  deriveLegacyNostrAddressNode,
  mergeBatches,
  type RandomSecret,
  type MintFeeBand,
  type CashXpub,
  type MergeBatchOptions
} from './lnurlcash-policy.js'
export {
  fetchPayRequest,
  fetchMintAddress,
  fetchNoteInfo,
  fetchNoteInfoByHash,
  fetchNoteInfoByPubkey,
  fetchInvoiceVerification,
  probeBurnedNote,
  meltNote,
  rotateNoteWithHash,
  splitNoteWithHash,
  mergeNotesWithHash,
  requestInvoice,
  type LnurlcashOptions,
  type MintAddressExtensions,
  type WithdrawInfoExtensions,
  type CompatibleHashedMutationResult,
  type CompatibleHashedSplitResult
} from './lnurlcash-network.js'
export {
  ProtocolError,
  HashLookupUnsupportedError
} from './lnurlcash-errors.js'
export {ServiceError as ServiceRejectedError} from '@lnurlcash/kit'
