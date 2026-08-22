import {mkdirSync, readFileSync, renameSync, writeFileSync, existsSync, openSync, fsyncSync, closeSync} from 'node:fs'
import {dirname, join} from 'node:path'
import {homedir} from 'node:os'
import {sha256} from '@noble/hashes/sha2.js'
import {bytesToHex, utf8ToBytes, randomBytes} from '@noble/hashes/utils.js'
import {Keystore, type KeystoreStorage} from 'keystore-kit'
import {BadMnemonicError, newMnemonic, normaliseMnemonic, seedFromMnemonic} from './seed.ts'
import {sealWallet, unsealWallet} from './cryptobox.ts'
import {emptyWallet, type WalletData} from './types.ts'

// The wallet file holds bearer secrets and (optionally) an NWC spending
// URI: it is money at rest. Default posture is an AES-256-GCM blob whose
// key lives behind keystore-kit's PIN protection; --insecure-plaintext
// exists for throwaway dev wallets and says so in its name.
//
// Every save is atomic - temp file, fsync, rename, directory fsync -
// because the staging discipline in wallet.ts depends on "persisted"
// meaning persisted.

export const walletHome = (): string => process.env.NOTECASE_HOME ?? join(homedir(), '.notecase')

const KEYSTORE_FILE = 'keystore.json'
const WALLET_FILE = 'wallet.json'

const atomicWrite = (path: string, contents: string): void => {
  const tmp = `${path}.tmp-${bytesToHex(randomBytes(6))}`
  writeFileSync(tmp, contents, {mode: 0o600})
  const fd = openSync(tmp, 'r')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmp, path)
  // The rename itself is only durable once the containing directory is
  // flushed - best-effort: some filesystems refuse to fsync a directory.
  try {
    const dirFd = openSync(dirname(path), 'r')
    try {
      fsyncSync(dirFd)
    } finally {
      closeSync(dirFd)
    }
  } catch {
    // the file is written and renamed; the power-loss window just stays open
  }
}

// keystore-kit's storage seam, over one JSON file. Grace keys hold live
// CryptoKey handles that only structured-clone storage (IndexedDB) can
// keep, so grace mode is simply absent on the CLI.
const fileKeystoreStorage = (path: string): KeystoreStorage => {
  let cache: Record<string, string> = {}
  if (existsSync(path)) cache = JSON.parse(readFileSync(path, 'utf8'))
  const flush = () => atomicWrite(path, JSON.stringify(cache))
  return {
    getItem: key => cache[key] ?? null,
    setItem: (key, value) => {
      cache[key] = value
      flush()
    },
    removeItem: key => {
      delete cache[key]
      flush()
    },
    saveGraceKey: async () => {},
    getGraceKey: async () => null,
    clearGraceKey: async () => {}
  }
}

const keystoreFor = (home: string): Keystore =>
  new Keystore(fileKeystoreStorage(join(home, KEYSTORE_FILE)), {
    rpId: 'notecase.local',
    rpName: 'notecase',
    prfSalt: sha256(utf8ToBytes('notecase-prf-salt-v1'))
  })

export type WalletStore = {
  data: WalletData
  save: () => Promise<void>
  encrypted: boolean
  // hex-encodable secret material for backup shares; null in plaintext mode
  storeKey: string | null
  // The twelve words, returned ONCE by initWallet and never again: the
  // caller must show them or they are lost. Never logged, never written
  // anywhere but the sealed store, and absent when a wallet is opened.
  mnemonic?: string
}

export {BadMnemonicError, newMnemonic, seedFromMnemonic} from './seed.ts'

export class WrongPinError extends Error {}
export class NoWalletError extends Error {}
export class WalletExistsError extends Error {}

export const initWallet = async (options: {pin?: string; home?: string; mnemonic?: string}): Promise<WalletStore> => {
  const home = options.home ?? walletHome()
  mkdirSync(home, {recursive: true, mode: 0o700})
  const walletPath = join(home, WALLET_FILE)
  if (existsSync(walletPath)) throw new WalletExistsError(`a wallet already exists at ${walletPath}`)

  // Restoring passes the words in; a new wallet gets fresh ones. Either
  // way the seed lands in the store before anything else can be written,
  // because every secret this wallet ever makes comes off it.
  const mnemonic = options.mnemonic ? normaliseMnemonic(options.mnemonic) : newMnemonic()
  const data = emptyWallet()
  data.seedHex = seedFromMnemonic(mnemonic)
  data.mnemonic = mnemonic

  if (options.pin === undefined) {
    atomicWrite(walletPath, JSON.stringify({v: 1, cipher: 'none', data}))
    return {
      data,
      encrypted: false,
      storeKey: null,
      mnemonic,
      save: async () => atomicWrite(walletPath, JSON.stringify({v: 1, cipher: 'none', data}))
    }
  }

  const keystore = keystoreFor(home)
  const storeKey = keystore.generateSecret()
  await keystore.setupPIN(options.pin, storeKey)
  atomicWrite(walletPath, await sealWallet(data, storeKey))
  return {
    data,
    encrypted: true,
    storeKey,
    mnemonic,
    save: async () => atomicWrite(walletPath, await sealWallet(data, storeKey))
  }
}

export const openWallet = async (options: {pin?: string; home?: string}): Promise<WalletStore> => {
  const home = options.home ?? walletHome()
  const walletPath = join(home, WALLET_FILE)
  if (!existsSync(walletPath)) throw new NoWalletError('no wallet found - run `notecase init` first')
  const contents = readFileSync(walletPath, 'utf8')

  const parsed = JSON.parse(contents) as {cipher?: string; data?: WalletData}
  if (parsed.cipher === 'none' && parsed.data) {
    const data = parsed.data
    return {
      data,
      encrypted: false,
      storeKey: null,
      save: async () => atomicWrite(walletPath, JSON.stringify({v: 1, cipher: 'none', data}))
    }
  }

  if (options.pin === undefined) throw new WrongPinError('this wallet is PIN-locked - a PIN is required')
  const keystore = keystoreFor(home)
  const storeKey = await keystore.unlockPIN(options.pin)
  if (storeKey === null) throw new WrongPinError('wrong PIN')
  const data = await unsealWallet(contents, storeKey)
  return {
    data,
    encrypted: true,
    storeKey,
    save: async () => atomicWrite(walletPath, await sealWallet(data, storeKey))
  }
}
