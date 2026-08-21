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
  them. Never both, never neither.
- **Melt OK means in flight.** The note locks as `melting`; reconcile
  confirms settlement through LUD-21 verify, or recovers a restored note
  under a fresh secret via a rotate probe - the one operation that is safe
  whichever way the melt went.
- **Rotate immediately, always.** On receive and on claim, because the
  sender - or anyone who saw the mint invoice - still knows the old secret.
- **Never print a k1** unless you asked to send. Balances, lists and logs
  show note ids (hashes) only.
- **A transfer is two mints, never one.** `transfer` mints at the
  destination and melts at the source to pay for it, so it inherits every
  rule above: the melt is in flight until proven otherwise, the arriving
  note is rotated on claim, and a destination with no LUD-21 verify is
  refused before anything is burned - nothing could ever learn the preimage
  there, and the preimage is the money.

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
admits LAN mints through the SSRF guard. `receive` and `nwc set` still
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
