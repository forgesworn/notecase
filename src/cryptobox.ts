import {sha256} from '@noble/hashes/sha2.js'
import {bytesToHex, hexToBytes, utf8ToBytes, randomBytes} from '@noble/hashes/utils.js'
import type {WalletData} from './types.ts'

// The sealed wallet blob, identical on disk (CLI) and in localStorage
// (web): AES-256-GCM under a key derived from the keystore-protected
// store key. Pure Web Crypto, so it runs anywhere the wallet does.

type SealedFile = {v: 1; cipher: 'aes-256-gcm'; iv: string; ct: string}

const b64encode = (bytes: Uint8Array): string => {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

const b64decode = (encoded: string): Uint8Array<ArrayBuffer> => {
  const binary = atob(encoded)
  const bytes = new Uint8Array(new ArrayBuffer(binary.length))
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

const aesKey = async (storeKey: string) =>
  crypto.subtle.importKey('raw', sha256(utf8ToBytes(storeKey)), {name: 'AES-GCM'}, false, [
    'encrypt',
    'decrypt'
  ])

export const sealWallet = async (data: WalletData, storeKey: string): Promise<string> => {
  const iv = randomBytes(12)
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({name: 'AES-GCM', iv}, await aesKey(storeKey), utf8ToBytes(JSON.stringify(data)))
  )
  const file: SealedFile = {v: 1, cipher: 'aes-256-gcm', iv: bytesToHex(iv), ct: b64encode(ct)}
  return JSON.stringify(file)
}

export const unsealWallet = async (contents: string, storeKey: string): Promise<WalletData> => {
  const file = JSON.parse(contents) as SealedFile
  if (file.v !== 1 || file.cipher !== 'aes-256-gcm') throw new Error('Unrecognised wallet file format.')
  const plain = await crypto.subtle.decrypt(
    {name: 'AES-GCM', iv: hexToBytes(file.iv)},
    await aesKey(storeKey),
    b64decode(file.ct)
  )
  return JSON.parse(new TextDecoder().decode(plain)) as WalletData
}
