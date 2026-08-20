import {sha256} from '@noble/hashes/sha2.js'
import {utf8ToBytes} from '@noble/hashes/utils.js'
import {Keystore, browserStorage, browserWebAuthn, type BiometricSetupOptions, type SetupBiometricResult} from 'keystore-kit'
import {sealWallet, unsealWallet} from '../../src/cryptobox.ts'
import {emptyWallet, type WalletData} from '../../src/types.ts'

// The browser wallet store: the same sealed AES-GCM blob the CLI writes,
// kept in localStorage, with keystore-kit's browser adapters guarding the
// store key behind a PIN and - where the device offers it - WebAuthn-PRF
// biometrics. Same money, same discipline, different shelf.

const WALLET_SLOT = 'notecase.wallet.v1'

const keystore = () =>
  new Keystore(
    browserStorage(),
    {
      rpId: location.hostname,
      rpName: 'notecase',
      prfSalt: sha256(utf8ToBytes('notecase-prf-salt-v1'))
    },
    browserWebAuthn()
  )

export type BrowserStore = {
  data: WalletData
  save: () => Promise<void>
  storeKey: string
}

export const walletExists = (): boolean => localStorage.getItem(WALLET_SLOT) !== null

const storeFor = (storeKey: string, data: WalletData): BrowserStore => ({
  data,
  storeKey,
  save: async () => {
    localStorage.setItem(WALLET_SLOT, await sealWallet(data, storeKey))
  }
})

// Creates the device wallet: fresh by default, or around restored data -
// either way under a NEW store key guarded by this device's PIN.
export const createBrowserWallet = async (pin: string, data: WalletData = emptyWallet()): Promise<BrowserStore> => {
  if (walletExists()) throw new Error('A wallet already exists on this device.')
  const ks = keystore()
  const storeKey = ks.generateSecret()
  await ks.setupPIN(pin, storeKey)
  const store = storeFor(storeKey, data)
  await store.save()
  return store
}

// Erases the wallet and its keystore from this device. The caller has
// already made absolutely sure - this does not ask again.
export const forgetBrowserWallet = async (): Promise<void> => {
  localStorage.removeItem(WALLET_SLOT)
  await keystore().burn()
}

export const unlockWithPin = async (pin: string): Promise<BrowserStore | null> => {
  const sealed = localStorage.getItem(WALLET_SLOT)
  if (!sealed) return null
  const storeKey = await keystore().unlockPIN(pin)
  if (storeKey === null) return null
  return storeFor(storeKey, await unsealWallet(sealed, storeKey))
}

export const biometricAvailable = (): Promise<boolean> => keystore().isBiometricAvailable()

// True once a biometric wrap exists. method() reports the most recently
// configured method, and nothing in this app re-configures the PIN after
// biometric (no change-PIN or disable flow), so 'biometric' means a
// credential is in place. Pre-0.2 single-slot data may lack the flag: the
// enable button is then offered once more, and re-enabling migrates.
export const biometricEnabled = (): boolean => keystore().method() === 'biometric'

// The full result goes to the caller: the strong PRF wrap, the opt-in
// device fallback and each failure reason need different words in the UI.
export const enableBiometric = (storeKey: string, opts?: BiometricSetupOptions): Promise<SetupBiometricResult> =>
  keystore().enableBiometric(storeKey, opts)

export const unlockWithBiometric = async (): Promise<BrowserStore | null> => {
  const sealed = localStorage.getItem(WALLET_SLOT)
  if (!sealed) return null
  const storeKey = await keystore().unlockBiometric()
  if (storeKey === null) return null
  return storeFor(storeKey, await unsealWallet(sealed, storeKey))
}
