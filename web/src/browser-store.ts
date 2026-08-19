import {sha256} from '@noble/hashes/sha2.js'
import {utf8ToBytes} from '@noble/hashes/utils.js'
import {Keystore, browserStorage, browserWebAuthn} from 'keystore-kit'
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

export const createBrowserWallet = async (pin: string): Promise<BrowserStore> => {
  if (walletExists()) throw new Error('A wallet already exists on this device.')
  const ks = keystore()
  const storeKey = ks.generateSecret()
  await ks.setupPIN(pin, storeKey)
  const store = storeFor(storeKey, emptyWallet())
  await store.save()
  return store
}

export const unlockWithPin = async (pin: string): Promise<BrowserStore | null> => {
  const sealed = localStorage.getItem(WALLET_SLOT)
  if (!sealed) return null
  const storeKey = await keystore().unlockPIN(pin)
  if (storeKey === null) return null
  return storeFor(storeKey, await unsealWallet(sealed, storeKey))
}

export const biometricAvailable = (): Promise<boolean> => keystore().isBiometricAvailable()

export const enableBiometric = async (storeKey: string): Promise<boolean> => {
  const result = await keystore().enableBiometric(storeKey)
  return result.ok
}

export const unlockWithBiometric = async (): Promise<BrowserStore | null> => {
  const sealed = localStorage.getItem(WALLET_SLOT)
  if (!sealed) return null
  const storeKey = await keystore().unlockBiometric()
  if (storeKey === null) return null
  return storeFor(storeKey, await unsealWallet(sealed, storeKey))
}
