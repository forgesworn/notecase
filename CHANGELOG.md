# Changelog

## [0.2.0] - unreleased

While LUD-25 is a draft, a `0.x` minor bump may be breaking. This one is:
`receive` now refuses a note whose signature does not verify, where it
used to warn and take it.

- A backup holding a note taken offline can be restored again. The
  portable backup's validator required every note to carry its mint's
  callback URL, and a note taken offline has none until reconcile has
  asked the mint for one, so exporting and re-importing such a wallet
  refused the file.
- **A lightning address, claimed from the wallet.** `notecase address
  claim <name>` takes `name@mint.example` at a mint that hands them out.
  The mint charges in its own notes, so the wallet cuts one out of the
  balance and the mint burns it; a free name cuts nothing. The only
  identity involved is the wallet's Nostr key: the request is signed with
  it (NIP-98), so the name belongs to the key and no account exists
  anywhere. If the mint refuses, the note that was to pay for it comes
  straight home under a fresh secret. In the web wallet it is a settings
  card that shows the price before you commit, and the home screen then
  carries the address with a copy button.
- A note that arrived as a zap now carries the payer's own signed request,
  so the wallet shows who sent it and what they wrote rather than "a note
  arrived". The signature on that request is checked, so a mint cannot
  invent a sender.
- **A mint that rotates its signing key is no longer mistaken for an
  attack.** Rotating a signing key invalidates every outstanding signature
  at once, and the wallet used to throw `PinMismatchError` at the mint it
  had banked with for months. Now, where the mint's own discovery endpoint
  already lists the pinned key in `previousPubkeys`, the old key moves to a
  kept history, the new one is pinned, and the change is reported: as a
  warning on the receive that noticed it and as a `mint-key-rotated` event
  on the next reconcile, once. Anything else is still a hard refusal.
  Verification - on receive, offline, and in the check sweep - accepts the
  pinned key or any retired one, so notes signed before the rotation keep
  proving where they came from. The check sweep lists them as signed with
  an old key, and `notecase check --resign` rotates them under the current
  one, which costs nothing. The trust argument is trust-on-first-use's own:
  whoever controls the host controls the pin either way, and the history
  only stops a mint doing the right thing from looking like an attack.
- **A "What the mint knows" section in the README.** A mint is not blind,
  and a wallet that lets you think otherwise has told you a lie about your
  own money. It sets out what every LUD-25 mint sees - every note it
  issued, every rotate, split and merge and the links between them, the IP
  that asked, the invoice a melt paid - and what it does not: who holds a
  note between operations, and anything at all about a note handed over
  offline until somebody rotates it. The wallet-side mitigations are listed
  as the weak things they are, and the reason the design is like this
  anyway is stated rather than hidden.
- `NOTECASE_PROXY=socks5://127.0.0.1:9050` sends every call through a
  SOCKS5 proxy, which is how the CLI is pointed at Tor. The mint's hostname
  is handed to the proxy as a name and never resolved on this machine,
  which is the whole point: a wallet that looks a mint up in DNS has told
  its resolver which mint it banks with before a byte of the request goes
  anywhere. Setting a proxy therefore turns the DNS pinning off
  deliberately, and the README says plainly that this is a swap rather than
  an upgrade.
- **A refused mutation can no longer delete the only copy of a note the
  mint minted.** A rotate, split or merge is a GET, and HTTP stacks retry a
  GET whose connection was dropped. The retry is byte-identical, and by the
  time it arrives the input is burned, so a mint that does not recognise a
  repeat answers "already spent" about a mutation that landed. The wallet
  used to read that as proof the mutation never happened and discard the
  staged output records, which were the only copy of the secrets the mint
  had just minted notes against. Now an already-spent or unknown-input
  refusal, on inputs that were live when the request went out, is parked as
  ambiguous like any other unknown outcome, and `reconcile` settles it by
  asking the mint what the staged secrets are worth: live means it landed,
  and the input still being there means it did not. Refusals that cannot be
  a landed mutation - a malformed hash, a dust or fee refusal, a sunsetting
  mint - stay definitive and still discard the staged records at once, with
  no round trip. A melt's own recovery probe is untouched: its input is
  never live, and "spent" there still means the melt settled. A note taken
  offline whose giver spent their copy first now settles over two reconcile
  passes rather than one, for the same reason: the first parks it, the
  second probes and confirms. It stops counting toward the balance
  immediately either way.
- `notecase check [--apply] [--mint <host>]` asks every mint whether the
  notes this wallet holds from it are still good, and says what it found:
  already spent, unknown to the mint, locked by something in flight, or
  worth a different amount than the wallet thought. A dry run unless
  `--apply` is given. A bearer note has copies by design, so a wallet that
  never asks can go on counting money somebody else already spent. Four
  notes are asked about at a time per mint; a mint that does not answer
  has its notes left exactly as they are and is named in the report,
  never marked. The sweep costs no privacy: the mint made these notes for
  this wallet and sees each one spent.
