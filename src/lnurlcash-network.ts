import * as kit from '@lnurlcash/kit'
import {bytesToHex} from '@noble/hashes/utils.js'
import {defaultRandomSecret, type RandomSecret} from './lnurlcash-policy.js'
import {ProtocolError} from './lnurlcash-errors.js'
import {bearerHashOfLeaf, bearerSpendOf, checkLeaf, decodeCw1, isLegacyCertificate} from './spend.ts'

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
    fetchImpl(String(url), {
      method,
      signal: options.timeoutMs === undefined ? signal : AbortSignal.timeout(options.timeoutMs)
    })
  )
  kit.configureSecretProvider(() => (options.randomSecret ?? defaultRandomSecret)())
}

// ---- every mint generation at once ----
//
// LUD-25 renamed its wire forms on 29 Sep 2026: a bearer note's lookup went
// from `?k1=` (or `?h=`) to `?p=<cp1>`, a mutation's outputs from `h`/`h2` to
// `p1`/`p2`, and a mint quote came to be named by `comment` alone. The kit
// speaks only the new forms. Mints did not all move at once: dni's
// lnurl-mint and moneyer before 0.12 read none of `p`, `p1` or `p2`. They
// look a note up by `k1` (some by `h` as well), read only `h`/`h2` on the
// callback, take a quote's name as a 64-hex `comment` or as `h` (the oldest
// moneyer only as `h`), and certify with `sig` over h. A wallet that speaks
// only the new forms cannot touch a note at any of them.
//
// So a bearer note goes on the wire in forms every generation reads, and
// nothing here waits for a refusal to try another:
//
//   - lookup: the note's own `?k1=`, which every mint has always answered
//     (a current one checks the spend in full);
//   - rotate/split/merge: each output's 64-hex hash under both names,
//     `p1` and `h` (`p2` and `h2`). An old mint reads `h` and ignores `p1`;
//     a current one reads either and requires the two to agree;
//   - mint quote: the hash as `comment` and again as `h`;
//   - melt: `k1` and `pr` only, as it always was.
//
// The rule, should a form ever have to be retried in another shape: a
// lookup changes nothing and may be asked again in any form, but a mutation
// is retried in another shape only on an answer that proves the mint
// refused it before touching any note (a validation refusal such as
// "missing h"), never after a lost or ambiguous answer, which reconcile
// owns. Nothing below needs that today.
//
// Key-path and script-path notes (ck1, cw1) exist only at current mints and
// stay on the kit's own forms.

const HEX64 = /^[0-9a-f]{64}$/i

// One GET to a mint, read as an LNURL response through the kit's own
// bounded, redirect-checked transport (and so this wallet's fetch, timeout
// and offline switch). A refusal is classified into the kit's spent, unknown
// and pending errors; an answer that never arrived is an AmbiguousMintError.
const mintGet = async (url: URL): Promise<Record<string, unknown>> => {
  let body: unknown
  try {
    body = await kit.lnurlFetch(url)
  } catch (error) {
    if (error instanceof kit.ServiceError && error.reason === 'pending') throw new kit.PendingNoteError()
    if (error instanceof kit.AmbiguousMintError || !(error instanceof Error)) throw error
    throw kit.classifyNoteError(error)
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new kit.AmbiguousMintError('Service returned an invalid response.')
  }
  return body as Record<string, unknown>
}

// A lookup by the note's own spend, `?k1=`, with whatever certificate or
// amount the URL carried left behind. A mint that echoes a spend must echo
// this one.
const lookupBySpend = async (
  url: string,
  k1: string,
  options: LnurlcashOptions
): Promise<kit.WithdrawRequestInfo & WithdrawInfoExtensions> => {
  const lookup = new URL(url)
  lookup.searchParams.delete('amount')
  lookup.searchParams.delete('sig')
  lookup.searchParams.delete('c')
  lookup.searchParams.set('k1', k1)
  const body = await mintGet(lookup)
  const max = body.maxWithdrawable
  const min = body.minWithdrawable
  if (
    body.tag !== 'withdrawRequest' ||
    typeof body.callback !== 'string' ||
    typeof max !== 'number' ||
    !Number.isFinite(max) ||
    max < 0 ||
    (min !== undefined && (typeof min !== 'number' || !Number.isFinite(min) || min < 0 || min > max))
  ) throw new ProtocolError('Not a withdrawRequest (unexpected response).')
  if (body.k1 !== undefined && (typeof body.k1 !== 'string' || body.k1.trim().toLowerCase() !== k1.toLowerCase())) {
    throw new ProtocolError('Service echoed back a different k1 than queried.')
  }
  const {c: rawCertificate, mintPubkey: _rawMintPubkey, ...rest} = body
  let mintPubkey: string | undefined
  try {
    mintPubkey = kit.parseMintKey(body).mintPubkey
  } catch (error) {
    // receive() deliberately accepts a mint with no signing key of its own.
    if (options.requireMintPubkey !== false) throw error
  }
  const c = typeof rawCertificate === 'string' && kit.isCs1WithAmount(rawCertificate) ? rawCertificate.trim() : undefined
  return {
    ...rest,
    ...(mintPubkey ? {mintPubkey} : {}),
    ...(c ? {c} : {}),
    k1
  } as kit.WithdrawRequestInfo & WithdrawInfoExtensions
}

