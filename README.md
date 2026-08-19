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
notecase receive                       # prompts for the note, rotates it in
notecase melt 21 --to you@wallet.com   # or a raw bolt11, or --to-nwc
notecase reconcile                     # resolves anything uncertain
notecase nwc set                       # prompts for the connection URI
notecase backup shares --threshold 2 --count 3
```

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
