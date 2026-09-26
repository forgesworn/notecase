import {secp256k1} from '@noble/curves/secp256k1.js'
import {hmac} from '@noble/hashes/hmac.js'
import {sha256} from '@noble/hashes/sha2.js'
import {bytesToHex, utf8ToBytes} from '@noble/hashes/utils.js'
import {type MintFee} from '@lnurlcash/kit'
import {
  deriveCashChild,
  deriveCashDomainNode,
  deriveCashRoot,
  type CashNode
} from './cash.js'

export type RandomSecret = () => string

export const defaultRandomSecret: RandomSecret = () =>
  bytesToHex(crypto.getRandomValues(new Uint8Array(32)))

export type MintFeeBand = {minNetMsat: number; maxNetMsat: number}

export const mintFeeBand = (grossMsat: number, fee: MintFee): MintFeeBand => {
  const exactFee = fee.baseFeeMsat + Math.floor((grossMsat * fee.feePpm) / 1_000_000)
  const roundedFee = Math.ceil(exactFee / 1000) * 1000
  return {
    minNetMsat: Math.max(0, grossMsat - roundedFee),
    maxNetMsat: Math.max(0, grossMsat - exactFee)
  }
}

// LUD-25 Part 2's address branch, the literal `m/139'/d1..d4` with the
// hashing key at `m/139'/0`: the node the Part 1 ladder already hangs off,
// whose hardened children a `cx1` cannot reach. lnurl-wallet moved here on
// 2026-09-16 (#166), so recovery words shared with it name the same branch.
export const deriveCashAddressNode = (root: CashNode, host: string): CashNode =>
  deriveCashDomainNode(root, host)

// The branch every wallet used before that, `m/139'/1'/d1..d4`. Never handed
// out again, but notes were paid to it and names still point at it, so it is
// walked and signed for until nothing can be left on it.
export const deriveLegacyCashAddressNode = (root: CashNode, host: string): CashNode =>
  deriveCashDomainNode(deriveCashChild(root, 1 + 0x80000000), host)

export type CashXpub = {pubkeyXOnly: Uint8Array; chainCode: Uint8Array}

export const cashNodeToCx1 = (node: CashNode): CashXpub => ({
  pubkeyXOnly: secp256k1.getPublicKey(node.privateKey, true).slice(1),
  chainCode: node.chainCode.slice()
})

export const NOSTR_CASH_SEED_LABEL = 'LNURLcash/nostr-seed'

export const deriveNostrCashSeed = (secretKey: Uint8Array): Uint8Array => {
  if (!(secretKey instanceof Uint8Array) || secretKey.length !== 32) {
    throw new RangeError('A Nostr secret key is 32 bytes.')
  }
  return hmac(sha256, secretKey, utf8ToBytes(NOSTR_CASH_SEED_LABEL))
}

export const deriveNostrAddressNode = (secretKey: Uint8Array, host: string): CashNode =>
  deriveCashAddressNode(deriveCashRoot(deriveNostrCashSeed(secretKey)), host)

// The same identity's branch on the old path, which heartwood firmware still
// derives and hands out.
export const deriveLegacyNostrAddressNode = (secretKey: Uint8Array, host: string): CashNode =>
  deriveLegacyCashAddressNode(deriveCashRoot(deriveNostrCashSeed(secretKey)), host)

export type MergeBatchOptions = {budget?: number; maxNotes?: number}

export const mergeBatches = (
  callback: string,
  k1s: string[],
  options: MergeBatchOptions | number = {}
): string[][] => {
  const {budget = 2000, maxNotes = 20} =
    typeof options === 'number' ? {budget: options, maxNotes: 20} : options
  const placeholder = '0'.repeat(64)
  new URL(callback)
  const fits = (candidate: string[], carried: boolean): boolean => {
    const url = new URL(callback)
    if (carried) url.searchParams.append('k1', placeholder)
    for (const k1 of candidate) url.searchParams.append('k1', k1)
    url.searchParams.append('h', placeholder)
    return url.href.length <= budget
  }
  const batches: string[][] = []
  let batch: string[] = []
  for (const k1 of k1s) {
    const next = [...batch, k1]
    if (batch.length > 0 && (next.length > maxNotes || !fits(next, batches.length > 0))) {
      batches.push(batch)
      batch = [k1]
    } else {
      batch = next
    }
  }
  if (batch.length > 0) batches.push(batch)
  return batches
}
