import {secp256k1} from '@noble/curves/secp256k1.js'
import {sha256} from '@noble/hashes/sha2.js'
import {bytesToHex, randomBytes, utf8ToBytes} from '@noble/hashes/utils.js'
import {bech32m} from '@scure/base'
import type {LnurlcashOptions} from '../src/lnurlcash.js'
import {Wallet} from '../src/wallet.ts'
import {emptyWallet, type WalletData} from '../src/types.ts'

export type TestWallet = {
  wallet: Wallet
  data: WalletData
  saves: () => number
}

// A wallet over in-memory persistence that still COUNTS saves, so tests
// can assert the persist-before-disclose ordering actually persisted.
export const makeWallet = (opts: LnurlcashOptions = {}): TestWallet => {
  const data = emptyWallet()
  let saves = 0
  const wallet = new Wallet(
    data,
    async () => {
      saves += 1
    },
    {timeoutMs: 3_000, ...opts}
  )
  return {wallet, data, saves: () => saves}
}

export const freshK1 = (): string => bytesToHex(randomBytes(32))

// The 65-byte recoverable-ECDSA ck1 that heartwood firmware still issues
// (common/src/cash_key.rs, ck1_of) and kit <= 0.14 signed: r || s ||
// recovery id over the Lightning signmessage digest. The kit only encodes
// the current shape, so this is built by hand.
export const legacyEcdsaCk1 = (secretKey: Uint8Array): string => {
  const digest = sha256(sha256(utf8ToBytes('Lightning Signed Message:LNURLcash')))
  const lead = secp256k1.sign(digest, secretKey, {format: 'recovered', prehash: false})
  const payload = new Uint8Array([...lead.subarray(1), lead[0]!])
  return bech32m.encode('ck', bech32m.toWords(payload), false)
}

export const waitMs = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