- `Wallet.checkNotes({apply?, mintHost?})` is the engine behind it, and
  returns the report rather than printing one.
- **A signature that fails is now a refusal.** A note carrying a `sig`
  that does not verify against the key pinned for its mint is rejected
  before any record is written (`BadSignatureError`): the amount may have
  been altered, or the note may not come from that mint at all. Overridable
  per receive - `notecase receive --force`, or a red card with a two-tap
  "take it anyway" in the web wallet - and the override is recorded as a
  warning. A note with **no** signature stays a warning, because mints with
  no funding source legitimately issue unsigned notes. Reclaiming a note
  this wallet sent is never refused on a signature: it is our own money
  coming home.
- **An offline cash drawer.** A note is a secret, so handing one over
  needs no network - but a wallet holding one big note cannot pay a small
  amount, because cutting a note down needs the mint. Each mint now has a
  ladder of denominations (100, 500, 1000 and 5000 sats, two of each by
  default) that `notecase prepare` keeps cut and ready. It quotes the
  split fees before cutting anything, `--apply` cuts them, and it is
  re-runnable: a full drawer costs nothing to check. `notecase ladder`
  shows and sets the shape of the drawer per mint.
- `notecase send <sats> --offline` hands over notes the wallet already
  holds that add up to the amount exactly, as one or more URLs, with **no
  call to any mint at all**. Where no combination is exact it names the
  nearest above and the overpay rather than guessing; `--overpay` accepts
  it. The records go to `sent` and are persisted before the URLs are
  handed back, so a crash cannot give a note away twice.
- `notecase receive --offline` takes a note on the mint's signature alone.
  It needs a pinned key for that mint and refuses without one: there would
  be nothing to check against, and that is the leap of faith LUD-25 is
  careful not to ask for. A note taken this way is stored **unrotated**,
  because whoever handed it over still knows its secret; the balance says
  how much is in that state, and `reconcile` now rotates every one of them
  at the first opportunity, or files it as spent if the giver got there
  first.
- Offline mode is asked for and never inferred from connectivity: a switch
  in the web wallet's header, `--offline` on the CLI. The kit's `offline`
  option is a promise, and a promise cannot be made from a guess.
- A note URL now carries the mint's `sig` alongside the secret and amount.
  It is the mint's own public statement about that note, and carrying it is
  what lets a recipient check the note without asking anybody.
- The web wallet gains a cash drawer under each mint, an offline hand-over
  that pages through several notes one secret at a time, and an offline
  receive whose refusal offers no override - offline the signature is the
  only thing there is to check.
- **Tap and share in the web wallet.** A note written to an NFC tag is a
  physical coin: the send and hand-over screens can write one, and the
  receive screen can read one, both feeding the same classifier the camera
  does. The convention is a single NDEF URI record holding the note URL
  with its signature, documented in the README so other wallets read the
  same tags. Web NFC is Chrome on Android, so the controls do not render
  anywhere else.
- The PWA is now a share target: "Share → notecase" from any app hands
  over a note URL, a bolt11 invoice or a mint address, including one
  buried in a sentence. The payload is stashed and scrubbed out of the
  address bar exactly the way a claim fragment is, because a shared note
  URL is a live secret too, and nothing is ever accepted automatically -
  it lands on the screen that asks.
- The web wallet gains Settings → Check your notes: the same sweep, a plain
  reading of what each mint said, and an Apply button that asks the mints
  again before writing anything down.

## [0.1.1] - 2026-08-21

- `notecase transfer <sats> --from <host> --to <host>` moves value between
  two mints: the destination issues an invoice, the source melts a note to
  pay it, and the destination's payment preimage is the note that lands. It
  is `startMint`, `melt` and `awaitMint` in a row, so every safety rule
  those follow applies unchanged, including rotate-on-claim. Refuses a
  transfer to the mint the note came from, and refuses a destination with no
  LUD-21 verify *before* the source melts - nothing could learn the preimage
  there, and the preimage is the money.
- Warnings now use the mint fee **band** rather than one reading of it.
  LUD-25 says nothing about whether the fee rounds; dni's lnurl-mint
  ceilings it to a whole sat and moneyer is msat-exact, so a single
  predicted number is wrong about one of the two live implementations. A
  40,000 msat transfer to a reference mint credits 38,000, and the wallet
  used to call that a discrepancy when the mint had done exactly what it
  documents. `minNetMsat` is the new pessimistic edge; a warning fires only
  outside the band.
- A refused transfer no longer leaves a pending mint nothing can resolve.
  The destination's invoice can never be paid once the source melt refuses,
  so it is dropped rather than left `awaiting`, where it made the wallet
  report unresolved outcomes forever while `reconcile` had no answer.
- Holds the wallet end of heartwood's gift-wrap interop fixture, so a drift
  in this side's wrap format fails here rather than on a bench.

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
