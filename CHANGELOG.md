# Changelog

## [0.3.1] - 2026-08-22

- **A stale derivation counter is no longer reported as a spent note.**
  Every melt from a restored wallet failed with "notes already spent", and
  the balance dropped to zero until `reconcile` was run - then failed
  identically again. The notes were never spent: a mint refuses a repeated
  OUTPUT hash with the same words it refuses a dead INPUT, so a wallet
  whose counter is behind what the mint has already seen was told its own
  money was gone. The wallet now asks about its own inputs, and where every
  one is still live it knows the mutation did not land: it unwinds on the
  spot and draws the next indexes off the ladder. A mint that refuses four
  different derived secrets is told to be saying something else, and the
  holder hears that instead. A restore and a second device on one seed both
  leave the counter behind, so both hit this.

## [0.3.0] - 2026-08-22

- **One wallet on several devices: the notes themselves can live on your
  relays.** `notecase sync on`, off until you ask for it, and separate from
  the mint-list backup - agreeing to publish where you bank is not agreeing
  to publish what you hold. Every note record travels as its own
  addressable event (kind 30078, `d` = `lnurlcash-note:<id>`), NIP-44 to
  the same seed-derived key the mint list uses, which is deliberately not
  your npub. Derivation counters travel too, one record per device, merged
  by taking the highest anyone has claimed - which is what stops two
  wallets on one seed handing out the same index, the one thing the
  recovery words could not do on their own.

  `notecase sync` pulls, lets the mints settle anything new, then publishes
  what changed. Two rules the merge will not break: a note this wallet has
  spent is never returned to spendable by a relay copy, however new that
  copy is, and a note any device reports as spent is spent everywhere. The
  relay is not the arbiter of what is spendable; the mint is, and the check
  sweep runs over anything a sync brings in that this wallet had not seen.

  A note in a terminal state travels without its secret - the record is how
  the other device learns the note is gone, and a burned k1 has no reason
  to sit on a relay. THREAT-MODEL.md has a section on what this costs: your
  seed was always the whole wallet, and this makes it sufficient as well as
  necessary, because the money becomes fetchable from a public relay by
  anyone holding your words.

  The PWA gets an "Across devices" card in Settings carrying both switches,
  which also puts the mint-list backup within reach of a phone for the
  first time - a wallet restored from words on a new device could not
  recover its own mint list without it.
- The README no longer tells you to build from source and clone four
  sibling repos. It has been on npm since 0.2.0.

## [0.2.0] - 2026-08-22

Needs `lnurlcash-kit` 0.2.0.

While LUD-25 is a draft, a `0.x` minor bump may be breaking. This one is:
`receive` now refuses a note whose signature does not verify, where it
used to warn and take it, and the wallet file moves to version 2. A
version 1 file opens and a version 1 backup imports; both are upgraded in
place, and the notes already in them stay findable only through the file
until they are adopted onto the seed.

- **`frame-ancestors` moved to where it counts.** The web build's meta CSP
  listed `frame-ancestors 'none'`, and a meta element ignores that
  directive by specification: the wallet was advertising clickjacking
  protection it did not have. The directive only takes effect as a
  response header, so the README now documents the block an operator has
  to serve - the whole policy as a header plus `X-Frame-Options: DENY` -
  and a test holds that block and the meta tag to the same string, because
  a policy that disagrees with itself protects whichever half the browser
  happened to read. wallet.moneyer.dev serves it.
- The mint suite now runs against a mint that actually charges, and
  asserts a holder is credited the floor of the fee band rather than the
  optimistic end. It was written after the arithmetic had been fixed by
  hand against the live mint and nothing automated proved it; the mint
  those tests build disagreed with the mint on the wire, which turned out
  to be a bug in moneyer's library entry point (fixed in moneyer 0.3.1,
  now the version this wallet tests against).
- The test suite has a 30 second timeout rather than vitest's 5 second
  default. The PIN's KDF is deliberately expensive and several tests start
  a mint on top of it, so the slower cases crossed the default on a loaded
  machine while passing perfectly well.
