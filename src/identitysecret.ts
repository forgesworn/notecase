import {hmac} from '@noble/hashes/hmac.js'
import {sha256} from '@noble/hashes/sha2.js'
import {hexToBytes, utf8ToBytes} from '@noble/hashes/utils.js'
import {mnemonicToSeedSync, validateMnemonic} from '@scure/bip39'
import {wordlist} from '@scure/bip39/wordlists/english.js'
import {getPublicKey, nip19} from 'nostr-tools'
import {deriveCashChild, deriveCashMaster} from './lnurlcash.js'
import {normaliseMnemonic} from './seed.ts'

// The secret a heartwood master holds, from what its owner wrote down.
//
// Heartwood provisions a master one of three ways (heartwood-esp32
// common/src/types.rs, MasterMode):
//
//   bunker         the nsec itself
//   tree-nsec      HMAC-SHA256(key = nsec, msg = "nsec-tree-root")
//   tree-mnemonic  BIP-32 m/44'/1237'/727'/0'/0' from the BIP-39 phrase
//
// An nsec alone cannot say which of the first two it was, so both are
// offered, and the caller keeps the one whose public key is the npub it
// expects. nsec-tree's fromNsec/fromMnemonic are the reference, and the tests
// hold these to their masterPubkey; nsec-tree keeps the secret itself private,
// which is why it is derived again here.
//
// Every candidate is a live private key. Callers zero the ones they discard.

export type IdentityMode = 'bunker' | 'tree-nsec' | 'tree-mnemonic'
export type IdentityCandidate = {mode: IdentityMode; secret: Uint8Array; pubkey: string}

export class NotAnIdentitySecretError extends Error {}

const NSEC_TREE_ROOT_LABEL = utf8ToBytes('nsec-tree-root')
const HARDENED = 0x80000000
const NSEC_TREE_PATH = [44, 1237, 727, 0, 0]

const candidate = (mode: IdentityMode, secret: Uint8Array): IdentityCandidate => ({
  mode,
  secret,
  pubkey: getPublicKey(secret)
})

const nsecBytes = (input: string): Uint8Array | null => {
  if (/^nsec1/i.test(input)) {
    try {
      const decoded = nip19.decode(input.toLowerCase())
      return decoded.type === 'nsec' ? decoded.data : null
    } catch {
      return null
    }
  }
  return /^[0-9a-f]{64}$/i.test(input) ? hexToBytes(input.toLowerCase()) : null
}

// Everything the input could be the master secret of. Throws on input that
// is neither an nsec nor a BIP-39 phrase, rather than returning nothing, so a
// mistyped phrase is told apart from a phrase for some other npub.
export const identityCandidates = (input: string, passphrase = ''): IdentityCandidate[] => {
  const trimmed = input.trim()
  const nsec = nsecBytes(trimmed)
  if (nsec) {
    return [candidate('bunker', nsec), candidate('tree-nsec', hmac(sha256, nsec, NSEC_TREE_ROOT_LABEL))]
  }
  const words = normaliseMnemonic(trimmed)
  const count = words.split(' ').length
  if (validateMnemonic(words, wordlist)) {
    let node = deriveCashMaster(mnemonicToSeedSync(words, passphrase))
    for (const index of NSEC_TREE_PATH) node = deriveCashChild(node, index + HARDENED)
    return [candidate('tree-mnemonic', node.privateKey)]
  }
  if (count === 19 || count === 31) {
    throw new NotAnIdentitySecretError(
      "Those look like heartwood's typed recovery words, which this wallet cannot read yet. Enter the master's nsec, or the BIP-39 phrase it was made from."
    )
  }
  throw new NotAnIdentitySecretError('That is not an nsec or a BIP-39 phrase - check the spelling and the order.')
}

// The candidate whose public key is `expectedPubkey`, or null. The rest are
// zeroed before returning.
export const identitySecretFor = (
  input: string,
  expectedPubkey: string,
  passphrase = ''
): IdentityCandidate | null => {
  const candidates = identityCandidates(input, passphrase)
  const match = candidates.find(c => c.pubkey === expectedPubkey.toLowerCase()) ?? null
  for (const c of candidates) if (c !== match) c.secret.fill(0)
  return match
}
