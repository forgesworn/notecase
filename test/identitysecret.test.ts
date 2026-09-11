import {describe, expect, it} from 'vitest'
import {generateSecretKey, getPublicKey, nip19} from 'nostr-tools'
import {bytesToHex} from '@noble/hashes/utils.js'
import {fromMnemonic, fromNsec} from 'nsec-tree'
import {identityCandidates, identitySecretFor, NotAnIdentitySecretError} from '../src/identitysecret.ts'
import {npubOf} from '../src/nostr.ts'

// nsec-tree is the reference for how a heartwood master is made from what its
// owner wrote down, and keeps the secret itself private. So each candidate
// here is held to nsec-tree's masterPubkey for the same input.

const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

describe("a heartwood master's secret", () => {
  it('reads an nsec as a bunker master or a tree-nsec master', () => {
    const sk = generateSecretKey()
    const nsec = nip19.nsecEncode(sk)
    const [bunker, treeNsec] = identityCandidates(nsec)
    expect(bunker!.mode).toBe('bunker')
    expect(bunker!.pubkey).toBe(getPublicKey(sk))
    expect(treeNsec!.mode).toBe('tree-nsec')
    expect(npubOf(treeNsec!.pubkey)).toBe(fromNsec(nsec).masterPubkey)
    // and 64 hex is the same key as its nsec
    expect(identityCandidates(bytesToHex(sk)).map(c => c.pubkey)).toEqual([bunker!.pubkey, treeNsec!.pubkey])
  })

  it('reads a BIP-39 phrase as a tree-mnemonic master, passphrase and all', () => {
    const [plain] = identityCandidates(PHRASE)
    expect(plain!.mode).toBe('tree-mnemonic')
    expect(npubOf(plain!.pubkey)).toBe(fromMnemonic(PHRASE).masterPubkey)
    const [salted] = identityCandidates(`  ${PHRASE.toUpperCase()}  `, 'heartwood')
    expect(npubOf(salted!.pubkey)).toBe(fromMnemonic(PHRASE, 'heartwood').masterPubkey)
    expect(salted!.pubkey).not.toBe(plain!.pubkey)
  })

  it('keeps only the candidate that opens the npub it expects', () => {
    const sk = generateSecretKey()
    const nsec = nip19.nsecEncode(sk)
    const treeNsecPubkey = identityCandidates(nsec)[1]!.pubkey
    expect(identitySecretFor(nsec, getPublicKey(sk))?.mode).toBe('bunker')
    expect(identitySecretFor(nsec, treeNsecPubkey)?.mode).toBe('tree-nsec')
    expect(identitySecretFor(nsec, getPublicKey(generateSecretKey()))).toBeNull()
  })

  it('says what it cannot read, rather than deriving nothing quietly', () => {
    expect(() => identityCandidates('nsec1notreally')).toThrow(NotAnIdentitySecretError)
    expect(() => identityCandidates('abandon about banana')).toThrow('not an nsec or a BIP-39 phrase')
    const typed = Array.from({length: 19}, () => 'abandon').join(' ')
    expect(() => identityCandidates(typed)).toThrow('typed recovery words')
  })
})