- **A mint's fee is quoted as a floor, not a hope.** LUD-25 does not say
  whether a mint rounds its fee, so a wallet can only bound what it will be
  credited: the msat-exact figure at one end, the sat-ceilinged one at the
  other. The wallet recorded both and then showed the optimistic one - and
  both moneyer and dni's reference mint now ceiling, which is the LOW end,
  so a holder was told they would get more than they would and then handed
  less. Now stated as "at least X (up to Y, depending on how it rounds)",
  and flatly as one figure where the fee has no fraction of a sat in it and
  there is nothing to hedge about.
- **Payment requests: ask for sats, and pay one over Nostr.**
  `notecase request <sats> [--memo]` publishes an `lnurlcashreq1` string
  naming the amount, this wallet's mints and its npub; `notecase pay
  <string>` decodes it, cuts a note to the exact amount at a mint both
  sides use, and gift-wraps it. Neither party touches a Lightning address
  and the mint only ever sees a split. The payee matches the arriving note
  back to what they asked for, so `inbox` says which request was settled
  and `notecase requests` shows what is still outstanding. Sends can carry
  a memo with or without a request.
  Two things are refused rather than guessed: a request for a fraction of a
  sat, because the wire carries whole sats and rounding would ask for one
  figure while showing another, and a request naming only mints this wallet
  has no account at, which is a different problem from having no money
  there and has a different fix - both are said in those words.
  A request id arriving on a note is somebody else's claim, so it is
  matched against this wallet's own records and nothing else: an id naming
  no request of ours settles nothing, one already paid is not re-settled,
  and anything that is not 16 hex characters is not carried at all. A memo
  is prose from a stranger and is bounded on the way in and rendered as
  text. The note is kept either way - it is money, and whether it also
  answers a question this wallet asked is a separate matter.
  The extra rumor tags were checked against the hardware signer's parser
  first: it reads `content` and looks tags up by name, so a tag it does not
  know is one it never sees, and nothing needed gating on whether the
  recipient is a paired device.
- **Twelve words are enough now: the mint list backs up to Nostr.**
  `restoreNotes` re-derives a wallet's note secrets, which is the hard half
  of recovery - and the easy half beat it on its own, because a fresh
  wallet does not know WHICH mints to ask. Words alone recovered nothing
  and the holder still needed a file, which is the situation the words
  existed to remove. `notecase backup nostr on|off|push|pull` publishes the
  mint list, the pinned signing keys and the default mint as an encrypted
  kind 30078 event under a key derived as
  `sha256(seed || "lnurlcash-mint-backup")` - deliberately not the wallet's
  Nostr identity, so nobody who knows the holder's npub can tell they run
  an LNURLcash wallet or watch their mint list change. Notes, secrets,
  balances and counters never travel. Off unless asked for, because the
  list still says where somebody banks. It republishes whenever the list
  actually changes, compared by fingerprint rather than a dirty flag a
  crash could lose, and a push no relay accepted is not recorded as one.
  Switching it on in a fresh wallet LOOKS for a list rather than
  overwriting one, and a wallet that has never published refuses to publish
  an empty list at all - otherwise turning the backup on after a restore
  destroys the backup at the exact moment it is needed.
- **A mint can say who runs it, and holders can read it.** The discovery
  endpoint's optional fields are now kept on the mint record: `name`,
  `description`, `contact` (nostr, email, url), `tosUrl`, `motd` and
  `version`, plus the structured `fees`, which is taken in preference to
  parsing the payRequest prose. `notecase mints info [host]` prints the
  lot, `mints list` shows the name and the notice, and the web mint card
  carries the same. A message of the day is shown once and again only when
  the words actually change - a notice that reappears every visit is one
  people learn to dismiss unread. It is re-read on the regular reconcile
  rather than only when somebody goes looking, because a notice nobody
  fetches is not a notice. Every one of these is the operator's own words
  arriving over the wire: all of it is rendered as text, never as markup, a
  terms link is opened deliberately and only over https, and both surfaces
  say plainly that this is what the mint claims rather than something
  notecase has checked. A mint that publishes nothing, or whose discovery
  endpoint cannot be reached at all, is exactly as usable as before -
  adding a mint must not turn on whether an experimental extra answered.
- **A mint known only from notes can now rotate its signing key.** The
  escape hatch for an announced rotation reads the mint's published key
  history, and finding that document needed the mint's pay URL out of the
  wallet's mint list. A wallet that has only ever received notes has no
  such entry - which is the ordinary case for a bearer-note wallet - so the
  history came back empty, and empty means refuse. The same receive that
  created the pin could never create what was needed to move it, and a mint
  doing exactly the right thing was reported as an attack. The note's own
  `payLink`, which `lnurlcash-kit` 0.2.1 models and moneyer 0.2.1 publishes,
  is now used as the route to that document. Nothing is loosened: a
  rotation the mint has not announced is still refused, a mint that cannot
  be reached is still refused, and a mint that publishes no `payLink` at
  all leaves a note-only wallet exactly where it was. A `payLink` on any
  origin but the note's own is ignored, and so is a mint-list entry whose
  pay URL points at another host - a tampered wallet file must not be able
  to nominate who vouches for a mint's keys.
- **The share target is a POST, so a note's secret never reaches a URL.**
  A shared payload can be a live bearer note, and the secret in it is the
  money. The target was declared `method: 'GET'`, so a share arrived as
  `/share?text=lnurlw://...?k1=<the secret>`. In normal use the service
  worker answers that navigation from the precache and it never reaches the
  network, but a worker that is updating, evicted, unregistered or bypassed
  by a hard reload lets it out - and then the secret is written to the web
  server's access log as an ordinary query string. That log belongs to
  whoever serves the wallet, who need not be the mint that issued the note,
  so a wallet holding notes from several mints was handing one operator
  another's secrets. The share now travels in a POST body: the worker takes
  it, stashes the raw fields, and redirects to a clean root, so there is
  nothing to log, nothing to land in history and nothing to leak through a
  referrer. The worker stays ignorant of what a note looks like - it stashes
  the three share fields and the page decides, using the same code that
  reads the GET path. The GET path is kept as a fallback, because a worker
  may not be controlling the page on the very first install and losing
  somebody's note to a purist refusal would be the worse bug.
