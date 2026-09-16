// Notecase's integration boundary. Protocol behaviour comes from the
// reference wallet package; deterministic recovery, payment requests and
// per-wallet transport configuration remain application policy here.
export * from '@lnurlcash/kit'
export * from './cash.js'
export {deriveNoteRoot, deriveNoteSecret} from './legacy-secrets.js'
export * from './payment-request.js'
export * from './restore.js'
export {
  defaultRandomSecret,
  mintFeeBand,
  noteIdOf,
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
