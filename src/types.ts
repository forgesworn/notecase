// The wallet's data model. Every amount is integer milli-satoshis.
//
// Note states, and what they mean for the money:
//
//   live       spendable; the k1 in this record is the only copy
//   staged     a fresh secret whose HASH has (or may have) been disclosed
//              to a mint by a mutation whose outcome is not yet recorded.
//              If that mutation landed, this k1 is the only copy of the
//              output - staged records are money until proven otherwise.
//   ambiguous  a mutation's outcome is unknown (timeout, dropped
//              connection, crash). reconcile() resolves it by probing.
//   melting    reserved by a melt in flight at the mint
//   sent       handed to someone else; excluded from balance, kept so the
//              note can be reclaimed if the recipient never takes it
//   spent      burned at the mint; kept for history

export type NoteState = 'live' | 'staged' | 'ambiguous' | 'melting' | 'sent' | 'spent'

export type NoteOrigin = 'mint' | 'receive' | 'rotate' | 'split' | 'change' | 'merge' | 'recovered'

export type NoteRecord = {
  id: string
  k1: string
  amountMsat: number
  // The informational GET endpoint, no query - the note URL is
  // baseUrl?k1=...&amount=...
  baseUrl: string
  callback: string
  mintHost: string
  signature?: string
  state: NoteState
  origin: NoteOrigin
  // For staged/ambiguous records: the input note ids the mutation that
  // created this consumed. reconcile() groups by this to learn the fate of
  // the whole mutation from one probe.
  replaces?: string[]
  // Nostr provenance: the pubkey this note was gift-wrapped to, or came
  // from. A note with either is never wrapped again.
  sentTo?: string
  receivedFrom?: string
  createdAt: number
  updatedAt: number
}

export type PendingMint = {
  // the invoice's payment hash, which is also the future note's id
  id: string
  mintHost: string
  baseUrl: string
  pr: string
  verifyUrl?: string
  grossMsat: number
  expectedNetMsat: number
  state: 'awaiting' | 'claimed' | 'expired' | 'abandoned'
  // Held only between claim and a confirmed receive; deleted once the note
  // is safely in the wallet. It is the note's k1 - while it sits here the
  // money is a persisted record reconcile() can re-drive, never a memory.
  preimageHex?: string
  createdAt: number
  updatedAt: number
}

export type MeltRecord = {
  paymentHash: string
  noteId: string
  pr: string
  verifyUrl?: string
  amountMsat: number
  // where the money went: 'invoice', a Lightning Address, or 'nwc'
  target: string
  state: 'in-flight' | 'settled' | 'returned'
  // set when a LUD-21 verify cryptographically proved settlement
  proofPreimage?: string
  createdAt: number
  updatedAt: number
}

export type MintEntry = {
  // as the user gave it: a Lightning Address or an LNURL-pay URL
  input: string
  host: string
  payUrl: string
  baseUrl?: string
  label?: string
  // The advertised mint fee, cached so mutations can price themselves per
  // LUD-25 (base fee out of a split's change, (n-1) refunds on a merge)
  // without a round trip. Refreshed whenever the payRequest is fetched.
  mintFee?: {baseFeeMsat: number; feePpm: number}
  addedAt: number
}

export type WalletData = {
  version: 1
  settings: {
    defaultMintHost?: string
    // A spending capability - the store holding this must stay encrypted.
    nwcUri?: string
    // The wallet's Nostr identity, for sending and receiving notes as gift
    // wraps. A signing key: the store holding this must stay encrypted.
    nostrSecretHex?: string
    // Inbox relays published as kind 10050, and where we look for wraps.
    nostrRelays?: string[]
    // Wrap ids already opened or refused, so a relay replay is idle.
    nostrSeenWrapIds?: string[]
    nostrLastCheck?: number
    // A paired heartwood signer holding notes of its own (heartwood.ts).
    // The client key is what the device bound; the store guards it.
    heartwood?: {uri: string; devicePubkey: string; relays: string[]; clientSecretHex: string}
  }
  mints: MintEntry[]
  // Trust-on-first-use pins: mint host -> the mintPubkey first observed
  // there. A later mismatch is surfaced hard, never silently accepted.
  pubkeyPins: Record<string, string>
  notes: NoteRecord[]
  pendingMints: PendingMint[]
  melts: MeltRecord[]
}

export const emptyWallet = (): WalletData => ({
  version: 1,
  settings: {},
  mints: [],
  pubkeyPins: {},
  notes: [],
  pendingMints: [],
  melts: []
})
