import {generateMnemonic, mnemonicToSeedSync, validateMnemonic} from '@scure/bip39'
import {wordlist} from '@scure/bip39/wordlists/english.js'
import {bytesToHex} from '@noble/hashes/utils.js'

// The twelve words. Kept apart from the store so the browser wallet can
// use them too: nothing in here touches a filesystem.
//
// No passphrase. A passphrase is a second secret to lose, and this is a
// wallet whose entire promise is that the words are enough.

export class BadMnemonicError extends Error {}

export const newMnemonic = (): string => generateMnemonic(wordlist, 128)

// Words in, 64-byte BIP39 seed out, hex. Case and spacing are forgiving;
// spelling and order are not, because a wrong list silently derives a
// different wallet rather than failing.
export const seedFromMnemonic = (mnemonic: string): string => {
  const words = normaliseMnemonic(mnemonic)
  if (!validateMnemonic(words, wordlist)) {
    throw new BadMnemonicError('Those are not twelve valid recovery words - check the spelling and the order.')
  }
  return bytesToHex(mnemonicToSeedSync(words))
}

export const normaliseMnemonic = (mnemonic: string): string => mnemonic.trim().toLowerCase().split(/\s+/).join(' ')
