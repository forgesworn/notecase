import {buildNoteUrl, rotateNoteWithHash} from 'lnurlcash-kit'
import {bytesToHex, hexToBytes, utf8ToBytes} from '@noble/hashes/utils.js'
import {ed25519} from '@noble/curves/ed25519.js'
import type {Wallet} from './wallet.ts'
import {WalletUsageError} from './wallet.ts'
import type {NoteRecord} from './types.ts'
import type {ReceiveResult} from './wallet.ts'

// A hardware vault on the end of a cable.
//
// heartwood.ts reaches the same device through a relay, as a NIP-46
// signer. This is the other way in: the lnurl-vault command protocol,
// spoken straight down a wire, which is what dni's lnurl-vault serves and
// what heartwood-esp32 answers verbatim. No relay, no network, no third
// party - and it works on a device that has never been paired for Nostr
// at all.
//
// The device is a secret keeper, not a wallet. It generates note secrets,
// discloses only their SHA-256 hash, and tracks state; every mint call
// stays this side of the cable. That division is the whole point: a
// secret the device made has never been anywhere else, so nothing but the
// device has ever been in a position to spend it.

export const VAULT_TIMEOUT_MS = 15_000
// A gated command waits for a hand on the device: a 30 s window, plus room
// for a card queued behind another one.
export const VAULT_GATED_TIMEOUT_MS = 60_000

export class VaultError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

// What the device says it is. Every field past the count is optional
// because a build may not have the hardware to describe.
export type VaultInfo = {
  fwVersion?: string
  board?: string
  noteCount: number
  pendingCount?: number
  // 'ok' | 'full' | 'version_unsupported' | 'unavailable' | 'index_unreadable'
  storage?: string
  capabilities?: {
    buttons?: number
    touch?: boolean
    gated?: boolean
    display?: {width: number; height: number}
    transports?: string[]
  }
  inputs?: {confirm?: string; cancel?: string}
}

export type VaultNote = {
  id: string
  state: 'pending' | 'confirmed' | 'spent'
  amountMsat: number
  host: string
  label?: string
  sig?: string
}

