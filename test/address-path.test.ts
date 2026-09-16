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
  deriveNostrAddressNode,
  deriveNotePubkey,
  encodeCx1
} from '../src/lnurlcash.js'

// The Part 2 address branch is the literal m/139'/d1..d4. Recovery words
// shared with lnurl-wallet, or any other wallet on the spec, must name the
// same branch, or notes paid to one are invisible to the other.

const vectors = createRequire(import.meta.url)
const part2 = vectors('lnurlcash-conformance/vectors/part2.json') as {
  branches: Array<{seedHex: string; host: string; addressNode: string; cx1: string}>
}
const nostrSeed = vectors('lnurlcash-conformance/vectors/nostr-seed.json') as {
  cases: Array<{identity: string; host: string; addressNode: string; cx1: string}>
}

const hexOf = (node: {privateKey: Uint8Array; chainCode: Uint8Array}): string =>
  bytesToHex(node.privateKey) + bytesToHex(node.chainCode)

const cx1Of = (node: Parameters<typeof cashNodeToCx1>[0]): string => {
  const {pubkeyXOnly, chainCode} = cashNodeToCx1(node)
  return encodeCx1(pubkeyXOnly, chainCode)
}

describe('the address branch', () => {
  it("derives every conformance branch from recovery words", () => {
    expect(part2.branches.length).toBeGreaterThan(0)
    for (const branch of part2.branches) {
      const node = deriveCashAddressNode(deriveCashRoot(hexToBytes(branch.seedHex)), branch.host)
      expect(hexOf(node)).toBe(branch.addressNode)
      expect(cx1Of(node)).toBe(branch.cx1)
    }
  })

  it("derives every conformance branch from a Nostr key", () => {
    expect(nostrSeed.cases.length).toBeGreaterThan(0)
    for (const branch of nostrSeed.cases) {
      const node = deriveNostrAddressNode(hexToBytes(branch.identity), branch.host)
      expect(hexOf(node)).toBe(branch.addressNode)
      expect(cx1Of(node)).toBe(branch.cx1)
    }
  })

  it("matches lnurl-wallet's literal spec-path vector", () => {
    const root = deriveCashRoot(
      mnemonicToSeedSync('dragon spell warfare girl patrol false erase surprise satisfy lucky curious ill')
    )
    const node = deriveCashAddressNode(root, 'mint.lnurlcash.com')
    expect(bytesToHex(node.privateKey)).toBe('ec94d2f4f89e8ea4f4335970e9a7781e30b4223eb405b070f9e3930afccbdc9b')
    expect(bytesToHex(node.chainCode)).toBe('62ba198d1cf6f086f85f867aff7f8d6845a65dd93152df219f1815d1f707bc99')
    const {pubkeyXOnly, chainCode} = cashNodeToCx1(node)
    expect(bytesToHex(deriveNotePubkey(pubkeyXOnly, chainCode, 0))).toBe(
      '6fb7c0137fc17fccb337947b361580b7686219f2eeab9d47ed52a49191d5136c'
    )
  })

  it("keeps the old m/139'/1' branch apart, for the notes already paid to it", () => {
    const branch = part2.branches[0]!
    const root = deriveCashRoot(hexToBytes(branch.seedHex))
    expect(cx1Of(deriveLegacyCashAddressNode(root, branch.host))).not.toBe(branch.cx1)
    const identity = nostrSeed.cases[0]!
    expect(cx1Of(deriveLegacyNostrAddressNode(hexToBytes(identity.identity), identity.host))).not.toBe(identity.cx1)
  })
})
