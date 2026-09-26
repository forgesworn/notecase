import * as kit from '@lnurlcash/kit'
import {bytesToHex} from '@noble/hashes/utils.js'
import {defaultRandomSecret, type RandomSecret} from './lnurlcash-policy.js'
import {ProtocolError} from './lnurlcash-errors.js'
import {bearerHashOfLeaf, bearerSpendOf, checkLeaf, decodeCw1, spendDomainOf, verifyCk1} from './spend.ts'

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

// LUD-25 renamed a certificate from `sig`/`sig2` to `c`/`c2`, and the pinned
// kit reads only the old names. A mint that sends only the new ones has its
// answer given the old names as well, so a certificate it issued is checked
// rather than read as missing, which the kit would take for a mint that may
// or may not have done what it was asked.
export const withLegacyCertificateNames = <T>(body: T): T => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body
  const fields = body as Record<string, unknown>
  const renamed = {...fields}
  if (typeof fields.c === 'string' && fields.sig === undefined) renamed.sig = fields.c
  if (typeof fields.c2 === 'string' && fields.sig2 === undefined) renamed.sig2 = fields.c2
  return renamed as T
}

const withLegacyCertificateResponse = async (response: Response): Promise<Response> => {
  if (!(response.headers.get('content-type') ?? '').includes('json')) return response
  const text = await response.text()
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return new Response(text, {status: response.status, statusText: response.statusText, headers: response.headers})
  }
  return new Response(JSON.stringify(withLegacyCertificateNames(body)), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers
  })
}

// LUD-25 names every output `p1`/`p2`, and a lookup `p`, whether it is a
// cp1 or a bearer note's 64-hex h; the pinned kit still sends a bearer h as
// `h`/`h2`, and looks one up by `h`. The reference mint no longer reads
// those, so the spec's names go out alongside them with the same value: an
// older mint reading only `h` is none the wiser. An invoice request is left
// alone, since its `comment` already names the note.
export const withSpecOutputNames = (url: string): string => {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return url
  }
  const params = parsed.searchParams
  if (params.has('comment')) return url
  const pairs: Array<[string, string]> = params.has('k1') ? [['h', 'p1'], ['h2', 'p2']] : [['h', 'p']]
  let changed = false
  for (const [legacy, current] of pairs) {
    const value = params.get(legacy)
    if (value !== null && !params.has(current)) {
      params.set(current, value)
      changed = true
    }
  }
  return changed ? parsed.toString() : url
}

