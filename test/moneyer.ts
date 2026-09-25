import * as moneyer from '@forgesworn/moneyer'
import {bearerNoteIdOfPreimage, hashK1} from '../src/lnurlcash.js'

// Which moneyer these tests are running against, read off what the package
// exports, so it follows the lockfile rather than anything at run time.
//
// The pinned release predates lnurl/luds 6e865b1: it files a bearer note
// under sha256(k1), reads only the deprecated ck1 shapes, and takes a name's
// cx1 on its NIP-98 signature alone. The release that follows the change
// files every note under its Q, reads a ck1 signed over its own domain-bound
// sighash, and wants the branch's address proof for any cx1 it is asked to
// set or clear. The handful of tests that meet the difference say which one
// they are describing; once the pin moves, this and they can go.
export const taprootMoneyer = 'decodeSpend' in moneyer

// The id moneyer files a bearer note under, for a test that credits one
// straight into its store.
export const moneyerBearerId = (k1: string): string => (taprootMoneyer ? bearerNoteIdOfPreimage(k1) : hashK1(k1))
