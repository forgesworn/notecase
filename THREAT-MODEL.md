# Threat model

notecase holds bearer secrets: whoever reads a live k1 owns that money.
Everything below follows from that.

## Assets

- Live and staged note secrets in the wallet file.
- The NWC connection URI (a spending capability over an external wallet).
- The store key protecting both, and its Shamir shares once exported.

## Adversaries and defences

**Whoever reads the wallet file.** The file is AES-256-GCM under a store
key that keystore-kit guards with the PIN; the plaintext mode is opt-in
and named `--insecure-plaintext`. Writes are atomic (temp, fsync, rename)
with 0600 modes. The k1 of a note is never printed, logged or echoed
except by an explicit `send` or `backup export`.

**A crash at the worst moment.** Fresh secrets are persisted before their
hashes are disclosed; uncertain outcomes are parked as `staged`/
`ambiguous`/`melting` states that reconcile resolves by probing. There is
no code path where a disclosed secret exists only in memory.

**A lying or hostile mint.** The URL's own `amount` is treated as a claim;
`maxWithdrawable` from the informational GET is authoritative (a mismatch
is surfaced). A mint echoing a different k1 is a hard protocol error and
nothing is stored. Mint pubkeys are pinned on first use; a changed key
refuses with a `PinMismatchError` rather than quietly re-pinning.
Service-generated replacement secrets are structurally impossible: the
wallet only ever discloses hashes of secrets it already persisted.

**A mint that answers ambiguously on purpose.** The kit's taxonomy is the
contract: only a definitive rejection unstages anything; every ambiguous
shape keeps the staged secrets and defers to reconcile. The conformance
mock mint's misbehaviour matrix runs in CI to keep this true.

**A melt that never settles.** The note stays `melting` and every other
operation on it refuses; the reconcile probe uses a rotate - safe in every
outcome: it succeeds only if the melt failed and the mint restored the
note, in which case the note is now under a fresh secret anyway.

**A wallet service (NWC) claiming payments it did not make.** Every
invoice is decoded and amount-checked before paying; every claimed
payment must present a preimage that settles the invoice's payment hash,
or it is treated as unproven. Post-publication NWC failures are ambiguous
by nwc-kit's model; the pending mint record survives them and reconcile
claims once LUD-21 verify shows settlement.

**DNS rebinding and SSRF.** Public hostnames go through farrier-kit's
DNS-pinned fetch (resolve once, reject private answers, pin the socket).
Loopback literals bypass it deliberately - a literal cannot rebind, and
local mints are how development happens. `NOTECASE_ALLOW_PRIVATE=1` is the
explicit LAN opt-in.

The web build cannot do any of that: a browser's fetch has no socket
control, so DNS pinning - and with it the rebinding defence - is CLI-only.
The web app is left with the mitigations a browser allows: scheme
admission, no-store requests and user-confirmed actions only.

**Relays, once the note store is switched on.** Off by default, and the
biggest single change a holder can make to this model: with it on, every
note record - k1 included - is published to relays, encrypted NIP-44 to a
key derived as `sha256(seed || "lnurlcash-mint-backup")`. That key is
deliberately not the wallet's Nostr identity, so knowing somebody's npub
does not find their money, and it is the only key that opens any of it.
A relay holds ciphertext and metadata: how many records exist, and when
they change. It cannot read a secret, and neither can anyone who has not
got the seed.

What this moves, honestly: the seed was already the whole wallet, so a
leaked seed already lost the money. What changes is that an attacker who
gets the seed no longer needs the file or the device - the money is
fetchable from a public relay. Twelve words are now sufficient as well as
necessary, for the holder and for whoever takes them. A note in a terminal
state travels without its secret, because a burned k1 has no reason to sit
on a relay, but a live one must travel in full or the other device cannot
spend it.

The merge refuses to move in the dangerous direction: a note this wallet
has already spent is never returned to `live` by a relay copy, however new
that copy is, and a note any device reports as spent is marked spent
everywhere. The relay is not the arbiter of what is spendable - the mint
is, and the check sweep runs over anything a sync brought in that this
wallet had not seen before.

## Residual risks, stated plainly

- Whoever has the PIN and the file has the money. The PIN is the last
  line; pick one accordingly, and treat `backup shares` output as what it
  is - the key, in words.
- A `sent` note is live money in someone else's hands; until they rotate,
  both of you know the secret. That is the nature of bearer instruments,
  not a bug this wallet can fix.
- The wallet trusts its pinned mint to honour the protocol for value; a
  mint can always refuse to honour its own notes. Offline signatures prove
  issuance, not solvency.
- With the note store on, two devices can hold the same live note at the
  same moment, and both can try to spend it. The mint settles that - the
  second attempt is refused - but until a sync runs, the losing device
  shows money it no longer has. Sync often, and treat a balance as the
  last thing a mint agreed to rather than an oracle.
- Derivation counters are merged by taking the highest any device has
  published, which closes the collision but does not eliminate it: two
  devices minting between the same pair of syncs can still derive the same
  secret. The mint refuses the second as a repeated output hash, and
  `mutate` treats that as a failed mutation rather than a lost note.
