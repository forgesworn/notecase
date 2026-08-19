import {bytesToHex, randomBytes} from '@noble/hashes/utils.js'
import {Wallet} from '../src/wallet.ts'
import {emptyWallet, type WalletData} from '../src/types.ts'

export type TestWallet = {
  wallet: Wallet
  data: WalletData
  saves: () => number
}

// A wallet over in-memory persistence that still COUNTS saves, so tests
// can assert the persist-before-disclose ordering actually persisted.
export const makeWallet = (): TestWallet => {
  const data = emptyWallet()
  let saves = 0
  const wallet = new Wallet(
    data,
    async () => {
      saves += 1
    },
    {timeoutMs: 3_000}
  )
  return {wallet, data, saves: () => saves}
}

export const freshK1 = (): string => bytesToHex(randomBytes(32))

export const waitMs = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
