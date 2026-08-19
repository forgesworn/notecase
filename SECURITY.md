# Security policy

notecase holds bearer money. If you find a way to make it lose, leak or
double-count a note, please report it privately.

## Reporting

Open a GitHub security advisory on this repository (Security tab, "Report
a vulnerability"), or contact the maintainer privately. Please do not open
a public issue for anything exploitable before a fix exists.

A useful report names the flow (receive, send, melt, mint, reconcile),
reproduces against the conformance mock mint or `moneyer --dev` - never
against a stranger's mint - and says what the attacker ends up holding.

## Scope

In scope: any path where a disclosed secret is not on disk first; any
ambiguous outcome treated as definitive; any place a k1 reaches a log,
error message or display uninvited; any way a mint or NWC wallet response
moves the wallet's state without the checks THREAT-MODEL.md describes.

Out of scope: an attacker with the PIN and the wallet file, the residual
risks stated in THREAT-MODEL.md, and vulnerabilities in the mints
themselves.

## Supported versions

Pre-1.0: only the latest release. Pin an exact version; LUD-25 is a draft.