const configure = (options: LnurlcashOptions = {}): void => {
  kit.configureNetworkGuard(() => {
    if (options.offline) throw new Error('Offline mode is on.')
  })
  const fetchImpl = options.fetch ?? globalThis.fetch
  kit.configureTransport(async (url, signal, method) =>
    withLegacyCertificateResponse(
      await fetchImpl(withSpecOutputNames(String(url)), {
        method,
        signal: options.timeoutMs === undefined ? signal : AbortSignal.timeout(options.timeoutMs)
      })
    )
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
  const body = withLegacyCertificateNames(await response.json().catch(() => {
    throw new kit.AmbiguousMintError('Service returned an invalid response.')
  }) as Record<string, unknown>)
  if (body.status === 'ERROR') {
    throw kit.classifyNoteError(new kit.ServiceError(typeof body.reason === 'string' ? body.reason : ''))
  }
  return body
}

// A name's branch as its payRequest publishes it: LUD-25's `text/cpub`, whose
// index counts the Lightning Address purpose, or failing that the older
// `text/xpub` the kit reads, whose index counts the ladder from before
// purposes. This wallet reads only the branch from either.
const cpubHint = (metadata: unknown): {cx1: {pubkeyXOnly: Uint8Array; chainCode: Uint8Array}; startIndex: number} | null => {
  if (typeof metadata !== 'string') return null
  let entries: unknown
  try {
    entries = JSON.parse(metadata)
  } catch {
    return null
  }
  if (!Array.isArray(entries)) return null
  for (const entry of entries) {
    if (!Array.isArray(entry) || entry[0] !== 'text/cpub' || typeof entry[1] !== 'string') continue
    const sep = entry[1].lastIndexOf(':')
    if (sep < 0) continue
    const cx1 = kit.decodeCx1(entry[1].slice(0, sep))
    const startIndex = Number(entry[1].slice(sep + 1))
    if (cx1 && Number.isInteger(startIndex) && startIndex >= 0) return {cx1, startIndex}
  }
  return null
}

export const fetchPayRequest = async (url: string, options: LnurlcashOptions = {}) => {
  configure(options)
  const pay = await kit.fetchPayRequest(url)
  const cpub = cpubHint((pay as {metadata?: unknown}).metadata)
  return cpub ? {...pay, internalTransfer: cpub} : pay
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

// A ck1 or a cw1 names its note by Q, so it is looked up by the note rather
// than by the spend, as a preimage is looked up by its hash. The spend is
// checked here first wherever this wallet can judge it, because the lookup
// alone only says Q is outstanding, not that this spend opens it.
const fetchSpendInfo = async (
  url: string,
  k1: string,
  options: LnurlcashOptions
): Promise<kit.WithdrawRequestInfo & WithdrawInfoExtensions> => {
  const lookup = new URL(url)
  lookup.searchParams.delete('k1')
  lookup.searchParams.delete('amount')
  lookup.searchParams.delete('sig')
  lookup.searchParams.delete('c')
  if (kit.isCk1(k1)) {
    // Signed over this mint's own sighash, or one of the deprecated fixed
    // messages a mint still reads. A ck1 bound to another mint opens nothing
    // here, and saying so now beats storing it as money.
    const opened = verifyCk1(k1, url)
    if (!opened) throw new ProtocolError(`This note's ck1 does not sign for it at ${spendDomainOf(url)}.`)
    const info = await kit.fetchNoteInfoByPubkey(lookup.toString(), kit.encodeCp1(opened.outputKey))
    return {...info, k1} as kit.WithdrawRequestInfo & WithdrawInfoExtensions
  }
  const cw1 = decodeCw1(k1)
  if (!cw1) throw new ProtocolError('That k1 is not a spend of any note.')
  const leafProblem = checkLeaf(cw1.script, cw1.controlBlock)
  if (leafProblem) throw new ProtocolError(`This cw1 can never be spent: ${leafProblem}.`)
  const bearer = bearerSpendOf(cw1)
  if (bearer) {
    // The bearer note its preimage names is asked after by h, which a mint
    // from before notes were keyed by Q still files it under; a hashlock
    // under any other tree has only its Q.
    const info = bearer.canonical
      ? await lookupByHash(lookup.toString(), bytesToHex(bearer.h), options)
      : await kit.fetchNoteInfoByPubkey(lookup.toString(), kit.encodeCp1(cw1.outputKey))
    return {...info, k1} as kit.WithdrawRequestInfo & WithdrawInfoExtensions
  }
  if (bearerHashOfLeaf(cw1.script)) throw new ProtocolError('This cw1 carries a witness that does not open its hashlock.')
  // Any other script needs an interpreter this wallet does not carry, so the
  // mint is asked to judge the spend itself: LUD-25 has it verify a spend in
  // full before answering the GET. It sees nothing it would not see at the
  // callback, which is where this spend is going next.
  const raw = new URL(url)
  raw.searchParams.delete('sig')
  raw.searchParams.delete('c')
  const body = await serviceJson(raw.toString(), options)
  if (
    body.tag !== 'withdrawRequest' ||
    typeof body.callback !== 'string' ||
    typeof body.maxWithdrawable !== 'number'
  ) throw new ProtocolError('Not a withdrawRequest (unexpected response).')
  if (typeof body.k1 !== 'string' || body.k1.toLowerCase() !== k1.toLowerCase()) {
    throw new ProtocolError('Service echoed back a different k1 than queried.')
  }
  const mintPubkey = typeof body.mintPubkey === 'string' && kit.MINT_PUBKEY_PATTERN.test(body.mintPubkey)
    ? body.mintPubkey.toLowerCase()
    : undefined
  if (!mintPubkey && options.requireMintPubkey !== false) {
    throw new Error('SERVICE did not publish a valid persistent signing key (mintPubkey).')
  }
  return {
    ...body,
    ...(mintPubkey ? {mintPubkey} : {}),
    k1
  } as kit.WithdrawRequestInfo & WithdrawInfoExtensions
}

// A lookup by h, tolerating the mint with no signing key that receive()
// deliberately accepts.
const lookupByHash = async (
  url: string,
  hash: string,
  options: LnurlcashOptions
): Promise<kit.HashWithdrawRequestInfo & WithdrawInfoExtensions> => {
  try {
    return await kit.fetchNoteInfoByHash(url, hash) as kit.HashWithdrawRequestInfo & WithdrawInfoExtensions
  } catch (error) {
    if (options.requireMintPubkey !== false || !(error instanceof Error) || !/mintPubkey/.test(error.message)) throw error
    const lookup = new URL(url)
    lookup.searchParams.set('h', hash)
    const body = await serviceJson(lookup.toString(), options)
    if (
      body.tag !== 'withdrawRequest' ||
      typeof body.callback !== 'string' ||
      typeof body.maxWithdrawable !== 'number'
    ) throw error
    return body as kit.HashWithdrawRequestInfo & WithdrawInfoExtensions
  }
}

export const fetchNoteInfo = async (
  url: string,
  options: LnurlcashOptions = {}
): Promise<kit.WithdrawRequestInfo & WithdrawInfoExtensions> => {
  configure(options)
  const queried = kit.noteK1(url)
  if (queried && !kit.isPreimage(queried)) return fetchSpendInfo(url, queried, options)
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
    lookup.searchParams.delete('c')
    lookup.searchParams.set('h', kit.hashK1(k1))
    const body = await serviceJson(withSpecOutputNames(lookup.toString()), options)
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

// The kit's probe, over this wallet's own lookup, so a ck1 signed for its
// mint's sighash or a cw1 is asked after the same way a preimage is.
export const probeBurnedNote = async (
  url: string,
  options: LnurlcashOptions = {}
): Promise<'live' | 'gone' | 'unknown'> => {
  try {
    await fetchNoteInfo(url, options)
    return 'live'
  } catch (err) {
    if (err instanceof kit.NoteSpentError || err instanceof kit.NoteUnknownError) return 'gone'
    return 'unknown'
  }
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
