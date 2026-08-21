# notecase

> A case for Lightning bearer notes. notecase is an LNURLcash (LUD-25)
> wallet: it receives, holds, splits, merges, sends and melts notes whose
> secret IS the money - and it is built so that no crash, timeout or lying
> mint can part you from one.

An independent implementation - not a fork of the reference wallet - that
dogfoods the ForgeSworn stack end to end:

| library | what notecase uses it for |
| --- | --- |
| [`lnurlcash-kit`](https://github.com/TheCryptoDonkey/lnurlcash-kit) | the whole LUD-25 client: resolve, info, rotate, split, merge, melt, mint, verify - and its error taxonomy, which the safety choreography hangs off |
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
- **A pin can move, but only where the mint says so.** A mint's signing
  key is pinned on first contact and a change is refused - unless the mint
  itself already publishes the old key as retired on its discovery
  endpoint, in which case the old key moves to a kept history, the new one
  is pinned, and the change is reported rather than thrown. That is not
  much of a proof, and it is not meant to be: whoever controls the host
  controls the pin either way, which is trust-on-first-use's own argument.
  What the history buys is that a mint doing the right thing stops looking
  exactly like an attack, which is what teaches people to click through
  warnings. Notes signed by a retired key keep verifying, and
  `notecase check --resign` rotates them under the current key for nothing.
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

Not on npm yet - build from source, with the sibling repos it links
against until those publish:

```bash
git clone https://github.com/TheCryptoDonkey/lnurlcash-kit
git clone https://github.com/TheCryptoDonkey/lnurlcash-conformance
git clone https://github.com/forgesworn/keystore-kit
git clone https://github.com/forgesworn/moneyer
git clone https://github.com/forgesworn/notecase
(cd lnurlcash-kit && npm install && npm run build)
(cd keystore-kit && npm install)   # its prepare script builds it
(cd moneyer && npm install && npm run build)
cd notecase && npm install && npm run build
alias notecase="node $PWD/dist/cli.js"
```

```bash
notecase init                          # PIN-locked store at ~/.notecase
notecase mints add mint@mint.example   # or any LNURL / bare domain
notecase mint 21                       # pay via NWC if set, else an invoice to pay
notecase balance
notecase send 8                        # prints a bearer note URL + LNURL
notecase send 8 --to npub1...          # seals it to their key, leaves it on their inbox relays
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
notecase receive --offline             # takes a note on the mint's signature alone
notecase melt 21 --to you@wallet.com   # or a raw bolt11, or --to-nwc
notecase transfer 50 --from a.example --to b.example   # move between mints
notecase reconcile                     # resolves anything uncertain
notecase nwc set                       # prompts for the connection URI
notecase nostr init                    # your npub + publishes your inbox relays (kind 10050)
notecase heartwood link bunker://...   # a heartwood signer as a note locker
notecase heartwood inbox               # publishes the device's inbox relays (kind 10050), one hold
notecase heartwood trust <npub|nip05>  # the device stores notes from this sender without a hold (a mint's zap key)
notecase heartwood pair [label]        # mints a bunker URI for another wallet, one hold; first pairing needs the cable
notecase heartwood collect             # brings in what arrived at the device by wrap
notecase backup shares --threshold 2 --count 3
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
- Camera QR scanning (BarcodeDetector, jsQR fallback) with one universal
  scan button that classifies notes, invoices and mint addresses itself.
- History derived from the wallet's own records - nothing logged twice.
- Mint management: per-mint balances, default mint, key pins on display,
  guarded removal.
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
