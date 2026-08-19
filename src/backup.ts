import {bytesToHex, randomBytes, utf8ToBytes} from '@noble/hashes/utils.js'
import {sealWallet, unsealWallet} from './cryptobox.ts'
import type {WalletData} from './types.ts'

// A portable, restore-anywhere backup. The device keystore's PIN wrapping
// deliberately never leaves the device: a 6-digit PIN is fine as a local
// tap-limited gate and hopeless against an offline brute force of a file.
// So a backup is sealed under its own passphrase with a real key
// derivation, and restoring on a new device sets a fresh device PIN.

export class BackupError extends Error {}

const MIN_PASSPHRASE = 10
const PBKDF2_ITERATIONS = 600_000

export type BackupEnvelope = {
  format: 'notecase-backup'
  v: 1
  createdAt: number
  salt: string
  sealed: string
}

const backupKey = async (passphrase: string, saltHex: string): Promise<string> => {
  const material = await crypto.subtle.importKey('raw', utf8ToBytes(passphrase), 'PBKDF2', false, ['deriveBits'])
  const salt = Uint8Array.from(saltHex.match(/../g)!.map(byte => parseInt(byte, 16)))
  const bits = await crypto.subtle.deriveBits(
    {name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256'},
    material,
    256
  )
  return bytesToHex(new Uint8Array(bits))
}

export const exportBackup = async (data: WalletData, passphrase: string): Promise<string> => {
  if (passphrase.length < MIN_PASSPHRASE) {
    throw new BackupError(
      `A backup passphrase needs at least ${MIN_PASSPHRASE} characters - it is the only thing between the file and your notes.`
    )
  }
  const salt = bytesToHex(randomBytes(16))
  const envelope: BackupEnvelope = {
    format: 'notecase-backup',
    v: 1,
    createdAt: Date.now(),
    salt,
    sealed: await sealWallet(data, await backupKey(passphrase, salt))
  }
  return JSON.stringify(envelope)
}

export const importBackup = async (contents: string, passphrase: string): Promise<WalletData> => {
  if (contents.length > 10_000_000) throw new BackupError('That file is far too large to be a wallet backup.')
  let envelope: BackupEnvelope
  try {
    envelope = JSON.parse(contents) as BackupEnvelope
  } catch {
    throw new BackupError('That is not a notecase backup file.')
  }
  if (envelope?.format !== 'notecase-backup' || envelope.v !== 1 || typeof envelope.sealed !== 'string' || typeof envelope.salt !== 'string') {
    throw new BackupError('That is not a notecase backup file.')
  }
  let data: WalletData
  try {
    data = await unsealWallet(envelope.sealed, await backupKey(passphrase, envelope.salt))
  } catch {
    throw new BackupError('Wrong passphrase, or the file is damaged.')
  }
  if (data?.version !== 1 || !Array.isArray(data.notes) || !Array.isArray(data.mints)) {
    throw new BackupError('The backup decrypted but does not hold a wallet.')
  }
  return data
}
