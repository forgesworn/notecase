# notecase

> A case for Lightning bearer notes. notecase is an LNURLcash (LUD-25)
> wallet: it receives, holds, splits, merges, sends and melts notes whose
> secret IS the money - and it is built so that no crash, timeout or lying
> mint can part you from one.

An independent implementation - not a fork of the reference wallet - that
dogfoods the ForgeSworn stack end to end:

| library | what notecase uses it for |
| --- | --- |
| [`@lnurlcash/kit`](https://github.com/lnurlcash/lnurl-wallet/tree/main/src/lib) | the reference-wallet protocol package: resolve, info, rotate, split, merge, melt, mint and verify |
| [`farrier-kit`](https://github.com/forgesworn/farrier-kit) | BOLT-11 decoding before anything is paid, Lightning Address resolution for melt-to-address, preimage verification after settlement, DNS-pinned fetch |
| [`@forgesworn/nwc-kit`](https://github.com/forgesworn/nwc-kit) | the optional Lightning arm: pay mint invoices and issue melt invoices through a wallet you already trust |
| [`keystore-kit`](https://github.com/forgesworn/keystore-kit) | PIN protection for the store key |
| [`@forgesworn/shamir-words`](https://github.com/forgesworn/shamir-words) | word-encoded backup shares of the store key |

The companion mint is [`@forgesworn/moneyer`](https://github.com/forgesworn/moneyer);
the two are integration-tested against each other, and notecase is tested
against the adversarial mock mint from
[lnurlcash-conformance](https://github.com/TheCryptoDonkey/lnurlcash-conformance).

Other wallets, mints and libraries speaking the same protocol are indexed
in [awesome-lnurlcash](https://github.com/TheCryptoDonkey/awesome-lnurlcash).

## The safety design

A bearer note is lost the moment its secret exists nowhere durable. So:

- **Persist before disclose.** Every replacement secret is written to disk
  BEFORE its hash goes on the wire (the kit's `*WithHash` variants exist
  for exactly this). A crash mid-mutation can never orphan money.
- **Ambiguity is a state, not a guess.** A timeout or dropped connection
  parks the mutation as `ambiguous`; `notecase reconcile` learns the truth
  by probing the mint and either promotes the staged secrets or unwinds
  them. Never both, never neither. A mutation is a GET, and HTTP stacks
  retry a GET whose connection dropped, so a mint answering "already
  spent" about a note that was live moments ago is parked too: that is
  exactly what a mint says to a byte-identical repeat of a request that
  already went through, and discarding the staged secret there would
  destroy the only copy of a note the mint really did mint.
- **Melt OK means in flight.** The note locks as `melting`; reconcile
  confirms settlement through LUD-21 verify, or recovers a restored note
  under a fresh secret via a rotate probe - the one operation that is safe
  whichever way the melt went.
- **Rotate immediately, always.** On receive and on claim, because the
  sender - or anyone who saw the mint invoice - still knows the old secret.
- **Never print a k1** unless you asked to send. Balances, lists and logs
  show note ids (hashes) only.
- **A pin only moves when you move it.** A mint's signing key is pinned on
  first contact and a change is refused. Where the mint itself publishes
  the old key as retired on its discovery endpoint, the refusal becomes a
  question instead: `receive --accept-key-rotation` takes it, moves the old
  key to a kept history and pins the new one. Nothing is written until you
  say so - LUD-25 requires that a newly advertised key never silently
  replaces a pinned one. A published retirement is not much of a proof and
  is not meant to be: whoever controls the host controls what it publishes,
  so a mint someone else now runs can list the key it displaced and look
  exactly like a mint rotating properly. What it buys is that the honest
  case stops looking identical to an attack, which is what teaches people
  to click through warnings. Notes signed by a retired key keep verifying,
  and `notecase check --resign` rotates them under the current key for
  nothing.
- **A signature that fails is a refusal.** A note carrying a `sig` that
  does not verify against the key pinned for its mint is rejected before
  any record is written: the amount may have been altered, or the note may
  not come from that mint at all. `receive --force` takes it anyway, and
  says so afterwards. A note with no signature at all stays a warning -
  mints with no funding source legitimately issue unsigned notes.
- **A transfer is two mints, never one.** `transfer` mints at the
  destination and melts at the source to pay for it, so it inherits every
  rule above: the melt is in flight until proven otherwise, the arriving
  note is rotated on claim, and a destination with no LUD-21 verify is
  refused before anything is burned - nothing could ever learn the preimage
  there, and the preimage is the money.

## Backup and restore

`notecase init` shows twelve words once and never again unasked; `notecase
seed` shows them after the PIN. Every note secret this wallet makes comes
off them:

```
(d1, d2, d3, d4) = HMAC-SHA256(key = m/139'/0, msg = "<mint host>")[0..16]
k1[i]            = m/139'/d1/d2/d3/d4/i'
```

which is the scheme LUD-25 specifies, so the same twelve words restore the
same notes in any wallet that implements it. `d1..d4` are used exactly as
they fall out of the hash: BIP-32 reads any index at or above 2^31 as
hardened, so which of those four levels are hardened is decided by the
mint's own host name.

A wallet that has lost everything but the words and the names of its mints
can ask each mint which of those secrets are still worth something. That is
what `notecase restore` does: `notecase init --restore`, add the mints you
used, then `notecase restore`, and the notes come back. It walks the
pre-spec scheme this wallet used before LUD-25 had one as well, so notes
minted then come back too.

The index a note came from is kept on the record, and the next unused
index per mint is written to disk **in the same save that stages a fresh
secret, before its hash goes anywhere**. A crash between the two wastes an
index, which costs nothing. The other order would hand a mint a secret the
wallet could never find its way back to.

That counter is not an optimisation, it is half the backup. A mint must
answer a private lookup for a burned note exactly as it answers one for a
note it never issued, so a walk cannot see a spent index; and since every
rotate burns the index below it, a wallet that has rotated more than twenty
times would scan as empty without its counter. It is not secret - an index
reveals nothing without the seed - so it belongs in an ordinary backup, and
it only ever moves upwards.

One thing the words cannot do on their own: they will not find a note
somebody handed you that you have not rotated yet, because that secret
came off their seed - the wallet lists those and `notecase adopt` moves
them onto yours with one free rotate each.

The passphrase-sealed export (`notecase backup export`) is still there and
still worth having: it carries mints, pins, history and pending outcomes,
none of which the words can rebuild.

### One wallet on several devices

The words find your notes again; they do not let two devices hold the same
notes at once. `notecase sync on` does, and it is off until you say so.

Every note record - k1 included - goes to your relays as one addressable
event per note, encrypted NIP-44 under a key derived from your seed that
is deliberately not your npub. Your derivation counters go too, one record
per device, merged by taking the highest anyone has claimed, so two
wallets on one seed stop handing out the same index. `notecase sync` pulls,
lets the mints settle anything new, then publishes what changed.

Read [THREAT-MODEL.md](THREAT-MODEL.md) before you turn it on. The short
version: your seed was always the whole wallet, and this makes the seed
sufficient as well as necessary - the money becomes fetchable from a
public relay by anyone who has your words. What a relay sees is
ciphertext, how many records there are, and when they change.

Two rules the merge will not break. A note this wallet has spent is never
returned to spendable by a relay copy, however new that copy is. A note
any device reports as spent is spent everywhere. The relay is not the
arbiter of what is spendable - the mint is, and the check sweep runs over
anything a sync brings in that this wallet had not seen before.

## What the mint knows

A mint is not blind, and a wallet that lets you think otherwise has told
you a lie about your own money. Everything below is true of every LUD-25
mint, including ours.

The mint knows every note it ever issued. It knows every rotate, split and
merge, and it knows the links between them: which note became which, and
when. It knows the IP address that asked for each of those, and it knows
the invoice a melt paid.

The mint does not know who holds a note between one operation and the
next, and a note handed over offline leaves no trace at the mint at all
until somebody rotates it.

**What this wallet does about it, and how little that is.** notecase
speaks to a mint on exactly six occasions: minting a note, rotating one,
splitting one, merging some, melting one, and a check sweep. It says
nothing to anybody during an offline hand-over. Beyond that, the
mitigations are weak and should be described as weak:

- `NOTECASE_PROXY=socks5://127.0.0.1:9050` sends every call through a
  SOCKS5 proxy, which is how you point this at Tor. The mint then sees the
  exit, not you. It still sees every link between your notes. Setting a
  proxy turns off the DNS pinning the wallet otherwise does, deliberately:
  pinning resolves the mint's hostname on your machine, and telling your
  resolver which mint you bank with defeats the point. That is a swap, not
  an upgrade - you give up the rebinding guard to get the network privacy.
- Not rotating at predictable times helps a little, and is on you.

**Why the design is like this anyway.** A bearer note needs no new
cryptography, any LUD-03 wallet in existence can cash one out without
knowing what LNURLcash is, and checking one offline needs nothing but a
signature. Blinding buys privacy from the mint and costs all three. That
is the trade, stated plainly, so you can decide whether you like it.

## Use

```bash
npm install -g @forgesworn/notecase
```

Or from source:

```bash
git clone https://github.com/forgesworn/notecase
cd notecase && npm install && npm run build
alias notecase="node $PWD/dist/cli.js"
```

```bash
notecase init                          # PIN-locked store, and twelve words shown once
notecase seed                          # shows them again, after the PIN
notecase init --restore                # a new device, from the words
notecase restore                       # asks each mint which of your notes are still alive
notecase mints add mint@mint.example   # or any LNURL / bare domain
notecase mint 21                       # pay via NWC if set, else an invoice to pay
notecase balance
notecase send 8                        # prints a bearer note URL + LNURL
notecase send 8 --to npub1...          # seals it to their key, leaves it on their inbox relays
notecase address claim donkey          # a lightning address at your mint, paid for with a note
notecase address                       # what it is
notecase inbox                         # opens what was sent to your npub, claims it at once
notecase reclaim                       # takes back anything sent but not yet claimed
notecase receive                       # prompts for the note, rotates it in
notecase check                         # asks every mint whether your notes are still good
notecase check --apply                 # and writes down what it found
notecase check --resign                # re-signs notes under a mint's new key
notecase ladder                        # the cash drawer at your mint, and what it still wants
notecase ladder set 100,500,1000 --copies 2
notecase prepare --apply               # cuts the small notes an offline payment needs
notecase send 500 --offline            # hands over notes you already hold, nothing on the wire
notecase send 500 --notes c3e3,b8b4    # choose which notes it comes out of (--offline: which ones go over)
notecase receive --offline             # takes a note on the mint's signature alone
notecase melt 21 --to you@wallet.com   # or a raw bolt11, or --to-nwc
notecase melt <bolt11> 21              # an invoice that names no amount of its own
notecase melt <bolt11> --notes c3e3,b8b4 # choose which notes fund it
notecase transfer 50 --from a.example --to b.example   # move between mints
notecase reconcile                     # resolves anything uncertain
notecase nwc set                       # prompts for the connection URI
notecase nwc grant <name> [--methods a,b] [--budget <sats>] [--max <sats>]
notecase nwc grants | nwc revoke <name> | nwc refill <name> [--budget <sats>]
notecase nwc serve                     # answer NIP-47 for the grants above
notecase nostr init                    # your npub + publishes your inbox relays (kind 10050)
notecase heartwood link bunker://...   # a heartwood signer as a note locker
notecase heartwood notes               # what it holds; the last reading, dated, if it cannot be reached
notecase heartwood inbox               # publishes the device's inbox relays (kind 10050), one hold
notecase heartwood trust <npub|nip05>  # the device stores notes from this sender without a hold (a mint's zap key)
notecase heartwood pair [label]        # mints a bunker URI for another wallet, one hold; first pairing needs the cable
notecase heartwood collect [<id>...]   # brings in what arrived at the device (or just the notes named)
notecase heartwood address keys <name> # a name the DEVICE's key owns, paid to the device's own keys; one hold
notecase heartwood address scan        # payments to those keys whose wrap never reached the device
notecase heartwood recover             # a lost heartwood's notes, from its master's nsec or BIP-39 phrase
notecase backup shares --threshold 2 --count 3
notecase sync on                       # keep the notes themselves on your relays
notecase sync                          # pull, let the mints settle, publish what changed
notecase sync status
```

### Checking your notes

A bearer note has copies by design, so a wallet that never asks can go on
counting money somebody else already spent: the other copy redeemed first,
a melt whose answer never arrived, a rotate that finished without the
wallet hearing. `notecase check` asks every mint about every note it
issued to this wallet and prints what it found - already spent, unknown to
the mint, locked by something in flight, or worth a different amount than
the wallet thought. It is a dry run; `--apply` writes the answers down,
and `--mint <host>` limits it to one mint.

This costs no privacy. The mint made these notes for this wallet and sees
each one the moment it is spent, so asking after them tells it nothing it
does not already hold. A mint that does not answer has its notes left
exactly as they are and is named in the report - never marked.

### Paying with no connection

A note is a secret, so handing one over needs no network at all - but a
wallet holding one 48,120 sat note cannot pay 500, because cutting a note
down needs the mint. That is what the **cash drawer** is for: a ladder of
denominations (100, 500, 1000 and 5000 sats by default, two of each) that
the wallet keeps cut and ready. `notecase prepare` shows what cutting the
missing ones would cost in split fees and `--apply` cuts them; it is
re-runnable, and a full drawer costs nothing to check. `notecase ladder`
shows and sets the shape of the drawer per mint.

With a drawer stocked, `notecase send <sats> --offline` finds notes that
add up to the amount exactly and hands them over as one or more URLs -
no mint is called at all. Where no combination is exact it says so and
names the nearest above, which `--overpay` accepts.

`--notes c3e3,b8b4` says which notes to hand over instead, by the short
ids `list` prints. Offline that is not a preference but the hand-over
itself, since nothing can be cut to size without the mint: a selection
worth more than the asking price is quoted before anything moves and
needs `--overpay`, and one worth less is refused rather than topped up
from a note nobody chose. The web wallet shows the same list under
**Choose which notes to hand over** on the Send screen.

`notecase receive --offline` takes a note on the mint's signature alone.
It needs a pinned key for that mint, so a wallet that has never spoken to
the mint refuses: there would be nothing to check against, and that leap
of faith is one LUD-25 is careful not to ask for. The note is stored
**unrotated** - whoever handed it over still knows its secret - and the
balance says how much is in that state until `notecase reconcile` rotates
every one of them at the first opportunity. If the giver spent their copy
first, reconcile says so and files the note as spent.

Offline mode is asked for and never inferred from connectivity: in the
web wallet it is a switch in the header, and on the CLI it is `--offline`.

### A lightning address

`notecase address claim <name>` takes `name@mint.example` at a mint that
hands them out. The mint charges for it in its own notes, so the wallet
cuts one out of your balance and the mint burns it; where the price is
zero, nothing is cut at all. Moneyer binds the name to this wallet's Nostr
key with a signed NIP-98 request, without an account.

The reference `lnurl-mint` has a different management route. A claim sends
the wallet's `cx1` branch plus a signature from that branch's index-0 key,
proving the wallet controls the keys it is registering. Notecase detects the
route with a reserved-name request that cannot write, then uses signed
`POST /p/<name>` to register or update it. Its npub is included too, so the
same name can resolve over NIP-05. `notecase address unregister [name]`
releases it with the action-separated `DELETE` proof.

When changing branches, Notecase retains the current public `cx1` and uses
that old branch for the one update proof; only after the mint confirms the
change does the replacement branch become the registered one locally.

On Moneyer, what arrives at the address is a bearer note sealed to that same
key, so it is yours seconds after it is paid and the mint holds it for no
longer than that. `notecase inbox` opens what has come in. A note that
arrived as a zap carries the payer's own signed request with it, so the
wallet can show who sent it and what they wrote - and it checks that
signature, so a mint cannot invent a sender.

The reference mint does not send that Nostr wrap. Use `notecase address
scan`, or **Check address for payments** in the web wallet, to find notes on
the branch after payment.

If the mint refuses the name, the note that was going to pay for it comes
straight home under a fresh secret.

**Paid to your own keys.** A wallet with recovery words hands the mint a
`cx1` when it claims a name: a watch-only branch of its keys (LUD-25 Part
2). A mint that takes it, moneyer 0.13 or later, stops holding anything
that could spend what arrives. It credits each payment to your next key and
sends a wrap saying only which key, and `notecase inbox` derives that key,
checks the mint's certificate, and rotates the note onto a secret of its own
at once. `address claim` says which way the mint took it.

- `notecase address keys` moves a Moneyer name you already hold onto your keys;
  `address custodial` moves it back. A reference-mint address has no custodial
  payout mode; use `address unregister` to release it. Give the name, `address keys <name>`,
  for one your key owns that this wallet never claimed itself, such as a
  name the mint's operator set up for you.
- `notecase address scan` walks the branch for anything whose wrap never
  arrived. The note is at the mint either way.

The mint can see every key on that branch, so it can link what is paid to
the name, as it could before. What it can no longer do is spend it.

### Letting something else spend from this wallet

`nwc set` points notecase at somebody else's Lightning. The other
direction is `nwc grant`: a NIP-47 connection over **this** wallet, so an
app that speaks Nostr Wallet Connect can be paid by it, or paid into it,
without ever seeing a note.

```
notecase nwc grant shop                                   # invoice-only, the default
notecase nwc grant agent --methods get_info,pay_invoice --budget 5000 --max 500
notecase nwc grants                                       # what exists, and what it has spent
notecase nwc revoke agent
notecase nwc refill agent --budget 5000
notecase nwc serve                                        # it answers only while this runs
```

What a connection may do is an allowlist, and the default grants no
spending and does not even disclose the balance: `get_info`,
`make_invoice`, `lookup_invoice`. Both of the others are opt-in, per
connection, and **a connection that can spend must carry a budget** -
there is no unlimited grant to hand out by accident. `--max` caps any
single payment on top of that.

That strictness is not caution for its own sake. A bearer note that leaves
is cash: no chargeback, no invoice to dispute, nobody to ring. So:

- A request is answered **once**. Its id is written down and persisted
  *before* the payment is attempted, so a process that dies mid-melt comes
  back knowing not to try again - a relay will happily hand the same
  signed request over twice, and a wallet that treats the second one as
  new has paid twice.
- Requests on one connection are **serialised**, so two arriving together
  cannot both read the same remaining budget and both decide there is room.
- A request older than five minutes is not answered, whatever its own
  `expiration` tag claims about itself.
- Each connection has **its own service key**, so two grants share nothing
  a relay can correlate, and revoking one is deleting a key rather than
  re-issuing everybody else's.
- The budget is charged what the **invoice** says, decoded here. A budget
  checked against a figure the payer supplied is not a budget. It is
  charged before the attempt and given back only when the wallet refused
  outright - anything ambiguous keeps the charge, the same rule the melt
  path already follows.

`pay_invoice` is a melt, and a melt returns "in flight" rather than
"paid". NIP-47 promises a preimage and a careful client checks it against
the invoice, so the service waits for LUD-21 verify to prove settlement
and answers with an error rather than a hopeful blank if it cannot. The
`fees_paid` it reports is measured, not guessed: what the balance actually
lost beyond the invoice amount.

`make_invoice` is a mint quote. The note appears when the invoice is paid,
which the serve loop's reconcile tick claims.

The web wallet has the same list under Settings → **Connected apps**:
what exists, what each may do, what it has spent, and a revoke. A
capability issued on one machine has to be revocable from the device in
your pocket, or it is a bad capability. It can also answer them while that
screen is open, which is enough for a till on a counter; a connection that
has to work overnight wants `notecase nwc serve` on a machine that stays
up, and the screen says so rather than letting someone find out.

Restoring a backup brings grants back **revoked**. The client secret that
spends through one is in the file, so whoever wrote the file may still
hold it, and a restore is exactly when somebody hands you one. They are
listed rather than dropped; re-granting is one command and issues a fresh
secret.

### A hardware vault on the end of a cable

notecase already reaches a heartwood signer through a relay, as a NIP-46
bunker. It now also reaches a vault straight down the wire, speaking the
[lnurl-vault](https://github.com/dni/lnurl-vault) command protocol - which
dni's vault serves and heartwood answers verbatim. No relay, no network,
no third party, and it works with a device that has never been paired for
Nostr at all.

Settings → **Hardware vault** in the web wallet, on a browser with Web
Serial (Chrome or Edge on a desktop; Safari and Firefox have not got it,
and the screen says so rather than offering a button that cannot work).

Both framings are handled, and which one is on the end of the cable is not
something to ask a person: newline-delimited JSON for lnurl-vault, and
heartwood's binary frame (`HW`, type, length, payload, CRC32) for a device
whose serial port also carries signing traffic. A frame whose CRC does not
hold is dropped rather than acted on - the command times out and is
retried, which is the safe end of that trade when the message says whether
a note was confirmed.

**Putting a note on the vault never sends its secret down the cable.** The
device generates a fresh secret, discloses only its hash, and the mint
rotates the note into it, so the value ends up under something this
machine has never seen and never could. That costs no button press,
because nothing is being disclosed for anyone to approve.

**Taking one off costs two presses**, and the screen says so before it
starts: one to release the secret, one to write the note off afterwards.
The order matters - the mint burns the device's secret during the receive,
which rotates, so by the time the second prompt appears the note really is
spent and approving it is bookkeeping. Refusing that second prompt does
not lose anything: the money is here, and the vault's own picture is what
is stale.

**A heartwood in relay mode will refuse the cable, and that is correct.**
Its USB note surface is closed while the relay loop runs, because the
gated commands block for thirty seconds on a button press and that would
stall the relay. The locker is served over Nostr instead, as
`heartwood_note_*` NIP-46 extensions, which is the Hardware signer screen
- so the wallet says so and offers the button rather than reporting a
fault. The cable path wants a device in USB mode, radio off, or dni's
lnurl-vault.

The device's identity is checked with a challenge it cannot have prepared
for - a fresh nonce every time, the signature verified here - and pinned
on first sight. A vault answering with a different key later is either a
different device or a wiped one, and both are worth stopping for. What
that proves is narrow, and worth saying plainly: the thing answering now
holds the same key as the thing that answered before. Not what it is, and
not who has it. Physical possession is still the model.

`get_info`'s storage state is read before any count is believed. A vault
that cannot read its own index reports zero notes, and repeating that at
someone is telling them their money is gone - so `index_unreadable` is
shown with the one instruction that matters, which is reboot and
emphatically do not wipe.

### Notes on a tag

A note is one URL, so it fits in an NDEF URI record and a tag becomes a
coin: tap it and the receive screen opens with the note in it. The
convention is the plainest one available, so other wallets can read the
same tags:

> **a single NDEF URI record holding the note URL**, signature included
> (`lnurlw://mint.example/w?k1=…&amount=…&sig=…`)

Nothing else on the tag, and nothing implied about it. A tag is worse than
a clipboard for secrecy - anyone who taps it owns the sats - so the wallet
says so both when it writes one and when it reads one.

### Notes over Nostr

A note is one URL, so it fits inside a NIP-59 gift wrap. `send --to` cuts
the note, seals it to the recipient's pubkey and publishes the wrap to
their inbox relays. They need no wallet yet: it waits on the relay until
they install one and run `inbox`. Claiming rotates, so the copy on the
relay is dead the moment it is opened - and until then the sender can
`reclaim` it. The sealing happens with the wallet's own key (`nostr init`
makes one); nothing on the relay says who paid whom, or how much.

A [heartwood](https://github.com/forgesworn/heartwood-esp32) signer can do
the same from hardware: it receives wraps while your laptop is shut
(RECEIVE card, hold to accept), and `heartwood send` asks it to seal one of
its own notes so the secret never leaves the chip. `heartwood collect`
brings received notes here and rotates them, because the device cannot.
`heartwood inbox` publishes the device's kind 10050 in its own name, signed
on the device; without it nobody who resolves its npub knows where to
leave a note. `heartwood trust <npub>` names a sender (a mint's zap key)
whose notes the device stores without a hold. The web wallet has the same
under Settings → Hardware signer: pair by bunker URI or QR, collect, trust,
publish.

**The locker is a till, not a vault.** A bearer note IS its secret, so the
device keeps its notes out of every backup on purpose: a restored copy on a
second board is a double-spend, and whichever board redeems first wins. The
price of that is plain - a board that is lost, wiped or dead takes its notes
with it, and no seed phrase, share set or export brings them back. So collect
promptly and keep little on it. `heartwood collect` empties it on one hold.

What `notecase backup` does carry is the *inventory*: per note the device's
id, the amount, the mint host, the state and, for a note paid to the device's
own keys, its index on the branch. None of that can spend anything, so it
adds no double-spend risk - but it turns a dead board from an unknown loss
into a known one, and it is what you show a mint to say what existed.
`heartwood notes` falls back to it, marked as a past reading and dated, when
the device does not answer.

A name whose owner is the device's npub can be paid to the device's own keys
instead (LUD-25 Part 2). `heartwood address keys <name>` asks the device for
the watch-only branch it derives from that identity key. Moneyer has the device
sign the ownership request, on one hold. Current reference-mint registration
requires a separate signature from the branch's index-0 key; Heartwood does not
yet expose that operation, so Notecase refuses that registration instead of
pretending a public `cx1` proves control. Once registered, the mint mints each
payment to the device's next key and the wrap carries no secret at all, only
where to look. Only the device can spend those notes - this wallet's words
cannot - and the device's recovery phrase brings them back. `heartwood
address scan` walks the branch for payments whose wrap never arrived and has
the device keep them; `heartwood collect` takes them, as it takes wraps.

If the heartwood itself is lost, `heartwood recover` rebuilds that branch
from the master's nsec, or the BIP-39 phrase it was made from, prompted for
and checked against the master's npub before anything is derived, then takes
every live note on it into this wallet. A wallet with no recovery words gets
a branch from its own Nostr key the same way, so its name is paid to its own
keys too.

Amounts are sats (`--msat` for precision). The PIN comes from the prompt
or `$NOTECASE_PIN`. `NOTECASE_HOME` moves the store; `NOTECASE_ALLOW_PRIVATE=1`
admits LAN mints through the SSRF guard; `NOTECASE_PROXY=socks5://127.0.0.1:9050`
sends every call through a SOCKS5 proxy, which is how you point this at Tor
(see "What the mint knows" above for what that does and does not buy). `receive` and `nwc set` still
accept their argument on the command line, but prefer the prompted form:
whatever goes on the command line lands in your shell history, and these
two are live secrets.

As a library, the same engine drives other frontends:

```ts
import {Wallet, openWallet, createWalletFetch} from '@forgesworn/notecase'
const store = await openWallet({pin})
const wallet = new Wallet(store.data, store.save, {fetch: createWalletFetch()})
```

## The web wallet

`npm run web:build` produces a fully static, installable PWA (`web/dist`,
vite + anime.js) around the same engine - live at
[wallet.moneyer.dev](https://wallet.moneyer.dev). What it does:

- PIN + biometric (WebAuthn PRF) unlock; the store is the same sealed
  AES-GCM blob the CLI writes.
- Mint (you type what the note should hold - fees are grossed up and
  shown before you pay), receive-and-rotate, exact-amount send behind a
  tap-to-reveal QR with system share, melt to invoice / Lightning Address
  / NWC.
- A note detail view per note: verified-signature badge, panic rotate,
  copy/share/QR - and handed-over notes stay listed until taken, with
  one-tap reclaim.
- Settings → Check your notes: the same sweep as the CLI, with a plain
  reading of what each mint said and an Apply button that asks again
  before writing anything down.
- An offline switch in the header, a cash drawer under each mint (edit the
  ladder, see what cutting the rest would cost, cut it), an offline
  hand-over that pages through several notes one secret at a time, and an
  offline receive that checks the mint's signature and nothing else.
- A note whose signature does not verify is refused with a red card that
  says exactly why; taking it anyway needs two deliberate taps.
- Send to an npub, and an inbox check that opens and claims what was sent
  to yours; the wallet's Nostr identity and inbox relays live in settings.
- Settings → Lightning address: pick a mint, see what it charges, claim
  the name; the home screen then shows the address with a copy button, and
  history shows who zapped it and what they wrote.
- Camera QR scanning (BarcodeDetector, jsQR fallback) with one universal
  scan button that classifies notes, invoices and mint addresses itself.
- History derived from the wallet's own records - nothing logged twice.
- Mint management: per-mint balances, default mint, key pins on display,
  guarded removal.
- Twelve recovery words shown once behind an "I have written them down"
  gate, shown again from Settings after the PIN, and a "Restore from your
  words" door on the welcome screen with "ask my mints what is still
  mine" waiting in Settings.
- Portable backups sealed under their own passphrase (never the 6-digit
  PIN - a file must survive an offline brute force), restorable from the
  welcome screen on any device.
- A `#/claim?u=…` route other sites can link notes into - the fragment
  never reaches a server, and the wallet prefills rather than
  auto-accepts.
- Tap to pay: a note written to an NFC tag is a physical coin, and a tag
  tapped against the phone opens the receive screen with it. Chrome on
  Android only, so the controls simply do not appear elsewhere.
- A share target, so "Share → notecase" from any app hands a note URL,
  an invoice or a mint address to the wallet. Nothing is ever accepted
  automatically: it lands on the screen that asks.
- Installable PWA whose service worker asks before updating and caches no
  protocol call: money answers are live or visibly absent, never stale.

### Serving it

The build is static files and wants no server logic, but two of the
protections it asks for can only come from the host. `frame-ancestors` is
ignored inside a meta element by specification, so a page carrying it in
the HTML alone has no clickjacking protection whatsoever; it has to arrive
as a response header. `X-Frame-Options` says the same thing to browsers
that predate CSP.

Send the whole policy, the same string that is in `web/index.html`:

```caddy
wallet.example.com {
    root * /srv/notecase/web/dist
    file_server
    encode gzip
    header {
        Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' https: wss: http://localhost:* http://127.0.0.1:*; worker-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
        X-Frame-Options DENY
        X-Content-Type-Options nosniff
        Referrer-Policy no-referrer
    }
}
```

Any static host will do; the headers are the requirement, not Caddy.
`connect-src` keeps loopback so the wallet can talk to a mint running on
the holder's own machine, which from a hosted page reaches nothing but
their computer. A test holds this block and the meta tag to the same
policy, because a policy that disagrees with itself protects whichever
half the browser happened to read.

## Testing

```bash
npm test
```

The suite drives the wallet through the conformance mock mint's full
misbehaviour matrix (destroyed responses, never-settling melts, wrong-k1
echoes), through a real NIP-47 ceremony against a fake NWC wallet service
(real keys, real NIP-44, imaginary relay), and through the full circle
against moneyer: NWC-paid mint, send, receive, melt back out, with the
mint's liability ledger balancing the wallets' books at the end.

## Licence

MIT.
