import * as kit from '@lnurlcash/kit'
import {defaultRandomSecret, type RandomSecret} from './lnurlcash-policy.js'
import {ProtocolError} from './lnurlcash-errors.js'

// Compatibility at the Notecase boundary only. The reference kit now uses
// process-wide hooks; Wallet still carries these settings so tests, Tor and
// offline mode remain injectable without leaking that policy into the kit.
export type LnurlcashOptions = {
  fetch?: typeof globalThis.fetch
  timeoutMs?: number
  offline?: boolean
  randomSecret?: RandomSecret
  requireSignatures?: boolean
  requireMintPubkey?: boolean
  retryMutations?: number
  mutationRetries?: number
  h?: string
}

const configure = (options: LnurlcashOptions = {}): void => {
  kit.configureNetworkGuard(() => {
    if (options.offline) throw new Error('Offline mode is on.')
  })
  const fetchImpl = options.fetch ?? globalThis.fetch
  kit.configureTransport((url, signal, method) =>
    fetchImpl(url, {
      method,
      signal: options.timeoutMs === undefined ? signal : AbortSignal.timeout(options.timeoutMs)
    })
  )
  kit.configureSecretProvider(() => (options.randomSecret ?? defaultRandomSecret)())
}

const serviceJson = async (url: string, options: LnurlcashOptions): Promise<Record<string, unknown>> => {
  if (options.offline) throw new Error('Offline mode is on.')
  if (!kit.isAllowedServiceUrl(url)) throw new Error('The service provided a URL this wallet will not fetch.')
  const fetchImpl = options.fetch ?? globalThis.fetch
  let response: Response
  try {
    response = await fetchImpl(url, {signal: AbortSignal.timeout(options.timeoutMs ?? 30_000)})
  } catch {
    throw new kit.AmbiguousMintError('Failed to reach the service - it may be offline or not allow cross-origin requests.')
  }
  const body = await response.json().catch(() => {
    throw new kit.AmbiguousMintError('Service returned an invalid response.')
  }) as Record<string, unknown>
  if (body.status === 'ERROR') {
    throw kit.classifyNoteError(new kit.ServiceError(typeof body.reason === 'string' ? body.reason : ''))
  }
  return body
}

export const fetchPayRequest = async (url: string, options: LnurlcashOptions = {}) => {
  configure(options)
  return kit.fetchPayRequest(url)
}

export type MintAddressExtensions = {
  name?: string
  description?: string
  contact?: {nostr?: string; email?: string; url?: string}
  tosUrl?: string
  motd?: string
  version?: string
  nodeUris?: string[]
  fees?: kit.MintFee
}

export const fetchMintAddress = async (
  url: string,
  options: LnurlcashOptions = {}
): Promise<kit.MintAddressInfo & MintAddressExtensions> => {
  configure(options)
  const body = await kit.fetchMintAddress(url) as kit.MintAddressInfo & MintAddressExtensions
  if (body.sunsetDate !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(body.sunsetDate)) {
    delete body.sunsetDate
  }
  return body
}

export type WithdrawInfoExtensions = {payLink?: string}

export const fetchNoteInfo = async (
  url: string,
  options: LnurlcashOptions = {}
): Promise<kit.WithdrawRequestInfo & WithdrawInfoExtensions> => {
  configure(options)
  try {
    return await kit.fetchNoteInfo(url) as kit.WithdrawRequestInfo & WithdrawInfoExtensions
  } catch (error) {
    if (error instanceof Error && /returned k1 in a hash-only lookup response|unexpected response/.test(error.message)) {
      throw new ProtocolError(error.message)
    }
    if (
      options.requireMintPubkey !== false ||
      !(error instanceof Error) ||
      !/mintPubkey/.test(error.message)
    ) throw error
    const k1 = kit.noteK1(url)
    if (!k1 || !kit.isPreimage(k1)) throw error
    const lookup = new URL(url)
    lookup.searchParams.delete('k1')
    lookup.searchParams.delete('amount')
    lookup.searchParams.delete('sig')
    lookup.searchParams.set('h', kit.hashK1(k1))
    const body = await serviceJson(lookup.toString(), options)
    if (
      body.tag !== 'withdrawRequest' ||
      typeof body.callback !== 'string' ||
      typeof body.maxWithdrawable !== 'number'
    ) throw error
    return {...body, k1} as kit.WithdrawRequestInfo & WithdrawInfoExtensions
  }
}

export type DisclosedWithdrawInfo = {
  tag: 'withdrawRequest'
  callback: string
  k1: string
  maxWithdrawable: number
  minWithdrawable?: number
}

