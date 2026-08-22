import {finalizeEvent, getPublicKey, nip44, type Event, type Filter} from 'nostr-tools'
import {sha256} from '@noble/hashes/sha2.js'
import {bytesToHex, hexToBytes, utf8ToBytes} from '@noble/hashes/utils.js'
import {BOOTSTRAP_RELAYS, type NostrTransport} from './nostr.ts'
import type {MintEntry, WalletData} from './types.ts'

// Backing the mint LIST up to Nostr, so twelve words are enough.
//
// restoreNotes finds a wallet's notes at a mint by re-deriving their
// secrets, which is the hard half. The easy half defeats it on its own: a
// fresh wallet does not know WHICH mints to ask. Words alone then recover
// nothing, and the holder needs a file after all, which is the situation
// the words existed to avoid.
//
// So the list travels, encrypted, under a key nobody can connect to the
// holder. Cashu solves the same problem the same way in NUT-27, and this
// mirrors its construction with our own domain string.
//
// What goes out is which mints this wallet uses, which keys it pinned, and
// which mint is the default. What never goes out: a note, a secret, a
// balance, a counter, or anything about the wallet's own Nostr identity.
// The list is not nothing - it says where somebody banks - which is why it
// is encrypted, why the key is unlinkable, and why the whole thing is off
// unless the holder turns it on.

export const MINT_BACKUP_KIND = 30078
export const MINT_BACKUP_D_TAG = 'lnurlcash-mints'

// The domain string is what stops this key being the same key some other
// scheme derives from the same seed. Changing it orphans every backup
// already published, so it is fixed for good.
const DOMAIN = 'lnurlcash-mint-backup'

export type MintBackupPayload = {
  v: 1
  mints: Array<Pick<MintEntry, 'input' | 'host' | 'payUrl' | 'baseUrl' | 'label'>>
  pins: Record<string, string>
  defaultMintHost?: string
  updatedAt: number
}

export type MintBackupKey = {secret: Uint8Array; pubkey: string}

// priv = sha256(seed || "lnurlcash-mint-backup")
//
// Deliberately NOT the wallet's Nostr identity. If it were, anyone who
// knows the holder's npub could see that they run an LNURLcash wallet and
// how often its mint list changes, which is a lot to give away for a
// convenience. This key is used for nothing else and says nothing about
// who its owner is.
export const mintBackupKey = (seed: Uint8Array): MintBackupKey => {
  const secret = sha256(new Uint8Array([...seed, ...utf8ToBytes(DOMAIN)]))
  return {secret, pubkey: getPublicKey(secret)}
}

// Encrypted to itself: the author and the only reader are the same key, so
// there is no second party to agree a conversation key with.
const selfKey = (key: MintBackupKey): Uint8Array =>
  nip44.getConversationKey(key.secret, key.pubkey)

export const buildMintBackup = (data: WalletData): MintBackupPayload => ({
  v: 1,
  // Only what is needed to find the mints again. A ladder, a fee cache or
  // a rotation timestamp is local bookkeeping and would be one more thing
  // leaking from a list that is already more than nothing.
  mints: data.mints.map(mint => ({
    input: mint.input,
    host: mint.host,
    payUrl: mint.payUrl,
    ...(mint.baseUrl ? {baseUrl: mint.baseUrl} : {}),
    ...(mint.label ? {label: mint.label} : {})
  })),
  // The pins travel because losing them is worse than carrying them: a
  // restored wallet with no pin trusts whatever key it meets first, and
  // the whole point of TOFU is that the FIRST contact is the trusted one.
  pins: {...data.pubkeyPins},
  ...(data.settings.defaultMintHost ? {defaultMintHost: data.settings.defaultMintHost} : {}),
  updatedAt: Date.now()
})

export const encodeMintBackup = (key: MintBackupKey, payload: MintBackupPayload): Event =>
  finalizeEvent(
    {
      kind: MINT_BACKUP_KIND,
      created_at: Math.floor(Date.now() / 1000),
      // Addressable: one event per wallet, replaced rather than appended,
      // so a relay holds the current list and not a history of every mint
      // this holder has ever added.
      tags: [['d', MINT_BACKUP_D_TAG]],
      content: nip44.encrypt(JSON.stringify(payload), selfKey(key))
    },
    key.secret
  )

export const decodeMintBackup = (key: MintBackupKey, event: Event): MintBackupPayload | null => {
  try {
    const parsed = JSON.parse(nip44.decrypt(event.content, selfKey(key))) as MintBackupPayload
    if (parsed?.v !== 1 || !Array.isArray(parsed.mints)) return null
    // Everything below arrives from a relay. It is signed by a key only
    // this seed can make, so it is ours - but "ours" is not "well formed",
    // and a corrupt or truncated payload must not become a mint entry.
    const mints = parsed.mints.filter(
      (mint): mint is MintBackupPayload['mints'][number] =>
        Boolean(mint) &&
        typeof mint.host === 'string' &&
        typeof mint.payUrl === 'string' &&
        typeof mint.input === 'string'
    )
    const pins: Record<string, string> = {}
    for (const [host, pubkey] of Object.entries(parsed.pins ?? {})) {
      if (typeof pubkey === 'string' && /^0[23][0-9a-f]{64}$/i.test(pubkey)) pins[host] = pubkey
    }
    return {
      v: 1,
      mints,
      pins,
      ...(typeof parsed.defaultMintHost === 'string' ? {defaultMintHost: parsed.defaultMintHost} : {}),
      updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : 0
    }
  } catch {
    return null
  }
}

export const publishMintBackup = async (
  transport: NostrTransport,
  relays: string[],
  key: MintBackupKey,
  payload: MintBackupPayload
): Promise<{ok: string[]; failed: string[]}> =>
  transport.publish(relays.length > 0 ? relays : BOOTSTRAP_RELAYS, encodeMintBackup(key, payload))

export const fetchMintBackup = async (
  transport: NostrTransport,
  relays: string[],
  key: MintBackupKey
): Promise<MintBackupPayload | null> => {
  const filter: Filter = {
    kinds: [MINT_BACKUP_KIND],
    authors: [key.pubkey],
    '#d': [MINT_BACKUP_D_TAG]
  }
  const events = await transport.query(relays.length > 0 ? relays : BOOTSTRAP_RELAYS, filter)
  // Newest wins. Relays are asked in parallel and a slow one may still be
  // holding a version this wallet replaced weeks ago.
  const newest = events
    .filter(event => event.pubkey === key.pubkey)
    .sort((a, b) => b.created_at - a.created_at)[0]
  return newest ? decodeMintBackup(key, newest) : null
}

// The seed as bytes, from however the wallet is storing it.
export const seedBytes = (seedHex: string): Uint8Array => hexToBytes(seedHex)
export const seedHexOf = (seed: Uint8Array): string => bytesToHex(seed)
