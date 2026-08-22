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
  // Which derived secret this note's k1 is: the index under its mint's
  // host in the seed's ladder. A note without one predates the seed (or
  // came from somewhere else) and restore cannot find it again.
  index?: number
  // Nostr provenance: the pubkey this note was gift-wrapped to, or came
  // from. A note with either is never wrapped again.
  sentTo?: string
  receivedFrom?: string
  // Taken offline on the mint's signature alone: nobody asked the mint,
  // so the person who handed it over still knows this secret. reconcile()
  // rotates every one of these the first time there is a connection.
  unrotated?: boolean
  // Handed over offline. No mint saw it happen, so nothing confirms the
  // recipient took it until a check sweep or a reclaim asks.
  sentOffline?: boolean
  // What a zap said, when this note was minted by one: who sent it and
  // what they wrote, off the payer's own signed request.
  zap?: {senderPubkey: string; content: string; amountMsat: number}
  // Why this record is in the state it is, when the state alone does not
  // say. Set by the check sweep when a mint disowns a note: 'spent' is the
  // safe filing, but "the mint has never heard of it" is a different story
  // and the holder deserves to read it.
  detail?: string
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
  // The most the mint can credit: the advertised fee formula, msat-exact.
  expectedNetMsat: number
  // The least it can credit and still be following its own advertisement:
  // the same fee ceilinged to a whole sat, which dni's lnurl-mint does on
  // purpose. LUD-25 does not say which reading is right, so anything
  // between the two is the mint keeping its word. Absent on records
  // written before this existed - treat that as equal to expectedNetMsat.
  minNetMsat?: number
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
  // The offline cash drawer: the denominations, in SATS, this wallet tries
  // to keep at this mint, and how many of each. A wallet holding one large
  // note cannot pay a small amount offline, because a split needs the
  // mint; a ladder is how it keeps change in its pocket.
  ladder?: number[]
  ladderCopies?: number
  // When this mint was seen to rotate its signing key, and whether that
  // has been reported once. A rotation is noticed during a receive, and
  // the holder deserves to hear about it from the next reconcile.
  keyRotatedAt?: number
  keyRotationReported?: boolean
  addedAt: number
}

export type WalletData = {
  // 1: secrets were random and lived nowhere but this file.
  // 2: secrets are derived from `seedHex`, so twelve words plus the mints
  //    are enough to find the money again.
  version: 1 | 2
  // The BIP39 seed, hex, 64 bytes: what the derivation actually uses.
  seedHex?: string
  // The twelve words that made it. Kept because a holder who has lost
  // their paper needs to be able to write it out again, and because the
  // seed cannot be turned back into words. Exactly as secret as the seed,
  // in the same sealed store, and the one thing worth writing down.
  mnemonic?: string
  // Next unused derivation index per mint host. Bumped and persisted in
  // the same write that stages a record, always BEFORE its hash goes on
  // the wire: a crash there wastes an index, and the other order loses a
  // note.
  counters?: Record<string, number>
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
    // A lightning address claimed at a mint, as name@host. Payments to it
    // arrive as notes sealed to this wallet's Nostr key.
    lightningAddress?: string
    // A paired heartwood signer holding notes of its own (heartwood.ts).
    // The client key is what the device bound; the store guards it.
    heartwood?: {uri: string; devicePubkey: string; relays: string[]; clientSecretHex: string}
  }
  mints: MintEntry[]
  // Trust-on-first-use pins: mint host -> the mintPubkey currently in use
  // there. A later mismatch is surfaced hard unless the mint itself
  // publishes the old key as retired, in which case the old one moves to
  // the history below and older notes keep verifying against it.
  pubkeyPins: Record<string, string>
  pubkeyHistory?: Record<string, string[]>
  notes: NoteRecord[]
  pendingMints: PendingMint[]
  melts: MeltRecord[]
}

export const emptyWallet = (): WalletData => ({
  version: 2,
  counters: {},
  settings: {},
  mints: [],
  pubkeyPins: {},
  pubkeyHistory: {},
  notes: [],
  pendingMints: [],
  melts: []
})
