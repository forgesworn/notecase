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

// A decrypted backup is attacker-shaped until checked: the whole WalletData
// is validated before it is allowed anywhere near a store, and no field's
// contents are ever echoed into an error - the contents are exactly what
// cannot be trusted.
const HEX64 = /^[0-9a-f]{64}$/
const HEX = /^[0-9a-f]+$/
const NOTE_STATES = new Set(['live', 'staged', 'ambiguous', 'melting', 'sent', 'spent'])
const NOTE_ORIGINS = new Set(['mint', 'receive', 'rotate', 'split', 'change', 'merge', 'recovered'])
const PENDING_STATES = new Set(['awaiting', 'claimed', 'expired', 'abandoned'])
const MELT_STATES = new Set(['in-flight', 'settled', 'returned'])

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isHttpUrl = (value: unknown): boolean => {
  if (typeof value !== 'string') return false
  try {
    const {protocol} = new URL(value)
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

// host[:port] as the wallet records one - nothing that could smuggle
// markup or a path into a screen or a log line.
const isHost = (value: unknown): boolean => {
  if (typeof value !== 'string' || value.length === 0) return false
  try {
    return new URL(`http://${value}`).host === value
  } catch {
    return false
  }
}

const isAmount = (value: unknown): boolean => typeof value === 'number' && Number.isSafeInteger(value) && value > 0
const isTimestamp = (value: unknown): boolean => typeof value === 'number' && Number.isFinite(value)

const isWalletData = (data: unknown): data is WalletData => {
  // Version 1 wallets predate the seed. They import, and are upgraded in
  // memory below rather than rejected: a backup taken before the seed
  // existed is still somebody's money.
  if (!isRecord(data) || (data.version !== 1 && data.version !== 2)) return false
  if (data.seedHex !== undefined && (typeof data.seedHex !== 'string' || !HEX.test(data.seedHex))) return false
  if (data.mnemonic !== undefined && (typeof data.mnemonic !== 'string' || !/^[a-z ]{1,200}$/.test(data.mnemonic))) {
    return false
  }
  if (data.counters !== undefined) {
    if (!isRecord(data.counters)) return false
    if (Object.values(data.counters).some(value => typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)) {
      return false
    }
  }
  if (!isRecord(data.settings)) return false
  if (data.settings.defaultMintHost !== undefined && typeof data.settings.defaultMintHost !== 'string') return false
  if (data.settings.nwcUri !== undefined && typeof data.settings.nwcUri !== 'string') return false
  if (
    data.settings.vaultPubkey !== undefined &&
    (typeof data.settings.vaultPubkey !== 'string' || !HEX64.test(data.settings.vaultPubkey))
  ) {
    return false
  }

  if (!isRecord(data.pubkeyPins)) return false
  if (Object.values(data.pubkeyPins).some(pin => typeof pin !== 'string' || !HEX.test(pin))) return false

  if (!Array.isArray(data.notes)) return false
  for (const note of data.notes) {
    if (!isRecord(note)) return false
    if (typeof note.id !== 'string' || !HEX64.test(note.id)) return false
    if (typeof note.k1 !== 'string' || !HEX64.test(note.k1)) return false
    if (!isAmount(note.amountMsat)) return false
    if (!isHttpUrl(note.baseUrl)) return false
    // A note taken offline has no callback until it has met its mint: the
    // mint publishes one, and a note URL does not carry it. Empty is the
    // only other thing it may ever be.
    if (note.callback !== '' && !isHttpUrl(note.callback)) return false
    if (!isHost(note.mintHost)) return false
    if (typeof note.state !== 'string' || !NOTE_STATES.has(note.state)) return false
    if (typeof note.origin !== 'string' || !NOTE_ORIGINS.has(note.origin)) return false
    if (note.signature !== undefined && (typeof note.signature !== 'string' || !HEX.test(note.signature))) return false
    if (note.replaces !== undefined && (!Array.isArray(note.replaces) || note.replaces.some(id => typeof id !== 'string'))) {
      return false
    }
    if (note.index !== undefined && (typeof note.index !== 'number' || !Number.isSafeInteger(note.index) || note.index < 0)) {
      return false
    }
    if (!isTimestamp(note.createdAt) || !isTimestamp(note.updatedAt)) return false
  }

  if (!Array.isArray(data.mints)) return false
  for (const mint of data.mints) {
    if (!isRecord(mint)) return false
    if (typeof mint.input !== 'string' || !isHost(mint.host)) return false
    if (!isHttpUrl(mint.payUrl)) return false
    if (mint.baseUrl !== undefined && !isHttpUrl(mint.baseUrl)) return false
    if (mint.label !== undefined && typeof mint.label !== 'string') return false
    if (mint.mintFee !== undefined) {
      if (!isRecord(mint.mintFee)) return false
      if (typeof mint.mintFee.baseFeeMsat !== 'number' || !Number.isFinite(mint.mintFee.baseFeeMsat)) return false
      if (typeof mint.mintFee.feePpm !== 'number' || !Number.isFinite(mint.mintFee.feePpm)) return false
    }
    if (!isTimestamp(mint.addedAt)) return false
  }

  if (!Array.isArray(data.pendingMints)) return false
  for (const pending of data.pendingMints) {
    if (!isRecord(pending)) return false
    if (typeof pending.id !== 'string' || !HEX64.test(pending.id)) return false
    if (!isHost(pending.mintHost) || !isHttpUrl(pending.baseUrl)) return false
    if (typeof pending.pr !== 'string') return false
    if (pending.verifyUrl !== undefined && !isHttpUrl(pending.verifyUrl)) return false
    if (!isAmount(pending.grossMsat) || !isAmount(pending.expectedNetMsat)) return false
    if (typeof pending.state !== 'string' || !PENDING_STATES.has(pending.state)) return false
    if (pending.preimageHex !== undefined && (typeof pending.preimageHex !== 'string' || !HEX64.test(pending.preimageHex))) {
      return false
    }
    if (!isTimestamp(pending.createdAt) || !isTimestamp(pending.updatedAt)) return false
  }

  // A grant is a spending capability, and its client secret is in this
  // file. Whoever wrote the file could keep a copy, so a restored grant is
  // never live (see importBackup) - but it still has to be shaped like one
  // before it is allowed anywhere near the wallet.
  if (data.nwcConnections !== undefined) {
    if (!Array.isArray(data.nwcConnections)) return false
    for (const connection of data.nwcConnections) {
      if (!isRecord(connection)) return false
      if (typeof connection.id !== 'string' || connection.id.length > 64) return false
      if (typeof connection.name !== 'string' || connection.name.length > 200) return false
      for (const key of ['serviceSecretHex', 'clientSecretHex'] as const) {
        if (typeof connection[key] !== 'string' || !HEX64.test(connection[key])) return false
      }
      for (const key of ['servicePubkey', 'clientPubkey'] as const) {
        if (typeof connection[key] !== 'string' || !HEX64.test(connection[key])) return false
      }
      if (!Array.isArray(connection.relays) || connection.relays.length > 32) return false
      if (connection.relays.some(relay => typeof relay !== 'string' || relay.length > 512)) return false
      if (!Array.isArray(connection.methods) || connection.methods.length > 32) return false
      if (connection.methods.some(method => typeof method !== 'string' || !/^[a-z_]{1,40}$/.test(method))) {
        return false
      }
      // spent starts at zero, so this one is not isAmount's positive
      if (
        typeof connection.spentMsat !== 'number' ||
        !Number.isSafeInteger(connection.spentMsat) ||
        connection.spentMsat < 0
      ) {
        return false
      }
      for (const key of ['budgetMsat', 'maxPaymentMsat'] as const) {
        if (connection[key] !== undefined && !isAmount(connection[key])) return false
      }
      if (connection.seen !== undefined) {
        if (!Array.isArray(connection.seen) || connection.seen.length > 1024) return false
        if (connection.seen.some(id => typeof id !== 'string' || !HEX64.test(id))) return false
      }
      if (!isTimestamp(connection.createdAt)) return false
      for (const key of ['lastUsedAt', 'revokedAt'] as const) {
        if (connection[key] !== undefined && !isTimestamp(connection[key])) return false
      }
    }
  }

  if (!Array.isArray(data.melts)) return false
  for (const melt of data.melts) {
    if (!isRecord(melt)) return false
    if (typeof melt.paymentHash !== 'string' || !HEX64.test(melt.paymentHash)) return false
    if (typeof melt.noteId !== 'string' || !HEX64.test(melt.noteId)) return false
    if (typeof melt.pr !== 'string' || typeof melt.target !== 'string') return false
    if (melt.verifyUrl !== undefined && !isHttpUrl(melt.verifyUrl)) return false
    if (!isAmount(melt.amountMsat)) return false
    if (typeof melt.state !== 'string' || !MELT_STATES.has(melt.state)) return false
    if (melt.proofPreimage !== undefined && (typeof melt.proofPreimage !== 'string' || !HEX64.test(melt.proofPreimage))) {
      return false
    }
    if (!isTimestamp(melt.createdAt) || !isTimestamp(melt.updatedAt)) return false
  }

  return true
}

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
  let data: unknown
  try {
    data = await unsealWallet(envelope.sealed, await backupKey(passphrase, envelope.salt))
  } catch {
    throw new BackupError('Wrong passphrase, or the file is damaged.')
  }
  if (!isWalletData(data)) {
    throw new BackupError('The backup decrypted but does not hold a valid wallet.')
  }
  // A version 1 backup predates the seed: it comes in as it is, and the
  // caller gives it one. Its existing notes carry no derivation index, so
  // they stay findable only through this file until they are adopted -
  // which is exactly what the wallet then offers to do.
  if (data.version === 1) {
    data.version = 2
    data.counters ??= {}
  }
  // Every restored NIP-47 grant comes back revoked. The client secret that
  // spends through it is in this file, so whoever wrote the file may still
  // hold it - and a restore is exactly when somebody hands you one. They
  // are listed rather than dropped, because seeing what existed is worth
  // something; re-granting is one command, and it issues a fresh secret.
  for (const connection of data.nwcConnections ?? []) {
    connection.revokedAt ??= Date.now()
  }
  return data
}
