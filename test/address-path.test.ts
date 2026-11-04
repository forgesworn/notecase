import {describe, expect, it} from 'vitest'
import {createRequire} from 'node:module'
import {bytesToHex, hexToBytes} from '@noble/hashes/utils.js'
import {mnemonicToSeedSync} from '@scure/bip39'
import {
  cashNodeToCx1,
  deriveCashAddressNode,
  deriveCashRoot,
  deriveLegacyCashAddressNode,
  deriveLegacyNostrAddressNode,
  deriveLegacyNoteSecretKey,
  deriveLegacyNotePubkey,
  encodeLegacyCx1
} from '../src/lnurlcash.js'
import {makeWallet} from './helpers.ts'

// LUD-26 roots a mint's keys at S = m/139'/d1..d4, the domain without its
// port, and hands a name out as a share, S/0'/2/n'. Recovery words shared
// with lnurl-wallet, or any other wallet on the spec, must name the same
// share, or notes paid to one are invisible to the other.

type Share = {share: number; cx1: string}
type Branch = {seedHex: string; host: string; domain: string; serviceRoot: string; accounts: Array<{account: number; shares: Share[]}>}
type LegacyBranch = {
  mnemonic: string
  host: string
  addressNode: string
  cx1: string
  notes: Array<{purpose: 0 | 1 | 2; index: number; notePubkey: string; noteSecretKey: string}>
  prePurpose: Array<{index: number; notePubkey: string; noteSecretKey: string}>
}

const vectors = createRequire(import.meta.url)
const part2 = vectors('lnurlcash-conformance/vectors/part2.json') as {branches: Branch[]; legacy: {branches: LegacyBranch[]}}
const nostrSeed = vectors('lnurlcash-conformance/vectors/nostr-seed.json') as {
  cases: Array<{identity: string; host: string; domain: string; serviceRoot: string; accounts: Array<{account: number; shares: Share[]}>}>
}

const hexOf = (node: {privateKey: Uint8Array; chainCode: Uint8Array}): string =>
  bytesToHex(node.privateKey) + bytesToHex(node.chainCode)

const cx1Of = (node: Parameters<typeof cashNodeToCx1>[0]): string => encodeLegacyCx1(cashNodeToCx1(node))

describe('the LUD-26 share a name is registered to', () => {
  it('is share 0 of the root S from recovery words, the domain taken without its port', () => {
    expect(part2.branches.length).toBeGreaterThan(0)
    for (const branch of part2.branches) {
      // S is m/139'/d1..d4 for the domain, which is the node the old
      // whole branch was for a host without a port
      expect(hexOf(deriveCashAddressNode(deriveCashRoot(hexToBytes(branch.seedHex)), branch.domain))).toBe(branch.serviceRoot)
      const {wallet, data} = makeWallet()
      data.seedHex = branch.seedHex
      expect(wallet.addressCx1(branch.host)).toBe(branch.accounts[0]!.shares[0]!.cx1)
    }
  })

  it('is share 0 of the root from a Nostr key, for a wallet without words', () => {
    expect(nostrSeed.cases.length).toBeGreaterThan(0)
    for (const branch of nostrSeed.cases) {
      const {wallet, data} = makeWallet()
      data.settings.nostrSecretHex = branch.identity
      expect(wallet.addressCx1(branch.host)).toBe(branch.accounts[0]!.shares[0]!.cx1)
    }
  })

  it('moves on to the next share once one is handed out, and only ever to the next', () => {
    const branch = part2.branches[0]!
    const {wallet, data} = makeWallet()
    data.seedHex = branch.seedHex
    data.settings.addressShares = {[branch.domain]: 1}
    expect(wallet.addressCx1(branch.host)).toBe(branch.accounts[0]!.shares[1]!.cx1)
  })
})

describe('the whole branches a name was registered to before LUD-26', () => {
  it('derives every superseded branch, port included, and its notes on both ladders', () => {
    expect(part2.legacy.branches.length).toBeGreaterThan(0)
    for (const branch of part2.legacy.branches) {
      const node = deriveCashAddressNode(deriveCashRoot(mnemonicToSeedSync(branch.mnemonic)), branch.host)
      expect(hexOf(node)).toBe(branch.addressNode)
      expect(cx1Of(node)).toBe(branch.cx1)
      const {pubkeyXOnly, chainCode} = cashNodeToCx1(node)
      for (const note of branch.notes) {
        expect(bytesToHex(deriveLegacyNotePubkey(pubkeyXOnly, chainCode, note.purpose, note.index))).toBe(note.notePubkey)
        expect(bytesToHex(deriveLegacyNoteSecretKey(node.privateKey, node.chainCode, note.purpose, note.index))).toBe(note.noteSecretKey)
      }
      for (const note of branch.prePurpose) {
        expect(bytesToHex(deriveLegacyNotePubkey(pubkeyXOnly, chainCode, null, note.index))).toBe(note.notePubkey)
        expect(bytesToHex(deriveLegacyNoteSecretKey(node.privateKey, node.chainCode, null, note.index))).toBe(note.noteSecretKey)
      }
    }
  })

  it("matches lnurl-wallet's literal spec-path vector, on the ladder from before purposes", () => {
    const root = deriveCashRoot(
      mnemonicToSeedSync('dragon spell warfare girl patrol false erase surprise satisfy lucky curious ill')
    )
    const node = deriveCashAddressNode(root, 'mint.lnurlcash.com')
    expect(bytesToHex(node.privateKey)).toBe('ec94d2f4f89e8ea4f4335970e9a7781e30b4223eb405b070f9e3930afccbdc9b')
    expect(bytesToHex(node.chainCode)).toBe('62ba198d1cf6f086f85f867aff7f8d6845a65dd93152df219f1815d1f707bc99')
    const {pubkeyXOnly, chainCode} = cashNodeToCx1(node)
    expect(bytesToHex(deriveLegacyNotePubkey(pubkeyXOnly, chainCode, null, 0))).toBe(
      '6fb7c0137fc17fccb337947b361580b7686219f2eeab9d47ed52a49191d5136c'
    )
  })

  it("keeps the old m/139'/1' branch apart, for the notes already paid to it", () => {
    const branch = part2.legacy.branches[0]!
    const root = deriveCashRoot(mnemonicToSeedSync(branch.mnemonic))
    expect(cx1Of(deriveLegacyCashAddressNode(root, branch.host))).not.toBe(branch.cx1)
    const identity = nostrSeed.cases[0]!
    expect(cx1Of(deriveLegacyNostrAddressNode(hexToBytes(identity.identity), identity.host))).not.toBe(
      wallet0Cx1(identity.identity, identity.host)
    )
  })
})

const wallet0Cx1 = (identity: string, host: string): string | null => {
  const {wallet, data} = makeWallet()
  data.settings.nostrSecretHex = identity
  return wallet.addressCx1(host)
}
