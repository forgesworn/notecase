// @vitest-environment happy-dom
import {beforeAll, describe, expect, it} from 'vitest'

// A claim link scanned off an lnurl-vault screen. The vault writes the mint
// endpoint schemeless - "?u=mint.example/w" - because a scheme it can imply
// costs QR capacity it cannot spare.
//
// This is a boot-time path: readClaimHash runs on import, so the hash has to
// be in place before main.ts loads, which is why it lives in its own file
// rather than in web.test.ts.
//
// It is worth pinning because the failure was silent. buildNoteUrl throws on
// a schemeless input, readClaimHash catches and remembers null, and the
// wallet simply shows nothing to claim - no error, no toast, nothing in the
// console. A person scanning a real note off a real device just sees it not
// work.

const K1 = 'aa'.repeat(32)
const CLAIM_KEY = 'notecase:pending-claim'

beforeAll(async () => {
  document.body.innerHTML = '<div id="app"></div><div id="toasts"></div>'
  location.hash = `#/claim?u=mint.example/w&k1=${K1}&a=21000`
  await import('../web/src/main.ts')
})

describe('a claim link from a vault', () => {
  it('resolves a schemeless mint endpoint, keeping its path', () => {
    // LUD-25: "lnurlw://mint.example/w?k1=<P>&amount=<msat> *is* the bearer
    // note" - so /w has to survive, or there is nothing to GET.
    expect(sessionStorage.getItem(CLAIM_KEY)).toBe(
      `https://mint.example/w?k1=${K1}&amount=21000`
    )
  })
})