// Recovery calls this only after the holder has explicitly authorised raw
// secret disclosure. Keeping it separate ensures ordinary receive never
// downgrades a secret-free lookup merely because an unknown note was returned.
export const fetchNoteInfoDisclosingK1 = async (
  url: string,
  options: LnurlcashOptions = {}
): Promise<DisclosedWithdrawInfo> => {
  const k1 = kit.noteK1(url)
  if (!k1) throw new ProtocolError('That note URL carries no k1.')
  const body = await serviceJson(url, options)
  if (
    body.tag !== 'withdrawRequest' ||
    typeof body.callback !== 'string' ||
    typeof body.maxWithdrawable !== 'number'
  ) throw new ProtocolError('Not a withdrawRequest (unexpected response).')
  if (typeof body.k1 !== 'string' || body.k1.toLowerCase() !== k1.toLowerCase()) {
    throw new ProtocolError('Service echoed back a different k1 than queried.')
  }
  return {...body, tag: 'withdrawRequest', callback: body.callback, k1, maxWithdrawable: body.maxWithdrawable}
}

export const fetchNoteInfoByHash = async (
  url: string,
  hash: string,
  options: LnurlcashOptions = {}
): Promise<kit.HashWithdrawRequestInfo & WithdrawInfoExtensions> => {
  configure(options)
  return kit.fetchNoteInfoByHash(url, hash) as Promise<kit.HashWithdrawRequestInfo & WithdrawInfoExtensions>
}

export const fetchNoteInfoByPubkey = async (
  url: string,
  cp1: string,
  options: LnurlcashOptions = {}
): Promise<kit.HashWithdrawRequestInfo & WithdrawInfoExtensions> => {
  configure(options)
  return kit.fetchNoteInfoByPubkey(url, cp1) as Promise<kit.HashWithdrawRequestInfo & WithdrawInfoExtensions>
}

export const fetchInvoiceVerification = async (url: string, options: LnurlcashOptions = {}) => {
  configure(options)
  return kit.fetchInvoiceVerification(url)
}

export const probeBurnedNote = async (url: string, options: LnurlcashOptions = {}) => {
  configure(options)
  return kit.probeBurnedNote(url)
}

export const meltNote = async (
  callback: string,
  k1: string,
  invoice: string,
  options: LnurlcashOptions = {}
) => {
  configure(options)
  return kit.meltNote(callback, k1, invoice)
}

// A reference mint without a signing key can confirm a legacy hash mutation
// without returning a certificate. The published kit deliberately rejects
// that as ambiguous; Notecase keeps the staged output and reconciles it, so its
// boundary type must honestly represent the absent certificate.
export type CompatibleHashedMutationResult = {signature?: string}
export type CompatibleHashedSplitResult = {signature?: string; changeSignature?: string}

export const rotateNoteWithHash = async (
  callback: string,
  k1: string,
  hash: string,
  options: LnurlcashOptions = {}
): Promise<CompatibleHashedMutationResult> => {
  configure(options)
  try {
    return await kit.rotateNoteWithHash(callback, k1, hash)
  } catch (error) {
    if (
      options.requireSignatures === false &&
      error instanceof kit.AmbiguousMintError &&
      /confirmed the mutation without a valid sig signature/.test(error.message)
    ) return {}
    throw error
  }
}

export const splitNoteWithHash = async (
  callback: string,
  k1s: string[],
  amountMsat: number,
  hash: string,
  changeHash: string,
  options: LnurlcashOptions = {}
): Promise<CompatibleHashedSplitResult> => {
  configure(options)
  try {
    return await kit.splitNoteWithHash(callback, k1s, amountMsat, hash, changeHash)
  } catch (error) {
    if (
      options.requireSignatures === false &&
      error instanceof kit.AmbiguousMintError &&
      /confirmed the mutation without a valid (?:sig|sig2) signature/.test(error.message)
    ) return {}
    throw error
  }
}

export const mergeNotesWithHash = async (
  callback: string,
  k1s: string[],
  hash: string,
  options: LnurlcashOptions = {}
): Promise<CompatibleHashedMutationResult> => {
  configure(options)
  try {
    return await kit.mergeNotesWithHash(callback, k1s, hash)
  } catch (error) {
    if (
      options.requireSignatures === false &&
      error instanceof kit.AmbiguousMintError &&
      /confirmed the mutation without a valid sig signature/.test(error.message)
    ) return {}
    throw error
  }
}

export const requestInvoice = async (
  callback: string,
  amountMsat: number,
  options: LnurlcashOptions | string = {}
) => {
  if (typeof options === 'string') {
    configure()
    return kit.requestInvoice(callback, amountMsat, options)
  }
  configure(options)
  return kit.requestInvoice(callback, amountMsat, options.h)
}
