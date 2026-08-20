# Changelog

## [0.1.0] - 2026-08-20

Initial implementation.

- The wallet engine: receive-and-rotate, exact-amount preparation
  (split/merge in one request), send with reclaim, melt to invoice,
  Lightning Address or NWC, mint with NWC-paid or manually paid invoices.
- Engine surface for frontends: `sentNotes`/`reclaim`/`markTaken`,
  `rotateLive` (panic rotate), `setDefaultMint`, guarded `removeMint`,
  and passphrase-sealed portable backups (`exportBackup`/`importBackup`,
  PBKDF2 600k - never the device PIN).
- The web wallet grew into a full product: welcome + restore onboarding,
  camera QR scanning with a universal classify-on-scan button, per-note
  detail with verified-signature badge and panic rotate, handed-over
  notes reclaimable until taken, history, mint management with per-mint
  balances and suggested mints, fee-grossed mint amounts, presets and
  Max, tap-to-reveal bearer QRs, system share, a `#/claim` fragment
  route, and an installable PWA that asks before updating and never
  caches a protocol call.
- Crash-safe staging: secrets persisted before disclosure, ambiguity as a
  first-class state, reconcile() resolving every parked outcome by
  probing - including the rotate probe that distinguishes a restored melt
  from a pending one.
- PIN-locked store via keystore-kit over an encrypted file; Shamir word
  shares of the store key via shamir-words.
- NWC integration via nwc-kit with preimage-verified payments.
- DNS-pinned outbound fetch via farrier-kit, loopback passthrough for
  local mints.
- Tested against the conformance mock mint's misbehaviour matrix, a fake
  NIP-47 wallet service running the real ceremony, and moneyer end to end.
- The web wallet set in the mint's design language - the silver banknote
  series: notes print as engraved banknotes (intaglio plates, the
  denomination letterpressed in words, a serial from the note id) with
  the bearer QR under scratch-off silver foil; a certificate frame around
  every screen, inscriptional capitals, hairline ledgers, engine-turned
  guilloché, dark and light paper; and a `#/proof` proofing press that
  prints the note with a constant secret so the plate can be checked
  without money.
- Guidance throughout the web wallet: every flow opens with a plain-words
  explainer of what it does, the four home offices carry colour-coded
  roundels and captions, an empty wallet shows a start-here ladder whose
  rungs are the buttons that do them, icon buttons explain themselves in
  tooltips on hover or keyboard focus, and the whole surface got a size-up
  pass for readability.

A claim link no longer loses the note if the hand-off is interrupted. The
secret is scrubbed from the address bar the instant it is read, so it used
to live only in a variable - and a locked wallet, a first-run setup, or the
service worker's own "new version - Reload" prompt would strand it. The
claim now survives in sessionStorage until the receive actually lands, the
update prompt holds its tongue while a claim is in flight, and backing out
of Receive no longer destroys it.

Security-review hardening:

- A mint claim now persists its preimage with the claim BEFORE the receive
  runs, and reconcile() re-drives any claim whose receive never landed -
  a crash or a flaky fetch between the two can no longer strand a paid
  note, over NWC or anywhere else.
- `importBackup` validates the full WalletData shape after decrypting
  (ids, k1s and pins as hex, amounts as positive safe integers, http(s)
  URLs, enum states and origins), rejecting tampered or hostile backups
  with a generic error that never echoes field contents.
- `receive` and `nwc set` prompt for their secret when the argument is
  omitted - the argv form still works, but live secrets no longer need to
  land in shell history.
- Store writes fsync the containing directory after the rename, so the
  rename itself survives a power loss (best-effort where a filesystem
  allows it).
- `--wait` validates its input: a non-number or non-positive value is a
  usage error rather than an infinite poll, and `awaitMint` guards the
  same way for library callers.
- The send reclaim hint no longer echoes a truncated k1 prefix.
- `backup export` to stdout writes its plaintext-secrets caution to
  stderr, keeping piped stdout clean JSON.
- The SSRF guard no longer assumes `process.env` exists, so it bundles
  for the browser without a ReferenceError.
- THREAT-MODEL.md now states plainly that DNS pinning is CLI-only: a
  browser's fetch has no socket control, so the web build mitigates with
  scheme admission, no-store requests and user-confirmed actions.
