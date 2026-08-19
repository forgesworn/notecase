// notecase - a case for Lightning bearer notes (LNURLcash, LUD-25).
//
// A second, independent wallet implementation: not a fork of the reference
// wallet, built instead on lnurlcash-kit for the protocol, farrier-kit for
// invoice verification, nwc-kit for the Lightning arm, keystore-kit for
// key-at-rest and shamir-words for backup shares.
//
// The design centre is crash-safety around bearer secrets: every fresh
// secret is persisted before its hash is disclosed, every uncertain
// outcome is parked rather than guessed at, and reconcile() resolves the
// parked ones by probing the mint - never by assumption.

export {Wallet, InsufficientFundsError, PinMismatchError, WalletUsageError} from './wallet.ts'
export type {ReceiveResult, ReconcileEvent} from './wallet.ts'
export {
  initWallet,
  openWallet,
  walletHome,
  WrongPinError,
  NoWalletError,
  WalletExistsError,
  type WalletStore
} from './store.ts'
export {createWalletFetch} from './fetchguard.ts'
export {exportBackup, importBackup, BackupError, type BackupEnvelope} from './backup.ts'
export {payWithNwc, invoiceFromNwc, nwcStatus, NwcPaymentUnprovenError, type NwcOptions} from './nwc.ts'
export {emptyWallet} from './types.ts'
export type {
  WalletData,
  NoteRecord,
  NoteState,
  NoteOrigin,
  MintEntry,
  PendingMint,
  MeltRecord
} from './types.ts'