- **An invoice that states no amount can be paid.** `notecase melt <bolt11>
  <sats>` says how much to send for an invoice that leaves the figure to
  the payer; it used to be refused outright. There is nowhere on the LUD-25
  wire to put the figure - a melt sends the note's own value - so the
  wallet cuts a note of exactly that amount and melts that, which is what
  the mint then pays out. Giving an amount for an invoice that already
  names one is refused rather than silently ignored, because the two could
  disagree and picking one is not the wallet's call. So is a sub-sat
  amount: the mint sends the whole-sat floor of the note it burns, so
  25_500 msat would send 25_000 and say nothing.
- **Twelve words, and the money can be found again.** `notecase init`
  shows a BIP39 mnemonic once; `notecase seed` shows it again after the
  PIN. Every note secret this wallet makes now comes off it:

      root  = HMAC-SHA256(key = "lnurlcash-note-v1", msg = seed)
      k1[i] = HMAC-SHA256(key = root, msg = "<mint host>:<i>")

  where the host is the exact lowercase `host[:port]` and `i` counts up
  from zero, one counter per mint. So `notecase init --restore`, add the
  mints you used, `notecase restore`, and the wallet asks each mint which
  of those secrets are still worth something and takes back what is.
  It walks upward until twenty consecutive indices are unknown, records
  what it finds as recovered, and parks anything the mint is holding for
  `reconcile` to finish.
- The next unused index per mint is written to disk **in the same save
  that stages a fresh secret, before its hash goes anywhere**. A crash
  between the two wastes an index and costs nothing; the other order would
  hand a mint a secret the wallet could never find its way back to. A
  split consumes two indices, and an unwound mutation does not give its
  indices back.
- `notecase adopt` moves notes the words cannot find - a note somebody
  handed you, or anything made before the seed - onto the seed with one
  rotate each, which the mint charges nothing for. The balance says how
  many are in that state.
- The web wallet shows the words once behind an "I have written them down"
  gate, shows them again from Settings after the PIN, and gains a "Restore
  from your words" door on the welcome screen with "ask my mints what is
  still mine" in Settings.
- The passphrase-sealed export is unchanged and still worth having: it
  carries mints, pins, history and pending outcomes, none of which the
  words can rebuild.

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