// One command in, one response out. Framing is the transport's business:
// newline-delimited JSON over USB-CDC for lnurl-vault, a binary frame for
// heartwood's shared serial surface, an array of GATT writes over BLE.
export type VaultTransport = {
  request(command: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>>
  close(): void
}

// Storage states that mean a note count is not a count. A client that
// reads `note_count: 0` on one of these and tells someone their vault is
// empty has just told them their money is gone.
export const STORAGE_UNREADABLE = new Set(['full', 'version_unsupported', 'unavailable', 'index_unreadable'])

export const storageAdvice = (storage: string): string => {
  switch (storage) {
    case 'full':
      return 'The vault is out of room. Every note is still on it and none can be read - spend or delete some.'
    case 'index_unreadable':
      return 'The vault could not read its own index this boot. Reboot it. Do NOT wipe: the notes are still there and a wipe is what would destroy them.'
    case 'version_unsupported':
      return 'This firmware is older than the storage format on the device. A newer firmware could read it; this one cannot.'
    case 'unavailable':
      return 'The vault could not bring its storage up at all.'
    default:
      return ''
  }
}

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {}

export class VaultClient {
  private readonly transport: VaultTransport

  constructor(transport: VaultTransport) {
    this.transport = transport
  }

  close(): void {
    this.transport.close()
  }

  private async send<T>(
    command: Record<string, unknown>,
    options: {gated?: boolean} = {}
  ): Promise<T> {
    const reply = await this.transport.request(
      command,
      options.gated ? VAULT_GATED_TIMEOUT_MS : VAULT_TIMEOUT_MS
    )
    if (reply.ok !== true) {
      const code = typeof reply.error === 'string' ? reply.error : 'bad_request'
      const message = typeof reply.message === 'string' ? reply.message : ''
      throw new VaultError(code, message || vaultReason(code))
    }
    return reply as T
  }

  async info(): Promise<VaultInfo> {
    const reply = await this.send<Record<string, unknown>>({cmd: 'get_info'})
    const capabilities = asRecord(reply.capabilities)
    return {
      noteCount: Number(reply.note_count ?? 0),
      ...(typeof reply.fw_version === 'string' ? {fwVersion: reply.fw_version} : {}),
      ...(typeof reply.board === 'string' ? {board: reply.board} : {}),
      ...(reply.pending_count === undefined ? {} : {pendingCount: Number(reply.pending_count)}),
      ...(typeof reply.storage === 'string' ? {storage: reply.storage} : {}),
      ...(reply.capabilities === undefined
        ? {}
        : {
            capabilities: {
              ...(capabilities.buttons === undefined ? {} : {buttons: Number(capabilities.buttons)}),
              ...(capabilities.touch === undefined ? {} : {touch: capabilities.touch === true}),
              ...(capabilities.gated === undefined ? {} : {gated: capabilities.gated === true}),
              ...(capabilities.display === undefined
                ? {}
                : {
                    display: {
                      width: Number(asRecord(capabilities.display).width ?? 0),
                      height: Number(asRecord(capabilities.display).height ?? 0)
                    }
                  }),
              ...(Array.isArray(capabilities.transports)
                ? {transports: capabilities.transports.map(String)}
                : {})
            }
          }),
      ...(reply.inputs === undefined
        ? {}
        : {inputs: asRecord(reply.inputs) as NonNullable<VaultInfo['inputs']>})
    }
  }

  // Challenge-response over the device's own key. The nonce is generated
  // here every time and never reused: a fixed one turns this into a
  // recording anything could replay back. The answer is verified here too,
  // because an unverified signature proves nothing at all - and what it
  // proves when it does verify is narrow: the thing answering now holds
  // the same key as the thing that answered before. Not what it is, not
  // who has it. Physical possession is still the model.
  async identify(): Promise<{pubkey: string; nonce: string}> {
    const nonce = bytesToHex(randomBytes32())
    const reply = await this.send<{pubkey: string; sig: string}>({cmd: 'identify', nonce})
    if (!/^[0-9a-f]{64}$/i.test(reply.pubkey ?? '') || !/^[0-9a-f]{128}$/i.test(reply.sig ?? '')) {
      throw new VaultError('bad_request', 'The vault answered an identity challenge with the wrong shape.')
    }
    if (!ed25519.verify(hexToBytes(reply.sig), identityMessage(nonce), hexToBytes(reply.pubkey))) {
      throw new VaultError(
        'bad_request',
        'The vault could not prove the key it claims - the signature over this challenge does not check out.'
      )
    }
    return {pubkey: reply.pubkey.toLowerCase(), nonce}
  }

  // Every note, paged. `total` is what the device holds; the length of one
  // page is not, which is the mistake this loop exists to avoid.
  async listNotes(): Promise<{notes: VaultNote[]; total: number}> {
    const notes: VaultNote[] = []
    let offset = 0
    let total = 0
    for (;;) {
      const page = await this.send<{
        total: number
        notes: Array<Record<string, unknown>>
        next_offset?: number
      }>({cmd: 'list_notes', offset, limit: 10})
      total = Number(page.total ?? 0)
      for (const raw of page.notes ?? []) {
        notes.push({
          id: String(raw.id),
          state: raw.state as VaultNote['state'],
          amountMsat: Number(raw.amount_msat ?? 0),
          host: String(raw.host ?? ''),
          ...(typeof raw.label === 'string' && raw.label ? {label: raw.label} : {}),
          ...(typeof raw.sig === 'string' && raw.sig ? {sig: raw.sig} : {})
        })
      }
      if (page.next_offset === undefined) return {notes, total}
      offset = page.next_offset
    }
  }

  async newSecret(parentIds: string[], label?: string): Promise<{id: string; h: string}> {
    return this.send<{id: string; h: string}>({
      cmd: 'new_secret',
      parent_ids: parentIds,
      ...(label === undefined ? {} : {label})
    })
  }

  async newSecretPair(parentIds: string[]): Promise<{id: string; h: string; id2: string; h2: string}> {
    return this.send({cmd: 'new_secret_pair', parent_ids: parentIds})
  }

  async confirm(id: string, amountMsat: number, host: string, sig?: string): Promise<void> {
    await this.send({
      cmd: 'confirm',
      id,
      amount_msat: amountMsat,
      host,
      ...(sig === undefined ? {} : {sig})
    })
  }

  async discard(id: string): Promise<void> {
    await this.send({cmd: 'discard', id})
  }

  // Gated: the device asks its owner before it hands a secret over. This is
  // the only command that ever discloses one.
  async exportSecret(id: string): Promise<string> {
    const reply = await this.send<{k1: string}>({cmd: 'export_secret', id}, {gated: true})
    if (!/^[0-9a-f]{64}$/i.test(reply.k1 ?? '')) {
      throw new VaultError('bad_request', 'The vault returned something that is not a secret.')
    }
    return reply.k1.toLowerCase()
  }

  // Idempotent on the secret: a note IS its secret, so a device cannot hold
  // the same one twice, and a retry after a lost reply returns the note the
  // first call made rather than a second one.
  async importSecret(
    k1: string,
    host: string,
    amountMsat: number,
    label?: string
  ): Promise<{id: string}> {
    return this.send<{id: string}>({
      cmd: 'import_secret',
      k1,
      host,
      amount_msat: amountMsat,
      ...(label === undefined ? {} : {label})
    })
  }

  // Gated.
  async markSpent(id: string): Promise<void> {
    await this.send({cmd: 'mark_spent', id}, {gated: true})
  }
}

const vaultReason = (code: string): string => {
  switch (code) {
    case 'user_declined':
      return 'Declined on the device.'
    case 'timeout':
      return 'The device asked and nobody answered.'
    case 'display_unavailable':
      return 'The device could not ask - its screen never came up, so there is nobody to approve. Power it off and on.'
    case 'locked':
      return 'The vault is locked. Unlock it on the device.'
    case 'unsupported':
      return 'This device cannot do that - it has no on-device confirmation wired.'
    case 'storage_full':
      return 'The vault has no room to write. Read its storage state before doing anything else.'
    case 'not_found':
      return 'The vault has no note by that name.'
    case 'invalid_state':
      return 'That note is not in a state where this makes sense.'
    case 'response_too_large':
      return 'The reply did not fit - ask for fewer.'
    default:
      return `The vault refused: ${code}.`
  }
}

// Domain-separated the same way the device separates an OTA approval, so
// an identity challenge can never be replayed as one.
const identityMessage = (nonceHex: string): Uint8Array => {
  const prefix = utf8ToBytes('lnurlvault-id-v1')
  const nonce = hexToBytes(nonceHex)
  const message = new Uint8Array(prefix.length + 1 + nonce.length)
  message.set(prefix)
  message[prefix.length] = 0
  message.set(nonce, prefix.length + 1)
  return message
}

const randomBytes32 = (): Uint8Array => {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return bytes
}

// ---- moving value across the cable ----

// Where a mint's notes live, from the host the device recorded. The device
// stores a host and nothing else, so a note from a mint this wallet has
// never met cannot be turned into a URL - and is refused by name rather
// than guessed at.
const baseUrlFor = (wallet: Wallet, host: string): string => {
  const mint = wallet.data.mints.find(entry => entry.host === host)
  if (!mint?.baseUrl) {
    throw new WalletUsageError(
      `This wallet does not know ${host}, so it cannot reach that note's mint. Add the mint first.`
    )
  }
  return mint.baseUrl
}

export type CollectResult = {
  received: ReceiveResult
  // False when the note is safely here but the device still lists it,
  // because the owner did not approve the second prompt. The money is
  // fine; the device's own picture is stale until mark_spent lands.
  clearedOnDevice: boolean
}

// Take a note off the vault and into this wallet.
//
// Two prompts on the device, and it is worth saying which before starting:
// one to release the secret, one to write the note off once the mint has
// burned it. The order is deliberate - the mint burns the device's secret
// during receive(), which rotates, so by the time the second prompt
// appears the note really is spent and approving it is bookkeeping.
export const collectFromVault = async (
  wallet: Wallet,
  client: VaultClient,
  note: VaultNote
): Promise<CollectResult> => {
  if (note.state !== 'confirmed') {
    throw new WalletUsageError(`That note is ${note.state} on the device, so there is nothing to collect.`)
  }
  const baseUrl = baseUrlFor(wallet, note.host)
  const k1 = await client.exportSecret(note.id)
  const received = await wallet.receive(buildNoteUrl(baseUrl, k1, note.amountMsat))
  try {
    await client.markSpent(note.id)
    return {received, clearedOnDevice: true}
  } catch {
    return {received, clearedOnDevice: false}
  }
}

// Put a note from this wallet onto the vault, under a secret only the
// device knows.
//
// Note what this does NOT do: it never sends the wallet's own secret
// across the cable. The device makes a fresh one, discloses only its
// hash, and the mint rotates this wallet's note into it. The value ends
// up under something this machine has never seen and never could - which
// is the entire reason for the device, and it costs no button press,
// because nothing is being disclosed for anyone to approve.
export type DepositResult = {
  deviceNoteId: string
  // False when the mint has rotated the value onto the device's secret but
  // the device did not record it as confirmed. The money is on the device
  // and safe; the device lists it as pending until a confirm lands.
  confirmedOnDevice: boolean
}

export const depositToVault = async (
  wallet: Wallet,
  client: VaultClient,
  note: NoteRecord
): Promise<DepositResult> => {
  if (note.state !== 'live') {
    throw new WalletUsageError(`Only a live note can be deposited, and that one is ${note.state}.`)
  }
  if (!note.callback) {
    throw new WalletUsageError('That note has not met its mint yet - reconcile first.')
  }
  const fresh = await client.newSecret([], `from notecase, ${note.mintHost}`)
  let signature: string | undefined
  try {
    signature = (await rotateNoteWithHash(note.callback, note.k1, fresh.h, wallet.options)).signature
  } catch (err) {
    // The mint refused, so nothing moved: drop the secret the device
    // staged for it. This wallet's note is exactly as it was.
    await client.discard(fresh.id).catch(() => {})
    throw err
  }
  // Past here the mint has burned this wallet's secret and the value lives
  // under the device's. Everything left is bookkeeping on two sides of a
  // cable, and neither failing loses the money: the device holds a pending
  // note it can confirm, and this wallet writes its own off regardless,
  // because that note is gone whatever anyone records.
  let confirmedOnDevice = true
  try {
    await client.confirm(fresh.id, note.amountMsat, note.mintHost, signature)
  } catch {
    confirmedOnDevice = false
  }
  await wallet.markDeposited(note, `moved onto a vault at ${note.mintHost}`)
  return {deviceNoteId: fresh.id, confirmedOnDevice}
}