// What a mutation's answer certifies an output with: the current `c`
// (`c2`) as a cs1<amount>, or, from a mint that predates it, its `sig`
// (`sig2`) - 65 bytes over the output's h, as hex or the fixed-HRP cs1. The
// older shape is kept as the mint sent it and judged later, by the rule it
// was made under (verifyNoteCertificate); it is never read for a cp1 output,
// which no such mint ever made.
const outputCertificate = (
  body: Record<string, unknown>,
  current: 'c' | 'c2',
  legacy: 'sig' | 'sig2'
): string | undefined => {
  const named = body[current]
  if (typeof named === 'string' && kit.isCs1WithAmount(named)) return named.trim()
  const old = body[legacy]
  if (typeof old === 'string' && isLegacyCertificate(old)) return old.trim()
  return undefined
}

// A rotate, split or merge into bearer outputs, every output named under
// both of its names. Errors are classified as the kit classifies its own:
// a refusal is definitive, anything short of a confirmed OK is ambiguous.
const mutateToHashes = async (
  callback: string,
  k1s: string[],
  outputs: {h: string; h2?: string; amountMsat?: number}
): Promise<Record<string, unknown>> => {
  if (k1s.length === 0 || k1s.some(k1 => k1.trim() === '')) {
    throw new Error(
      'This note has no secret in the browser. If it is marked "on device", reconnect the vault before refreshing or spending it.'
    )
  }
  let url: URL
  try {
    url = new URL(callback)
  } catch {
    throw new Error('The service provided an invalid callback URL.')
  }
  for (const k1 of k1s) url.searchParams.append('k1', k1)
  if (outputs.amountMsat !== undefined) url.searchParams.append('amount', String(outputs.amountMsat))
  const h = outputs.h.trim().toLowerCase()
  url.searchParams.append('p1', h)
  url.searchParams.append('h', h)
  if (outputs.h2 !== undefined) {
    const h2 = outputs.h2.trim().toLowerCase()
    url.searchParams.append('p2', h2)
    url.searchParams.append('h2', h2)
  }
  const body = await mintGet(url)
  if (body.status !== 'OK') throw new kit.AmbiguousMintError('Operation was not confirmed by the service.')
  return body
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

// The kit reads a name's branch from LUD-25's `text/cpub` (its index counts
// the Lightning Address purpose) into `internalTransfer`.
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

// A ck1 or a cw1 names its note by Q, so it is looked up by the note rather
// than by the spend. A cw1 is checked here first wherever this wallet can
// judge it, because the lookup alone only says Q is outstanding, not that
// this spend opens it. A ck1 is only decoded: whether it signs for this mint
// is judged where a note comes in (checkSpendOffline, from receive), so a
// note already held whose ck1 the kit no longer verifies - one signed over
// the old fixed message, which a mint may still honour - can still be asked
// after, and spent, rather than failing every check of its mint.
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
  const outputKey = kit.ck1Pubkey(k1)
  if (outputKey) {
    const info = await kit.fetchNoteInfoByPubkey(lookup.toString(), kit.encodeCp1(outputKey))
    return {...info, k1} as kit.WithdrawRequestInfo & WithdrawInfoExtensions
  }
  const cw1 = decodeCw1(k1)
  if (!cw1) throw new ProtocolError('That k1 is not a spend of any note.')
  const leafProblem = checkLeaf(cw1.script, cw1.controlBlock)
  if (leafProblem) throw new ProtocolError(`This cw1 can never be spent: ${leafProblem}.`)
  const bearer = bearerSpendOf(cw1)
  if (bearer) {
    // The bearer note its preimage names is asked after through its h,
    // which the kit sends as the note's cp1; a hashlock under any other tree
    // is asked after by its Q directly.
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

// A lookup by a bearer note's h (sent as its cp1), tolerating the mint with
// no signing key that receive() deliberately accepts.
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
    lookup.searchParams.set('p', kit.noteRef(hash))
    const body = await serviceJson(lookup.toString(), options)
    if (
      body.tag !== 'withdrawRequest' ||
      typeof body.callback !== 'string' ||
      typeof body.maxWithdrawable !== 'number'
    ) throw error
    return body as kit.HashWithdrawRequestInfo & WithdrawInfoExtensions
  }
}

