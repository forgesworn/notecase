# notecase

An LNURLcash (LUD-25) wallet for Node 22+: receives, holds, splits, merges,
sends and melts Lightning bearer notes whose secret IS the money. Ships a
CLI (`notecase`) and a reusable engine (`Wallet`, `openWallet`, `initWallet`
from `src/index.ts`). ESM-only. A companion web UI lives in `web/`.

## Build & Test

| Command | Purpose |
|---------|---------|
| `npm ci` | Install dependencies |
| `npm run build` | Compile the library to `dist/` |
| `npm test` | Run the vitest suite |
| `npm run test:watch` | Run tests in watch mode |
| `npm run typecheck` | Type-check `src` and `test` |
| `npm run typecheck:web` | Type-check `web/` |
| `npm run web:dev` | Run the web UI locally |
| `npm run web:build` | Build the web UI |
| `npm run check` | Everything CI runs: typecheck, web typecheck, test, build, web build, pack dry-run |

There is no separate lint script; `npm run check` is what CI (`.github/workflows/ci.yml`) runs.

## Structure

```
src/            engine: wallet.ts, store.ts, cash.ts, cli.ts, nwc*.ts, vault*.ts, ...
src/index.ts    public exports (the package's "." entry point)
src/cli.ts      the notecase CLI, built to dist/cli.js (the bin entry)
test/           vitest suite, mirrors src/
web/            companion web UI (Vite), typechecked and built separately
llms.txt        machine-oriented index of the CLI and library API
```

## Conventions

- British English in prose and commit messages.
- ESM only, Node >= 22; `.ts` extensions are used in relative imports (`rewriteRelativeImportExtensions`).
- Amounts are integer millisatoshis inside the engine; the CLI speaks sats.
- Dependencies on other ForgeSworn packages (`@lnurlcash/kit`, `farrier-kit`, `@forgesworn/nwc-kit`, `keystore-kit`, `@forgesworn/shamir-words`) are treated as the protocol/crypto boundary: do not reimplement what they already do.

## Key Files

| File | Purpose |
|------|---------|
| `src/wallet.ts` | the `Wallet` class: receive/send/melt/mint/reconcile and the engine's error classes |
| `src/store.ts` | encrypted wallet store on disk: `openWallet`, `initWallet`, `walletHome` |
| `src/cli.ts` | CLI command wiring |
| `src/nwc.ts`, `src/nwcservice.ts`, `src/nwcbridge.ts` | NWC (NIP-47) client and service runtime |
| `src/vaultport.ts`, `src/vaultwire.ts` | the lnurl-vault wire protocol client |
| `src/spend.ts` | LUD-25's taproot notes: note ids (`hex(Q)`), ck1/cw1 spends, cs1 over Q, address proofs. The pinned kit predates these; prefer the kit's own once it carries them |
| `src/noteids.ts` | moving stored note ids from `sha256(k1)` onto `hex(Q)`, run wherever wallet data is read |
| `THREAT-MODEL.md` | the safety invariants the engine enforces; read before touching `wallet.ts` |

## Common Pitfalls

- Persist-before-disclose and definitive-vs-ambiguous rejection handling (see `THREAT-MODEL.md` and `llms.txt`) are safety invariants, not style choices: get them wrong and a crash can lose a note.
- A note's id is `hex(Q)`, not `sha256(k1)`; the wire still carries a bearer note's `h`. Compare notes by id (`noteIdOf`), never by k1, and import signing and id helpers from `src/lnurlcash.js`, which shadows the kit's older ones.
- A few integration tests describe the pinned moneyer and the taproot one differently; `test/moneyer.ts` says which is installed.
- Some test files are excluded from `tsconfig.json`'s `include` (see its `exclude` list, e.g. `test/web.test.ts`); they belong to the web UI's own typecheck.
- `npm run check` also runs `npm pack --dry-run`, so a broken `files` list in `package.json` fails CI even though nothing else touches it.

## Verify a change

Run `npm run check` before committing; it covers typecheck, tests, build and packaging in one command.