// A ck1 or cw1 goes through fetchSpendInfo; a bearer preimage is asked
// after by itself, `?k1=`, the lookup every mint generation answers.
export const fetchNoteInfo = async (
  url: string,
  options: LnurlcashOptions = {}
): Promise<kit.WithdrawRequestInfo & WithdrawInfoExtensions> => {
  configure(options)
  const queried = kit.requireNoteK1(url)
  if (!kit.isPreimage(queried)) return fetchSpendInfo(url, queried, options)
  return lookupBySpend(url, queried.trim().toLowerCase(), options)
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
  configure(options)
  const k1 = kit.noteK1(url)
  if (!k1) throw new ProtocolError('That note URL carries no k1.')
  const info = await lookupBySpend(url, k1, {...options, requireMintPubkey: false})
  return {...info, tag: 'withdrawRequest', callback: info.callback, k1, maxWithdrawable: info.maxWithdrawable}
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

// A bearer output (64-hex h) is named under both of its names, so every
// mint generation reads it; a cp1 output, which only a current mint can
// make, goes through the kit unchanged.
export const rotateNoteWithHash = async (
  callback: string,
  k1: string,
  hash: string,
  options: LnurlcashOptions = {}
): Promise<CompatibleHashedMutationResult> => {
  configure(options)
  if (HEX64.test(hash.trim())) {
    const body = await mutateToHashes(callback, [k1], {h: hash})
    const signature = outputCertificate(body, 'c', 'sig')
    return signature === undefined ? {} : {signature}
  }
  try {
    return await kit.rotateNoteWithHash(callback, k1, hash)
  } catch (error) {
    if (
      options.requireSignatures === false &&
      error instanceof kit.AmbiguousMintError &&
      /confirmed the mutation without a valid c certificate/.test(error.message)
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
  if (HEX64.test(hash.trim()) && HEX64.test(changeHash.trim())) {
    const body = await mutateToHashes(callback, k1s, {h: hash, h2: changeHash, amountMsat})
    const signature = outputCertificate(body, 'c', 'sig')
    const changeSignature = outputCertificate(body, 'c2', 'sig2')
    return {
      ...(signature === undefined ? {} : {signature}),
      ...(changeSignature === undefined ? {} : {changeSignature})
    }
  }
  try {
    return await kit.splitNoteWithHash(callback, k1s, amountMsat, hash, changeHash)
  } catch (error) {
    if (
      options.requireSignatures === false &&
      error instanceof kit.AmbiguousMintError &&
      /confirmed the mutation without a valid c2? certificate/.test(error.message)
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
  if (HEX64.test(hash.trim())) {
    const body = await mutateToHashes(callback, k1s, {h: hash})
    const signature = outputCertificate(body, 'c', 'sig')
    return signature === undefined ? {} : {signature}
  }
  try {
    return await kit.mergeNotesWithHash(callback, k1s, hash)
  } catch (error) {
    if (
      options.requireSignatures === false &&
      error instanceof kit.AmbiguousMintError &&
      /confirmed the mutation without a valid c certificate/.test(error.message)
    ) return {}
    throw error
  }
}

// A quote for a bearer note names it by its 64-hex h as `comment` (what a
// current mint and lnurl-mint read, the latter in no other shape) and again
// as `h` (all an older moneyer reads; without it, it would mint to the
// payment preimage instead). A current mint takes both and requires them to
// agree. The kit's short form sets `comment`; `h` rides on the callback it
// is handed. A cp1 goes through the kit unchanged.
const quote = async (callback: string, amountMsat: number, outputHash: string | undefined) => {
  if (outputHash === undefined || !HEX64.test(outputHash.trim())) return kit.requestInvoice(callback, amountMsat, outputHash)
  const named = new URL(callback)
  named.searchParams.set('h', outputHash.trim().toLowerCase())
  return kit.requestInvoiceShort(named.toString(), amountMsat, outputHash)
}

export const requestInvoice = async (
  callback: string,
  amountMsat: number,
  options: LnurlcashOptions | string = {}
) => {
  if (typeof options === 'string') {
    configure()
    return quote(callback, amountMsat, options)
  }
  configure(options)
  return quote(callback, amountMsat, options.h)
}
