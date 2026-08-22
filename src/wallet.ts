import {
  AmbiguousMintError,
  NoteSpentError,
  NoteUnknownError,
  PendingNoteError,
  ServiceRejectedError,
  applyMintFee,
  mintFeeBand,
  buildNoteUrl,
  defaultRandomSecret,
  deriveNoteRoot,
  derivedSecretSource,
  fetchInvoiceVerification,
  fetchNoteInfo,
  fetchPayRequest,
  hashK1,
  meltNote,
  mergeNotesWithHash,
  noteDeclaredAmount,
  noteK1,
  noteSignature,
  probeBurnedNote,
  requestInvoice,
  resolveMintInput,
  resolveNoteInput,
  restoreNotes,
  rotateNoteWithHash,
  serverOf,
  splitNoteWithHash,
  fromLud17,
  lightningAddressUsername,
  mintAddressUrl,
  verifyNoteSignature,
  withNewK1,
  type LnurlcashOptions,
  type MintFee
} from 'lnurlcash-kit'
import {hexToBytes} from '@noble/hashes/utils.js'
import {tryDecodeBolt11} from 'farrier-kit/bolt11'
import {verifyPreimage} from 'farrier-kit/preimage'
import type {MeltRecord, MintEntry, NoteOrigin, NoteRecord, PendingMint, WalletData} from './types.ts'
import {
  BOOTSTRAP_RELAYS,
  NotANoteWrapError,
  fetchWraps,
  identityFromSecret,
  inboxRelayListEvent,
  inboxRelays,
  nip98Header,
  newIdentitySecretHex,
  resolveRecipient,
  unwrapNote,
  wrapNote,
  type NostrIdentity,
  type NostrTransport
} from './nostr.ts'
import {HeartwoodClient, HeartwoodError, newHeartwoodLink, type DeviceNote, type HeartwoodLink} from './heartwood.ts'

// The ordering rule this whole module is built around: a fresh secret is
// PERSISTED before its hash goes on the wire, and nothing is deleted until
// the service's answer proves what happened. A crash at any point leaves a
// record reconcile() can resolve; at no point is a disclosed secret held
// only in memory. That is what the kit's *WithHash variants exist for.

export class InsufficientFundsError extends Error {}
export class PinMismatchError extends Error {}
export class WalletUsageError extends Error {}

// A note whose offline signature does not verify against the key pinned
// for its mint. The signature is the one thing a holder can check without
// asking anyone, so a failure is a refusal, not a note in the margin: the
// amount may have been edited, or the note may not come from that mint at
// all. Overridable, deliberately and per receive.
export class BadSignatureError extends Error {}

export type ReceiveResult = {note: NoteRecord; warnings: string[]}

export type ReconcileEvent = {kind: string; detail: string}

// What a sweep of every note against its mint found. Nothing here is
// applied unless the caller asks for it.
export type CheckReport = {
  checked: number
  spent: NoteRecord[]
  unknown: NoteRecord[]
  pending: NoteRecord[]
  valueChanged: Array<{note: NoteRecord; amountMsat: number}>
  unreachable: string[]
  // Notes signed by a key their mint has since retired. Still good, and a
  // rotate re-signs them under the current key at no cost.
  staleSignature: NoteRecord[]
}

// How many notes at one mint are asked about at a time. Enough to make a
// sweep of a full case quick, few enough that no mint sees a burst.
const CHECK_CONCURRENCY = 4

// The offline cash drawer. LUD-25's whole offline story assumes the payer
// can hand over the right amount without touching the mint, and a wallet
// holding one big note cannot: a split needs the mint. So a wallet that
// expects to go offline keeps a ladder of small notes, like change in a
// pocket. Every split costs the mint's flat fee and every merge refunds
// one, so keeping a ladder is cheap - but it has to be deliberate.
export const DEFAULT_LADDER = [100, 500, 1000, 5000]
export const DEFAULT_LADDER_COPIES = 2

// What "prepare for offline" would do, and what it would cost.
export type LadderPlan = {
  mintHost: string
  // denominations to cut, in msat, largest first: one split each
  cut: number[]
  // the mint's flat fee times the number of splits
  feeMsat: number
  // denominations the drawer wants and cannot cut: nothing big enough
  short: number[]
}

// Notes that together pay an amount with no mint involved.
export type OfflineSelection = {
  mintHost: string
  notes: NoteRecord[]
  totalMsat: number
  // 0 when the notes make the amount exactly; otherwise what handing them
  // over would cost the payer over the asking price
  overpayMsat: number
  // the mint holds more notes than the search would look at
  capped: boolean
}

export type OfflineHandover = OfflineSelection & {urls: string[]}

// A subset-sum over bearer notes is a search, not a formula. Bounded on
// both sides: at most this many notes are looked at, and the walk gives up
// after this many steps and hands back the nearest it found above the
// asking price.
const OFFLINE_SUBSET_LIMIT = 64
const OFFLINE_SEARCH_STEPS = 200_000

const now = () => Date.now()

export class Wallet {
  readonly data: WalletData
  private readonly persist: () => Promise<void>
  private readonly opts: LnurlcashOptions

  constructor(data: WalletData, persist: () => Promise<void>, opts: LnurlcashOptions) {
    this.data = data
    this.persist = persist
    this.opts = opts
  }

  // ---- queries ----

  liveNotes(): NoteRecord[] {
    return this.data.notes.filter(note => note.state === 'live')
  }

  balanceMsat(): number {
    return this.liveNotes().reduce((sum, note) => sum + note.amountMsat, 0)
  }

  // Money that is here but not yet under a secret only this wallet knows:
  // notes taken offline on a signature, where the person who handed them
  // over still knows the k1. Real money, worth flagging until reconcile
  // has rotated it.
  unrotatedMsat(): number {
    return this.liveNotes()
      .filter(note => note.unrotated)
      .reduce((sum, note) => sum + note.amountMsat, 0)
  }

  balanceByMint(): Map<string, number> {
    const byMint = new Map<string, number>()
    for (const note of this.liveNotes()) {
      byMint.set(note.mintHost, (byMint.get(note.mintHost) ?? 0) + note.amountMsat)
    }
    return byMint
  }

  needsReconcile(): boolean {
    return (
      this.data.notes.some(
        note =>
          note.state === 'staged' ||
          note.state === 'ambiguous' ||
          note.state === 'melting' ||
          // taken offline and still under the giver's secret
          (note.state === 'live' && note.unrotated === true)
      ) ||
      this.data.pendingMints.some(
        pending => pending.state === 'awaiting' || (pending.state === 'claimed' && pending.preimageHex !== undefined)
      )
    )
  }

  noteById(id: string): NoteRecord | undefined {
    return this.data.notes.find(note => note.id === id)
  }

  // ---- mints directory ----

  async addMint(input: string, label?: string): Promise<MintEntry> {
    const payUrl = resolveMintInput(input)
    if (!payUrl) throw new WalletUsageError('That does not resolve to a mint - use a Lightning Address or LNURL.')
    const pay = await fetchPayRequest(payUrl, this.opts)
    if (!pay.withdrawLink) {
      throw new WalletUsageError('That service takes payments but does not mint LNURLcash notes.')
    }
    const host = serverOf(payUrl)
    const entry: MintEntry = {
      input,
      host,
      payUrl,
      baseUrl: fromLud17(pay.withdrawLink),
      ...(label ? {label} : {}),
      ...(pay.mintFee ? {mintFee: pay.mintFee} : {}),
      addedAt: now()
    }
    const existing = this.data.mints.findIndex(mint => mint.host === host)
    if (existing >= 0) this.data.mints[existing] = entry
    else this.data.mints.push(entry)
    this.data.settings.defaultMintHost ??= host
    await this.persist()
    return entry
  }

  mintEntry(host?: string): MintEntry {
    const wanted = host ?? this.data.settings.defaultMintHost
    if (!wanted) throw new WalletUsageError('No mint configured - run `notecase mints add <address>` first.')
    const entry = this.data.mints.find(mint => mint.host === wanted)
    if (!entry) throw new WalletUsageError(`No mint known for ${wanted}.`)
    return entry
  }

  async setDefaultMint(host: string): Promise<void> {
    if (!this.data.mints.some(mint => mint.host === host)) {
      throw new WalletUsageError(`No mint known for ${host}.`)
    }
    this.data.settings.defaultMintHost = host
    await this.persist()
  }

  // Forgetting a mint never forgets money: any note not fully spent keeps
  // the entry. The pubkey pin is deliberately kept too - if this mint is
  // ever added back, the old pin still vets it.
  async removeMint(host: string): Promise<void> {
    const holding = this.data.notes.some(note => note.mintHost === host && note.state !== 'spent')
    if (holding) {
      throw new WalletUsageError(`Notes still live at ${host} - spend, melt or reclaim them first.`)
    }
    if (this.data.pendingMints.some(pending => pending.mintHost === host && pending.state === 'awaiting')) {
      throw new WalletUsageError(`A mint invoice at ${host} is still awaiting payment - resolve it first.`)
    }
    this.data.mints = this.data.mints.filter(mint => mint.host !== host)
    if (this.data.settings.defaultMintHost === host) {
      const next = this.data.mints[0]?.host
      if (next) this.data.settings.defaultMintHost = next
      else delete this.data.settings.defaultMintHost
    }
    await this.persist()
  }

  // Keys this mint used to sign with and has since retired. Old notes stay
  // verifiable against them; nothing new is ever accepted on one.
  pubkeyHistoryFor(host: string): string[] {
    return this.data.pubkeyHistory?.[host] ?? []
  }

  // Whether a signature on a note from this mint checks out against any key
  // the wallet knows the mint to have used, and which one it was.
  private verifyAgainstKnownKeys(
    host: string,
    k1: string,
    amountMsat: number,
    signature: string
  ): {valid: boolean; historic: boolean} {
    const pinned = this.data.pubkeyPins[host]
    if (pinned && verifyNoteSignature(k1, amountMsat, signature, pinned)) return {valid: true, historic: false}
    for (const retired of this.pubkeyHistoryFor(host)) {
      if (verifyNoteSignature(k1, amountMsat, signature, retired)) return {valid: true, historic: true}
    }
    return {valid: false, historic: false}
  }

  // The mint's own discovery document, for the fields the client library
  // does not model yet.
  //
  // Two ways in. A mint in the directory has a pay URL to derive the
  // endpoint from. A mint known only from notes has none - and that is the
  // ordinary case for a bearer-note wallet - so the note's own `payLink`
  // is used instead. The kit only ever hands one back on the note's own
  // origin, so this cannot be pointed at a third party.
  private async discoveryDocument(
    host: string,
    payLink?: string | undefined
  ): Promise<{url: string; body: Record<string, unknown>} | null> {
    const entry = this.data.mints.find(mint => mint.host === host)
    const source = entry?.payUrl ?? payLink
    if (!source) return null
    const url = mintAddressUrl(source)
    if (!url) return null
    // Belt and braces over the kit's own check: whatever the note said, the
    // document that vouches for this host's keys has to be ON this host.
    if (serverOf(url) !== host) return null
    const fetchImpl = this.opts.fetch ?? fetch
    const response = await fetchImpl(url, {
      headers: {accept: 'application/json'},
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 30_000)
    })
    const body = (await response.json()) as Record<string, unknown>
    return {url, body: body ?? {}}
  }

  private async retiredKeysAt(host: string, payLink?: string | undefined): Promise<string[]> {
    try {
      const discovery = await this.discoveryDocument(host, payLink)
      const list = discovery?.body.previousPubkeys
      if (!Array.isArray(list)) return []
      return list
        .filter((value): value is string => typeof value === 'string' && /^0[23][0-9a-f]{64}$/i.test(value))
        .map(value => value.toLowerCase())
    } catch {
      // A mint that cannot be asked has said nothing, and silence is not
      // permission: the caller falls through to the mismatch.
      return []
    }
  }

  // Trust on first use, with one door in it.
  //
  // A changed key is either the mint rotating its own signing key or
  // something standing between the wallet and the mint - and from the note
  // alone those look identical. The door is that the MINT must already
  // have published the old key as retired on its own discovery endpoint.
  // That is not much of a proof, and it is not meant to be: whoever
  // controls the host controls the pin either way, which is TOFU's own
  // argument. What the history buys is that a mint doing the right thing -
  // rotating a key and saying so - stops looking exactly like an attack,
  // which is the thing that makes holders click through warnings.
  private async pinPubkey(
    host: string,
    observed: string | undefined,
    payLink?: string | undefined
  ): Promise<{rotated: boolean}> {
    if (!observed) return {rotated: false}
    const pinned = this.data.pubkeyPins[host]
    if (!pinned) {
      this.data.pubkeyPins[host] = observed
      return {rotated: false}
    }
    if (pinned === observed) return {rotated: false}
    const retired = await this.retiredKeysAt(host, payLink)
    if (!retired.includes(pinned.toLowerCase())) {
      throw new PinMismatchError(
        `${host} now presents mint pubkey ${observed.slice(0, 16)}… but was pinned to ${pinned.slice(0, 16)}…`
      )
    }
    this.data.pubkeyHistory ??= {}
    const history = this.data.pubkeyHistory[host] ?? []
    if (!history.includes(pinned)) history.push(pinned)
    this.data.pubkeyHistory[host] = history
    this.data.pubkeyPins[host] = observed
    const entry = this.data.mints.find(mint => mint.host === host)
    if (entry) {
      entry.keyRotatedAt = now()
      entry.keyRotationReported = false
    }
    return {rotated: true}
  }

  // ---- the staging engine ----

  private record(
    template: Pick<NoteRecord, 'baseUrl' | 'callback' | 'mintHost'>,
    k1: string,
    amountMsat: number,
    origin: NoteOrigin,
    replaces: string[]
  ): NoteRecord {
    return {
      id: hashK1(k1),
      k1,
      amountMsat,
      baseUrl: template.baseUrl,
      callback: template.callback,
      mintHost: template.mintHost,
      state: 'staged',
      origin,
      replaces,
      createdAt: now(),
      updatedAt: now()
    }
  }

  // ---- derived secrets ----

  // The root every note secret at every mint comes off. Absent only for a
  // wallet made before seeds existed, which keeps making random secrets
  // until its notes are adopted onto one.
  private noteRoot(): Uint8Array | null {
    const seed = this.data.seedHex
    return seed ? deriveNoteRoot(hexToBytes(seed)) : null
  }

  hasSeed(): boolean {
    return Boolean(this.data.seedHex)
  }

  counterFor(host: string): number {
    return this.data.counters?.[host] ?? 0
  }

  // Live notes this wallet cannot find again from the words: made before
  // the seed, or received and never rotated onto it.
  legacyNotes(): NoteRecord[] {
    return this.liveNotes().filter(note => note.index === undefined)
  }

  // One rotate each, which a mint charges nothing for, and every one of
  // them is on the seed afterwards. Safe to re-run: whatever succeeded is
  // no longer legacy.
  async adoptLegacyNotes(): Promise<{adopted: NoteRecord[]; failed: Array<{note: NoteRecord; reason: string}>}> {
    const adopted: NoteRecord[] = []
    const failed: Array<{note: NoteRecord; reason: string}> = []
    for (const note of this.legacyNotes()) {
      if (!note.callback) {
        failed.push({note, reason: 'it has not met its mint yet - reconcile first'})
        continue
      }
      try {
        adopted.push(await this.rotateLive(note))
      } catch (err) {
        failed.push({note, reason: (err as Error).message})
      }
    }
    return {adopted, failed}
  }

  private touch(note: NoteRecord, state: NoteRecord['state']): void {
    note.state = state
    note.updatedAt = now()
  }

  private async mutate(
    inputs: NoteRecord[],
    plan: {kind: 'rotate'} | {kind: 'merge'} | {kind: 'split'; amountMsat: number}
  ): Promise<NoteRecord[]> {
    const totalMsat = inputs.reduce((sum, note) => sum + note.amountMsat, 0)
    const template = inputs[0]!
    const inputIds = inputs.map(note => note.id)
    const origin: NoteOrigin = plan.kind === 'rotate' ? 'rotate' : plan.kind
    // Whether every input was spendable when this request went out. It
    // decides how an "already spent" refusal is read below: against a live
    // input that answer is also what a landed mutation looks like on a
    // retry, while against a melting one it is the melt machinery's own
    // answer and means exactly what it says.
    const inputsWereLive = inputs.every(note => note.state === 'live')

    // LUD-25 fee algebra, priced from the cached advertisement: the flat
    // base fee comes out of a split's CHANGE (never the requested amount),
    // and a merge of n notes refunds (n - 1) of it. A mint we never
    // fetched a payRequest from has an unknown fee: price fee-free and
    // correct against the mint's authoritative answer afterwards.
    const entry = this.data.mints.find(mint => mint.host === template.mintHost)
    const feeKnown = entry !== undefined
    const baseFeeMsat = entry?.mintFee?.baseFeeMsat ?? 0
    const changeMsat = plan.kind === 'split' ? totalMsat - plan.amountMsat - baseFeeMsat : 0
    if (plan.kind === 'split' && feeKnown && changeMsat < 1) {
      throw new InsufficientFundsError(
        `That split leaves no change once the mint's ${baseFeeMsat} msat split fee is paid.`
      )
    }
    const mergedMsat = totalMsat + (inputs.length - 1) * baseFeeMsat

    // Where the replacement secrets come from. On a seeded wallet that is
    // the mint's own ladder, so twelve words and the mint's name are
    // enough to find these notes again; the source advances as it is
    // drawn from, and a split draws twice.
    const root = this.noteRoot()
    const startIndex = this.counterFor(template.mintHost)
    const source = root
      ? derivedSecretSource(root, template.mintHost, startIndex)
      : (this.opts.randomSecret ?? defaultRandomSecret)
    const derived = root !== null && this.opts.randomSecret === undefined
    const nextSecret = derived ? (source as ReturnType<typeof derivedSecretSource>) : (source as () => string)

    const cut = (amountMsat: number, noteOrigin: NoteOrigin, offset: number): NoteRecord => {
      const record = this.record(template, nextSecret(), amountMsat, noteOrigin, inputIds)
      if (derived) record.index = startIndex + offset
      return record
    }
    const staged: NoteRecord[] =
      plan.kind === 'split'
        ? [cut(plan.amountMsat, 'split', 0), cut(changeMsat, 'change', 1)]
        : [cut(mergedMsat, origin, 0)]

    // The hashes are about to be disclosed: the secrets go to disk first,
    // and the counter goes with them in the SAME write. A crash here
    // wastes an index and costs nothing; the other order would hand a
    // secret to a mint the wallet could not find its way back to.
    if (derived) {
      this.data.counters ??= {}
      this.data.counters[template.mintHost] = startIndex + staged.length
    }
    this.data.notes.push(...staged)
    await this.persist()

    const k1s = inputs.map(note => note.k1)
    try {
      let signatures: Array<string | undefined>
      if (plan.kind === 'split') {
        const result = await splitNoteWithHash(
          template.callback,
          k1s,
          plan.amountMsat,
          hashK1(staged[0]!.k1),
          hashK1(staged[1]!.k1),
          this.opts
        )
        signatures = [result.signature, result.changeSignature]
      } else if (plan.kind === 'merge') {
        const result = await mergeNotesWithHash(template.callback, k1s, hashK1(staged[0]!.k1), this.opts)
        signatures = [result.signature]
      } else {
        const result = await rotateNoteWithHash(template.callback, k1s[0]!, hashK1(staged[0]!.k1), this.opts)
        signatures = [result.signature]
      }
      for (const input of inputs) this.touch(input, 'spent')
      staged.forEach((note, index) => {
        const signature = signatures[index]
        if (signature) note.signature = signature
        this.touch(note, 'live')
      })
      await this.persist()
      // An unknown-fee mint may have priced the outputs differently: ask
      // it what they are actually worth so the balance cannot drift. The
      // k1 travels only to the mint that just minted it, over the same
      // admitted URL scheme every other call uses.
      if (!feeKnown && (plan.kind === 'split' || inputs.length > 1)) {
        for (const output of staged) {
          try {
            const authoritative = await fetchNoteInfo(buildNoteUrl(output.baseUrl, output.k1), this.opts)
            if (authoritative.maxWithdrawable !== output.amountMsat) {
              output.amountMsat = authoritative.maxWithdrawable
              output.updatedAt = now()
            }
          } catch {
            // keep the computed value - reconcile and later use correct it
          }
        }
        await this.persist()
      }
      return staged
    } catch (err) {
      // A mutation is a GET, and HTTP stacks retry a GET whose connection
      // was dropped. The retry is byte-identical, and by the time it
      // arrives the input is burned, so a mint that does not recognise a
      // repeat answers "already spent" about a mutation that LANDED. From
      // the reason string alone that is indistinguishable from a genuine
      // double spend - so it is not read as either. Where the inputs were
      // live when the request went out, an already-spent or unknown-input
      // refusal is ambiguous, and the staged secrets, which may be the
      // only copy of notes the mint really did mint, are kept until
      // reconcile asks what they are worth.
      const mayHaveLanded =
        inputsWereLive && (err instanceof NoteSpentError || err instanceof NoteUnknownError)
      if (err instanceof AmbiguousMintError || mayHaveLanded) {
        // The mutation MAY have landed. The staged secrets are then the
        // only copy of the outputs - everything holds until reconcile.
        for (const note of staged) this.touch(note, 'ambiguous')
        for (const input of inputs) this.touch(input, 'ambiguous')
        await this.persist()
        if (!mayHaveLanded) throw err
        throw new AmbiguousMintError(
          `${template.mintHost} refused this ${plan.kind} because the note was already spent, which is also what it would say to a repeat of a request that had already gone through. The outcome is unknown until \`reconcile\` asks the mint what the new secrets are worth.`
        )
      }
      // Definitive refusal or nothing-sent: the mutation did not happen,
      // the staged secrets minted nothing, the inputs are untouched. A
      // missing or malformed hash, a dust or fee refusal, a sunsetting
      // mint: none of those can be a mutation that landed.
      this.data.notes = this.data.notes.filter(note => !staged.includes(note))
      await this.persist()
      throw err
    }
  }

  // ---- receiving ----

  async receive(input: string, options: {acceptBadSignature?: boolean} = {}): Promise<ReceiveResult> {
    const url = resolveNoteInput(input)
    if (!url) throw new WalletUsageError('That does not look like an LNURLcash note.')
    const k1 = noteK1(url)
    if (!k1) throw new WalletUsageError('That note URL carries no k1 - there is nothing to receive.')

    const warnings: string[] = []
    const info = await fetchNoteInfo(url, this.opts)
    const baseUrl = (() => {
      const parsed = new URL(url)
      return `${parsed.origin}${parsed.pathname}`
    })()
    const mintHost = serverOf(baseUrl)
    // The note's own way home, so a mint this wallet has only ever received
    // notes from can still have its announced rotation checked. Without it
    // the escape hatch is unreachable from the only thing the wallet has.
    const pin = await this.pinPubkey(mintHost, info.mintPubkey, info.payLink)
    if (pin.rotated) {
      warnings.push(
        `${mintHost} has rotated its signing key and says so - the old key is kept, so notes it signed still verify`
      )
    }

    const declared = noteDeclaredAmount(url)
    if (declared !== null && declared !== info.maxWithdrawable) {
      warnings.push(
        `the note URL claims ${declared} msat but the mint says ${info.maxWithdrawable} msat - the mint is authoritative`
      )
    }
    // The offline signature is the only claim on a note a holder can test
    // without trusting anyone, so a failure stops the receive before a
    // record exists. A note with NO signature is a different matter: mints
    // with no funding source legitimately issue unsigned notes, so that
    // stays a warning. So does a declared amount the mint disagrees with,
    // above: the mint's number is authoritative either way.
    const signature = noteSignature(url)
    const pinned = this.data.pubkeyPins[mintHost]
    if (signature && pinned && !this.verifyAgainstKnownKeys(mintHost, k1, info.maxWithdrawable, signature).valid) {
      if (!options.acceptBadSignature) {
        throw new BadSignatureError(
          `the signature on this note does not verify against the key pinned for ${mintHost} - the note may have been altered, or it may not come from that mint`
        )
      }
      warnings.push(
        'the offline signature on this note does not verify - accepted on your say-so, provenance is unproven'
      )
    }

    if (this.data.notes.some(note => note.id === hashK1(k1) && note.state !== 'spent' && note.state !== 'sent')) {
      throw new WalletUsageError('This note is already in the wallet.')
    }

    const received: NoteRecord = {
      id: hashK1(k1),
      k1,
      amountMsat: info.maxWithdrawable,
      baseUrl,
      callback: info.callback,
      mintHost,
      ...(signature ? {signature} : {}),
      state: 'live',
      origin: 'receive',
      createdAt: now(),
      updatedAt: now()
    }
    // Persisted before the rotate: from here on the wallet cannot lose it.
    this.data.notes = this.data.notes.filter(note => note.id !== received.id)
    this.data.notes.push(received)
    await this.persist()

    // Rotate immediately: the sender still knows this k1.
    try {
      const [rotated] = await this.mutate([received], {kind: 'rotate'})
      return {note: rotated!, warnings}
    } catch (err) {
      if (err instanceof AmbiguousMintError) throw err
      warnings.push('the mint refused to rotate - the previous holder can still spend this note until it is rotated')
      return {note: received, warnings}
    }
  }

  // ---- sending and preparing exact amounts ----

  // Returns a live note worth exactly `amountMsat`, splitting or merging as
  // needed. All inputs to one mutation live at the same mint.
  async prepareExact(amountMsat: number, mintHost?: string): Promise<NoteRecord> {
    if (!Number.isSafeInteger(amountMsat) || amountMsat <= 0) {
      throw new WalletUsageError('The amount must be a positive integer of milli-satoshis.')
    }
    const candidates = new Map<string, NoteRecord[]>()
    for (const note of this.liveNotes()) {
      if (mintHost && note.mintHost !== mintHost) continue
      // A note taken offline may have arrived without the mint's callback
      // on it. It is money, and it counts in the balance, but nothing can
      // be split or merged out of it until reconcile has been online and
      // rotated it.
      if (!note.callback) continue
      const group = candidates.get(note.mintHost) ?? []
      group.push(note)
      candidates.set(note.mintHost, group)
    }
    const hosts = [...candidates.keys()].sort((a, b) => {
      if (a === this.data.settings.defaultMintHost) return -1
      if (b === this.data.settings.defaultMintHost) return 1
      return 0
    })
    let feeBlocked = false
    for (const host of hosts) {
      const notes = candidates.get(host)!
      const total = notes.reduce((sum, note) => sum + note.amountMsat, 0)
      if (total < amountMsat) continue

      const exact = notes.find(note => note.amountMsat === amountMsat)
      if (exact) return exact

      // A split's change must survive the mint's flat fee and stay above
      // zero, so a note is only splittable with that much headroom.
      const baseFeeMsat = this.data.mints.find(mint => mint.host === host)?.mintFee?.baseFeeMsat ?? 0
      const minChangeMsat = baseFeeMsat + 1

      const splittable = notes
        .filter(note => note.amountMsat >= amountMsat + minChangeMsat)
        .sort((a, b) => a.amountMsat - b.amountMsat)[0]
      if (splittable) {
        const [target] = await this.mutate([splittable], {kind: 'split', amountMsat})
        return target!
      }

      // No single note works: gather largest-first. An exact-sum merge
      // only yields the exact amount when the mint refunds nothing, so
      // with a flat fee the target is always a split with coverable change.
      const selection: NoteRecord[] = []
      let sum = 0
      for (const note of [...notes].sort((a, b) => b.amountMsat - a.amountMsat)) {
        selection.push(note)
        sum += note.amountMsat
        if (baseFeeMsat === 0 && sum === amountMsat) break
        if (sum >= amountMsat + minChangeMsat) break
      }
      if (baseFeeMsat === 0 && sum === amountMsat) {
        const [target] = await this.mutate(selection, {kind: 'merge'})
        return target!
      }
      if (sum >= amountMsat + minChangeMsat) {
        const [target] = await this.mutate(selection, {kind: 'split', amountMsat})
        return target!
      }
      // enough value in total, but the change cannot cover the split fee
      feeBlocked = true
    }
    throw new InsufficientFundsError(
      feeBlocked
        ? `Not enough headroom for ${amountMsat} msat once the mint's split fee comes out of the change.`
        : mintHost
          ? `Not enough at ${mintHost} for ${amountMsat} msat.`
          : `No single mint holds ${amountMsat} msat - notes from different mints cannot be combined.`
    )
  }

  // Hands a note over: worth exactly the amount, freshly out of this
  // wallet's balance. The returned record's k1 is what the caller shows the
  // recipient; the state flips to 'sent' so it can be reclaimed if unclaimed.
  async send(amountMsat: number, mintHost?: string): Promise<NoteRecord> {
    const note = await this.prepareExact(amountMsat, mintHost)
    this.touch(note, 'sent')
    await this.persist()
    return note
  }

  sentNotes(): NoteRecord[] {
    return this.data.notes.filter(note => note.state === 'sent')
  }

  // A panic rotate: same value, fresh secret, everything anyone ever saw of
  // this note - a screenshot, a log line, a shoulder - stops mattering.
  async rotateLive(note: NoteRecord): Promise<NoteRecord> {
    if (note.state !== 'live') throw new WalletUsageError('Only a live note can be rotated.')
    if (!note.callback) {
      throw new WalletUsageError('This note arrived offline and has not met its mint yet - run `notecase reconcile` first.')
    }
    const [rotated] = await this.mutate([note], {kind: 'rotate'})
    return rotated!
  }

  // Takes back a handed-over note nobody has claimed yet: receiving our own
  // copy rotates it to a fresh secret, dead to whoever saw the old one. If
  // the recipient DID claim it, the receive fails with spent/unknown and
  // markTaken is the honest resolution.
  async reclaim(note: NoteRecord): Promise<ReceiveResult> {
    if (note.state !== 'sent') throw new WalletUsageError('Only a sent note can be reclaimed.')
    // Our own note coming home. Refusing it over a signature would strand
    // money to protect nobody: the record already exists and the value is
    // whatever the mint says it is when the rotate lands.
    return this.receive(this.noteUrlFor(note), {acceptBadSignature: true})
  }

  // The recipient took the note (or it should simply stop being offered
  // back): out of the sent list, into history.
  async markTaken(note: NoteRecord): Promise<void> {
    if (note.state !== 'sent') throw new WalletUsageError('Only a sent note can be marked taken.')
    this.touch(note, 'spent')
    await this.persist()
  }

  // The note as a URL: secret, amount, and - where the mint gave one - the
  // signature over both. The signature is the mint's own public statement
  // about this note, and carrying it is what lets a recipient check the
  // note without asking anyone, which is the entire point of taking one
  // offline. The kit strips it back off before any informational GET.
  noteUrlFor(note: NoteRecord): string {
    const url = buildNoteUrl(note.baseUrl, note.k1, note.amountMsat)
    return note.signature ? withNewK1(url, note.k1, note.amountMsat, note.signature) : url
  }

  // ---- the offline cash drawer ----

  ladderFor(host: string): {ladder: number[]; copies: number} {
    const entry = this.data.mints.find(mint => mint.host === host)
    return {
      ladder: entry?.ladder ?? DEFAULT_LADDER,
      copies: entry?.ladderCopies ?? DEFAULT_LADDER_COPIES
    }
  }

  async setLadder(host: string, ladder: number[], copies: number): Promise<void> {
    const entry = this.mintEntry(host)
    const clean = [...new Set(ladder)].filter(value => Number.isSafeInteger(value) && value > 0).sort((a, b) => a - b)
    if (!clean.length) throw new WalletUsageError('A cash drawer needs at least one denomination, in whole sats.')
    if (!Number.isSafeInteger(copies) || copies < 1) throw new WalletUsageError('Keep at least one of each denomination.')
    entry.ladder = clean
    entry.ladderCopies = copies
    await this.persist()
  }

  // Which notes already count as the drawer, and what is missing. Notes
  // that already sit at a wanted denomination are RESERVED: cutting a
  // 500 out of a 500 you were keeping would only churn fees.
  private ladderShape(entry: MintEntry): {
    baseFeeMsat: number
    reserved: Set<string>
    want: number[]
  } {
    const {ladder, copies} = this.ladderFor(entry.host)
    const live = this.liveNotes().filter(note => note.mintHost === entry.host && note.callback)
    const reserved = new Set<string>()
    const want: number[] = []
    for (const denomination of [...ladder].sort((a, b) => b - a)) {
      const target = denomination * 1000
      const have = live.filter(note => note.amountMsat === target && !reserved.has(note.id)).slice(0, copies)
      for (const note of have) reserved.add(note.id)
      for (let short = have.length; short < copies; short++) want.push(target)
    }
    return {baseFeeMsat: entry.mintFee?.baseFeeMsat ?? 0, reserved, want}
  }

  // The largest note that can be cut into `target` and still leave change
  // worth more than nothing once the mint's flat fee comes out of it.
  private splitSource(host: string, target: number, baseFeeMsat: number, reserved: Set<string>): NoteRecord | undefined {
    return this.liveNotes()
      .filter(
        note =>
          note.mintHost === host &&
          note.callback &&
          !reserved.has(note.id) &&
          note.amountMsat >= target + baseFeeMsat + 1
      )
      .sort((a, b) => b.amountMsat - a.amountMsat)[0]
  }

  // What preparing for offline would do, and what it would cost - without
  // doing any of it. Largest note first, one split per output, and the
  // change stays as one note so the next cut comes out of the same pile.
  ladderPlan(mintHost?: string): LadderPlan {
    const entry = this.mintEntry(mintHost)
    const {baseFeeMsat, reserved, want} = this.ladderShape(entry)
    // The plan is worked out against a copy of the amounts, so a preview
    // costs nothing and the fee it quotes is the fee the real run takes.
    const pool = this.liveNotes()
      .filter(note => note.mintHost === entry.host && note.callback && !reserved.has(note.id))
      .map(note => note.amountMsat)
    const cut: number[] = []
    const short: number[] = []
    for (const target of want) {
      let pick = -1
      for (let index = 0; index < pool.length; index++) {
        if (pool[index]! < target + baseFeeMsat + 1) continue
        if (pick < 0 || pool[index]! > pool[pick]!) pick = index
      }
      if (pick < 0) {
        short.push(target)
        continue
      }
      const change = pool[pick]! - target - baseFeeMsat
      pool.splice(pick, 1)
      pool.push(change)
      cut.push(target)
    }
    return {mintHost: entry.host, cut, feeMsat: cut.length * baseFeeMsat, short}
  }

  // Cuts the drawer. Re-runnable: whatever is already there is counted
  // first, so running it twice in a row does nothing the second time.
  async prepareOffline(mintHost?: string): Promise<{plan: LadderPlan; made: NoteRecord[]; feeMsat: number}> {
    const plan = this.ladderPlan(mintHost)
    const entry = this.mintEntry(plan.mintHost)
    const {baseFeeMsat, reserved} = this.ladderShape(entry)
    const made: NoteRecord[] = []
    for (const target of plan.cut) {
      const source = this.splitSource(entry.host, target, baseFeeMsat, reserved)
      if (!source) break
      const [note] = await this.mutate([source], {kind: 'split', amountMsat: target})
      // never cut up what was just cut
      reserved.add(note!.id)
      made.push(note!)
    }
    return {plan, made, feeMsat: made.length * baseFeeMsat}
  }

  // Notes that add up to exactly the amount, or the nearest above it.
  // Bounded: at most OFFLINE_SUBSET_LIMIT notes are looked at and the walk
  // gives up after OFFLINE_SEARCH_STEPS, because a case full of notes is a
  // subset-sum problem and a wallet must answer in a moment either way.
  private subsetFor(pool: NoteRecord[], amountMsat: number): {notes: NoteRecord[]; totalMsat: number} | null {
    const sorted = [...pool].sort((a, b) => b.amountMsat - a.amountMsat).slice(0, OFFLINE_SUBSET_LIMIT)
    const remaining: number[] = new Array(sorted.length + 1).fill(0)
    for (let index = sorted.length - 1; index >= 0; index--) {
      remaining[index] = remaining[index + 1]! + sorted[index]!.amountMsat
    }
    let steps = 0
    let best: {notes: NoteRecord[]; totalMsat: number} | null = null
    const chosen: NoteRecord[] = []
    const walk = (from: number, total: number): boolean => {
      if (total === amountMsat && chosen.length) {
        best = {notes: [...chosen], totalMsat: total}
        return true
      }
      if (total > amountMsat) {
        // adding another note only overshoots further, so this is as close
        // above as this branch gets
        if (!best || total < best.totalMsat) best = {notes: [...chosen], totalMsat: total}
        return false
      }
      if (from >= sorted.length) return false
      if (total + remaining[from]! < amountMsat) return false
      if (steps++ > OFFLINE_SEARCH_STEPS) return false
      for (let index = from; index < sorted.length; index++) {
        chosen.push(sorted[index]!)
        if (walk(index + 1, total + sorted[index]!.amountMsat)) return true
        chosen.pop()
      }
      return false
    }
    walk(0, 0)
    return best
  }

  // What could be handed over for an amount with no mint in the loop.
  // Nothing is committed here: an inexact answer is for the payer to
  // accept or refuse, and they cannot do that if it has already happened.
  planOfflineSend(amountMsat: number, mintHost?: string): OfflineSelection {
    if (!Number.isSafeInteger(amountMsat) || amountMsat <= 0) {
      throw new WalletUsageError('The amount must be a positive integer of milli-satoshis.')
    }
    const byHost = new Map<string, NoteRecord[]>()
    for (const note of this.liveNotes()) {
      if (mintHost && note.mintHost !== mintHost) continue
      byHost.set(note.mintHost, [...(byHost.get(note.mintHost) ?? []), note])
    }
    const hosts = [...byHost.keys()].sort((a, b) => {
      if (a === this.data.settings.defaultMintHost) return -1
      if (b === this.data.settings.defaultMintHost) return 1
      return 0
    })
    let nearest: OfflineSelection | null = null
    for (const host of hosts) {
      const pool = byHost.get(host)!
      if (pool.reduce((sum, note) => sum + note.amountMsat, 0) < amountMsat) continue
      const found = this.subsetFor(pool, amountMsat)
      if (!found) continue
      const selection: OfflineSelection = {
        mintHost: host,
        notes: found.notes,
        totalMsat: found.totalMsat,
        overpayMsat: found.totalMsat - amountMsat,
        capped: pool.length > OFFLINE_SUBSET_LIMIT
      }
      if (selection.overpayMsat === 0) return selection
      if (!nearest || selection.overpayMsat < nearest.overpayMsat) nearest = selection
    }
    if (nearest) return nearest
    throw new InsufficientFundsError(
      mintHost
        ? `Not enough at ${mintHost} to hand over ${amountMsat} msat offline.`
        : `No single mint holds ${amountMsat} msat - and offline, notes cannot be split or combined.`
    )
  }

  // Hands notes over with no mint in the loop at all: no wire call is made
  // here, which is the strongest form of the kit's `offline` promise. The
  // records go to 'sent' and are persisted BEFORE the URLs are returned,
  // so a crash between here and the hand-over leaves notes that can be
  // reclaimed, never notes that were given away twice.
  async sendOffline(
    amountMsat: number,
    mintHost?: string,
    options: {acceptOverpay?: boolean} = {}
  ): Promise<OfflineHandover> {
    const selection = this.planOfflineSend(amountMsat, mintHost)
    if (selection.overpayMsat > 0 && !options.acceptOverpay) {
      throw new WalletUsageError(
        `No notes at ${selection.mintHost} add up to exactly ${amountMsat} msat, and offline nothing can be split. The nearest is ${selection.totalMsat} msat, which overpays by ${selection.overpayMsat} msat.`
      )
    }
    for (const note of selection.notes) {
      note.sentOffline = true
      this.touch(note, 'sent')
    }
    await this.persist()
    return {...selection, urls: selection.notes.map(note => this.noteUrlFor(note))}
  }

  // Takes a note on its signature alone. This needs a pin: a wallet that
  // has never spoken to that mint has nothing to check the signature
  // against, and taking a note it cannot check is the leap of faith LUD-25
  // is careful not to ask for. The note is stored unrotated, because
  // rotating needs the mint - the person who handed it over still knows
  // the secret until reconcile has been online.
  async receiveOffline(input: string): Promise<ReceiveResult> {
    const url = resolveNoteInput(input)
    if (!url) throw new WalletUsageError('That does not look like an LNURLcash note.')
    const k1 = noteK1(url)
    if (!k1) throw new WalletUsageError('That note URL carries no k1 - there is nothing to receive.')
    const baseUrl = (() => {
      const parsed = new URL(url)
      return `${parsed.origin}${parsed.pathname}`
    })()
    const mintHost = serverOf(baseUrl)
    const pinned = this.data.pubkeyPins[mintHost]
    if (!pinned) {
      throw new WalletUsageError(
        `This wallet has never spoken to ${mintHost}, so it has no key to check this note against. Take it while you have a connection instead.`
      )
    }
    const signature = noteSignature(url)
    const declared = noteDeclaredAmount(url)
    if (!signature || declared === null) {
      throw new WalletUsageError(
        'A note taken offline has to carry both its amount and the mint\'s signature, and this one does not. Take it while you have a connection instead.'
      )
    }
    if (!this.verifyAgainstKnownKeys(mintHost, k1, declared, signature).valid) {
      throw new BadSignatureError(
        `the signature on this note does not verify against any key ${mintHost} is known to sign with - the note may have been altered, or it may not come from that mint`
      )
    }
    if (this.data.notes.some(note => note.id === hashK1(k1) && note.state !== 'spent' && note.state !== 'sent')) {
      throw new WalletUsageError('This note is already in the wallet.')
    }
    // The mint's callback is not on a note URL, so it is borrowed from
    // another note of the same mint if there is one. Where there is not,
    // reconcile asks the mint for it before rotating.
    const known = this.data.notes.find(note => note.baseUrl === baseUrl && note.callback)
    const received: NoteRecord = {
      id: hashK1(k1),
      k1,
      amountMsat: declared,
      baseUrl,
      callback: known?.callback ?? '',
      mintHost,
      signature,
      state: 'live',
      origin: 'receive',
      unrotated: true,
      createdAt: now(),
      updatedAt: now()
    }
    this.data.notes = this.data.notes.filter(note => note.id !== received.id)
    this.data.notes.push(received)
    await this.persist()
    return {
      note: received,
      warnings: [
        'taken on the mint\'s signature alone - whoever handed it over still knows the secret until `reconcile` rotates it'
      ]
    }
  }

  // ---- notes over Nostr ----

  nostrIdentity(): NostrIdentity | null {
    const secret = this.data.settings.nostrSecretHex
    return secret ? identityFromSecret(secret) : null
  }

  async ensureNostrIdentity(): Promise<NostrIdentity> {
    const existing = this.nostrIdentity()
    if (existing) return existing
    this.data.settings.nostrSecretHex = newIdentitySecretHex()
    await this.persist()
    return this.nostrIdentity()!
  }

  nostrRelays(): string[] {
    return this.data.settings.nostrRelays ?? BOOTSTRAP_RELAYS
  }

  async setNostrRelays(relays: string[]): Promise<void> {
    this.data.settings.nostrRelays = relays
    await this.persist()
  }

  // Tell senders where to put our wraps (kind 10050). Without this a
  // sender falls back to guessing, and guesses miss.
  async publishInbox(transport: NostrTransport): Promise<{ok: string[]; failed: string[]}> {
    const identity = await this.ensureNostrIdentity()
    const relays = this.nostrRelays()
    return transport.publish([...new Set([...relays, ...BOOTSTRAP_RELAYS])], inboxRelayListEvent(identity, relays))
  }

  // A note out of this wallet's balance, sealed to `recipient` and left on
  // their inbox relays. The record goes to 'sent' with the recipient on it
  // BEFORE the wrap exists, so a crash mid-publish leaves a note that can
  // be reclaimed, never one that can be wrapped twice. `inboxKnown` false
  // means the recipient has no kind 10050 and the wrap went to our own
  // relays instead - it may sit unread there.
  async sendToNostr(
    transport: NostrTransport,
    amountMsat: number,
    recipient: string,
    mintHost?: string
  ): Promise<{note: NoteRecord; recipientHex: string; relays: string[]; failed: string[]; inboxKnown: boolean; wrapId: string}> {
    const recipientHex = await resolveRecipient(recipient, this.opts.fetch ?? fetch)
    const identity = await this.ensureNostrIdentity()
    // Their kind 10050 lives on the indexers as well as wherever they put
    // it; look on both, the same set publishInbox() writes to.
    const inbox = await inboxRelays(transport, recipientHex, [...new Set([...this.nostrRelays(), ...BOOTSTRAP_RELAYS])])
    const inboxKnown = inbox.length > 0
    const relays = inboxKnown ? inbox : this.nostrRelays()

    const note = await this.send(amountMsat, mintHost)
    note.sentTo = recipientHex
    note.updatedAt = now()
    await this.persist()

    const wrap = wrapNote(this.noteUrlFor(note), note.amountMsat, recipientHex, identity)
    const result = await transport.publish(relays, wrap)
    return {note, recipientHex, relays: result.ok, failed: result.failed, inboxKnown, wrapId: wrap.id}
  }

  // ---- a lightning address at a mint ----

  lightningAddress(): string | null {
    return this.data.settings.lightningAddress ?? null
  }

  // What a mint charges for a name, or null if it does not sell them.
  async namePriceMsat(mintHost?: string): Promise<number | null> {
    const entry = this.mintEntry(mintHost)
    const discovery = await this.discoveryDocument(entry.host)
    const price = discovery?.body.namePriceMsat
    return typeof price === 'number' && Number.isSafeInteger(price) && price >= 0 ? price : null
  }

  // Claims `name@host` at a mint. The mint takes a note of its own as
  // payment and burns it, and the only identity involved is this wallet's
  // Nostr key: the request is signed with it (NIP-98), so the name belongs
  // to the key and payouts arrive sealed to it.
  //
  // The note is marked handed over BEFORE the request goes out, as every
  // other hand-over is. A mint that refuses without taking it leaves a
  // note this wallet can simply take back, and that is attempted here.
  async registerName(options: {name: string; mintHost?: string}): Promise<{address: string; paidMsat: number}> {
    const name = options.name.trim().toLowerCase()
    if (!/^[a-z0-9][a-z0-9_.-]{2,31}$/.test(name)) {
      throw new WalletUsageError(
        'A name is 3 to 32 characters of lower-case letters, numbers, dot, dash or underscore, starting with a letter or number.'
      )
    }
    const entry = this.mintEntry(options.mintHost)
    const discovery = await this.discoveryDocument(entry.host)
    if (!discovery) throw new WalletUsageError(`${entry.host} does not publish what it charges for a name.`)
    const price = discovery.body.namePriceMsat
    if (typeof price !== 'number' || !Number.isSafeInteger(price) || price < 0) {
      throw new WalletUsageError(`${entry.host} is not handing out lightning addresses.`)
    }
    const identity = await this.ensureNostrIdentity()

    const note = price > 0 ? await this.prepareExact(price, entry.host) : null
    if (note) {
      note.sentTo = entry.host
      this.touch(note, 'sent')
      await this.persist()
    }

    const url = new URL('/names', discovery.url).toString()
    const body = JSON.stringify({name, ...(note ? {note: this.noteUrlFor(note)} : {})})
    let answer: {status?: string; reason?: string} = {}
    try {
      const fetchImpl = this.opts.fetch ?? fetch
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: nip98Header(identity, url, 'POST', body)
        },
        body,
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 30_000)
      })
      answer = (await response.json().catch(() => ({}))) as {status?: string; reason?: string}
      if (!response.ok || answer.status === 'ERROR') {
        throw new WalletUsageError(answer.reason ?? `${entry.host} refused the name (${response.status}).`)
      }
    } catch (err) {
      // The mint did not take the name. If it did not take the note
      // either, this brings it home under a fresh secret; if it did, the
      // note stays listed as handed over and `reclaim` says so later.
      if (note) {
        try {
          await this.reclaim(note)
        } catch {
          // left as sent on purpose - only the mint can settle it now
        }
      }
      throw err
    }

    if (note) await this.markTaken(note)
    this.data.settings.lightningAddress = `${name}@${entry.host}`
    await this.persist()
    return {address: this.data.settings.lightningAddress, paidMsat: note?.amountMsat ?? 0}
  }

  // ---- a heartwood signer as a note locker ----

  heartwoodLink(): HeartwoodLink | null {
    return this.data.settings.heartwood ?? null
  }

  async linkHeartwood(transport: NostrTransport, bunkerUri: string): Promise<HeartwoodLink> {
    const {link, secret} = newHeartwoodLink(bunkerUri)
    if (!secret) throw new HeartwoodError('The bunker URI carries no secret; the device binds clients by it.')
    await new HeartwoodClient(transport, link).connect(secret)
    this.data.settings.heartwood = link
    await this.persist()
    return link
  }

  async unlinkHeartwood(): Promise<void> {
    delete this.data.settings.heartwood
    await this.persist()
  }

  private heartwoodClient(transport: NostrTransport): HeartwoodClient {
    const link = this.heartwoodLink()
    if (!link) throw new WalletUsageError('No heartwood is linked. `notecase heartwood link <bunker://...>` first.')
    return new HeartwoodClient(transport, link)
  }

  async heartwoodNotes(transport: NostrTransport): Promise<DeviceNote[]> {
    return this.heartwoodClient(transport).listNotes()
  }

  // A sender the device stores notes from without a hold. `sender` is an
  // npub, hex or NIP-05, as for send; a public mint publishes its key as
  // `nostrPubkey` on its zap payRequest.
  async heartwoodTrust(transport: NostrTransport, sender: string, remove = false): Promise<{pubkeyHex: string; trusted: boolean; changed: boolean}> {
    const pubkeyHex = await resolveRecipient(sender, this.opts.fetch ?? fetch)
    const client = this.heartwoodClient(transport)
    const result = remove ? await client.untrust(pubkeyHex) : await client.trust(pubkeyHex)
    return {pubkeyHex, ...result}
  }

  // A bunker URI for another device, minted by the signer on a hold. Only
  // a wallet already bound can ask, so a stolen signer with no wallet
  // bound to it still pairs with nothing.
  async heartwoodPairWallet(transport: NostrTransport, label: string): Promise<{uri: string; slotIndex: number; label: string}> {
    return this.heartwoodClient(transport).pairWallet(label)
  }

  async heartwoodTrusted(transport: NostrTransport): Promise<string[]> {
    return this.heartwoodClient(transport).trusted()
  }

  // Tell senders where the device's wraps go: its kind 10050, signed by
  // the device (one hold), on its relays, ours, and the indexers.
  async publishHeartwoodInbox(transport: NostrTransport): Promise<{relays: string[]; ok: string[]; failed: string[]}> {
    const client = this.heartwoodClient(transport)
    const result = await client.publishInbox([...this.nostrRelays(), ...BOOTSTRAP_RELAYS])
    return {relays: client.link.relays, ok: result.ok, failed: result.failed}
  }

  // Bring in what arrived at the device by gift wrap. The device cannot
  // rotate, so until this runs those notes are only as safe as the wrap on
  // the relay; each one is exported (a hold on the device), claimed here
  // (which rotates it), then marked spent there (a second hold). A note the
  // mint reports spent is marked spent on the device too - that is the
  // truth, however it got that way.
  async collectFromHeartwood(
    transport: NostrTransport,
    onProgress: (step: string) => void = () => {}
  ): Promise<{collected: ReceiveResult[]; failed: {id: string; reason: string}[]}> {
    const client = this.heartwoodClient(transport)
    const held = (await client.listNotes()).filter(n => n.state === 'confirmed' && n.from)
    const collected: ReceiveResult[] = []
    const failed: {id: string; reason: string}[] = []
    if (!held.length) {
      await this.persist()
      return {collected, failed}
    }

    // Ask for every secret at once. The device coalesces asks that share a
    // client, identity and method onto ONE card, and a single hold answers
    // the batch - but only while that card is still open. Awaiting each
    // reply before sending the next means the card has always resolved by
    // the time the next arrives, so four notes cost four holds instead of
    // one. Firing them together is what lets the batching work at all.
    onProgress(
      held.length === 1
        ? `hold the device button to release ${held[0]!.id}`
        : `hold the device button once to release all ${held.length} notes`
    )
    const secrets = await Promise.all(
      held.map(note =>
        client.exportSecret(note.id).then(
          k1 => ({note, k1, error: null as string | null}),
          (err: Error) => ({note, k1: null as string | null, error: err.message})
        )
      )
    )

    const claimed: (typeof held)[number][] = []
    const released: {note: (typeof held)[number]; k1: string}[] = []
    for (const outcome of secrets) {
      if (outcome.k1 === null) failed.push({id: outcome.note.id, reason: outcome.error!})
      else released.push({note: outcome.note, k1: outcome.k1})
    }

    for (const {note, k1} of released) {
      const url = buildNoteUrl(`lnurlw://${note.host}`, k1, note.amount_msat)
      let result: ReceiveResult | null = null
      try {
        result = await this.receive(url)
        if (note.from) result.note.receivedFrom = note.from
        collected.push(result)
      } catch (err) {
        if (!(err instanceof NoteSpentError || err instanceof WalletUsageError)) {
          failed.push({id: note.id, reason: (err as Error).message})
          continue
        }
        // Already burned, or already ours: the device copy is history.
      }
      claimed.push(note)
    }

    // Same again for the spend marks: one hold for the batch.
    if (claimed.length) {
      onProgress(
        claimed.length === 1
          ? `hold again to mark ${claimed[0]!.id} spent on the device`
          : `hold once more to mark all ${claimed.length} spent on the device`
      )
      const marks = await Promise.all(
        claimed.map(note =>
          client.markSpent(note.id).then(
            () => null,
            (err: Error) => ({
              id: note.id,
              reason: `claimed here but not marked spent on the device: ${err.message}`
            })
          )
        )
      )
      for (const mark of marks) if (mark) failed.push(mark)
    }
    await this.persist()
    return {collected, failed}
  }

  // Ask the device to seal one of ITS notes to an npub. The wrap comes back
  // opaque and goes to the recipient's inbox relays; the secret stayed on
  // the chip throughout.
  async heartwoodSend(
    transport: NostrTransport,
    noteId: string,
    recipient: string
  ): Promise<{recipientHex: string; relays: string[]; failed: string[]; inboxKnown: boolean; wrapId: string}> {
    const recipientHex = await resolveRecipient(recipient, this.opts.fetch ?? fetch)
    const client = this.heartwoodClient(transport)
    const inbox = await inboxRelays(transport, recipientHex, [...new Set([...this.nostrRelays(), ...BOOTSTRAP_RELAYS])])
    const inboxKnown = inbox.length > 0
    const relays = inboxKnown ? inbox : this.nostrRelays()
    const wrap = await client.sendNote(noteId, recipientHex)
    const result = await transport.publish(relays, wrap)
    return {recipientHex, relays: result.ok, failed: result.failed, inboxKnown, wrapId: wrap.id}
  }

  // Open every wrap addressed to us since the last look and claim what is
  // inside. Claiming IS rotating: the mint burns the wrapped secret and
  // hands back a fresh one, so the copy on the relay is dead the moment
  // this returns. A wrap that fails for a reason that will not change
  // (not a note, already spent, already ours) is remembered and not
  // reopened; a network failure is not, so the next pass retries it.
  async receiveFromNostr(transport: NostrTransport): Promise<{received: ReceiveResult[]; skipped: {wrapId: string; reason: string}[]}> {
    const identity = await this.ensureNostrIdentity()
    const since = this.data.settings.nostrLastCheck ?? 0
    const seen = new Set(this.data.settings.nostrSeenWrapIds ?? [])
    const wraps = await fetchWraps(transport, this.nostrRelays(), identity.pubkey, since)
    const received: ReceiveResult[] = []
    const skipped: {wrapId: string; reason: string}[] = []
    let newestSeen = since
    for (const wrap of wraps) {
      if (seen.has(wrap.id)) continue
      let opened
      try {
        opened = unwrapNote(wrap, identity)
      } catch (err) {
        // Not ours to open, or not a note: nothing will change on retry.
        seen.add(wrap.id)
        if (err instanceof NotANoteWrapError) skipped.push({wrapId: wrap.id, reason: err.message})
        continue
      }
      try {
        const result = await this.receive(opened.note.noteUrl)
        result.note.receivedFrom = opened.sender
        if (opened.zap) result.note.zap = opened.zap
        seen.add(wrap.id)
        received.push(result)
      } catch (err) {
        if (
          err instanceof WalletUsageError ||
          err instanceof NoteSpentError ||
          err instanceof NoteUnknownError ||
          // A signature does not start verifying on the next pass, and one
          // bad wrap must not stop the rest of the inbox being opened.
          err instanceof BadSignatureError
        ) {
          seen.add(wrap.id)
          skipped.push({wrapId: wrap.id, reason: err.message})
        } else {
          throw err
        }
      }
      newestSeen = Math.max(newestSeen, wrap.created_at)
    }
    this.data.settings.nostrSeenWrapIds = [...seen].slice(-500)
    this.data.settings.nostrLastCheck = Math.max(newestSeen, Math.floor(now() / 1000))
    await this.persist()
    return {received, skipped}
  }

  // ---- minting ----

  async startMint(grossMsat: number, mintHost?: string): Promise<{pending: PendingMint; fee: MintFee | null}> {
    const entry = this.mintEntry(mintHost)
    const pay = await fetchPayRequest(entry.payUrl, this.opts)
    if (!pay.withdrawLink) throw new WalletUsageError(`${entry.host} no longer advertises minting.`)
    const fee = pay.mintFee ?? null
    // keep the cached fee current - mutations price themselves off it
    if (fee) entry.mintFee = fee
    else delete entry.mintFee
    const invoice = await requestInvoice(pay.callback, grossMsat, this.opts)
    const decoded = tryDecodeBolt11(invoice.pr)
    if (!decoded) throw new WalletUsageError('The mint returned an invoice this wallet cannot decode.')
    const pending: PendingMint = {
      id: decoded.paymentHashHex,
      mintHost: entry.host,
      baseUrl: fromLud17(pay.withdrawLink),
      pr: invoice.pr,
      ...(invoice.verify ? {verifyUrl: invoice.verify} : {}),
      grossMsat,
      expectedNetMsat: fee ? mintFeeBand(grossMsat, fee).maxNetMsat : grossMsat,
      minNetMsat: fee ? mintFeeBand(grossMsat, fee).minNetMsat : grossMsat,
      state: 'awaiting',
      createdAt: now(),
      updatedAt: now()
    }
    this.data.pendingMints.push(pending)
    await this.persist()
    return {pending, fee}
  }

  // Claims a settled mint invoice: the payment preimage IS the note. The
  // preimage may come from LUD-21 verify or from the payer's own wallet
  // (an NWC pay result); either way it is checked against the payment hash
  // before anything is believed.
  async claimMint(pending: PendingMint, preimageHex: string): Promise<ReceiveResult> {
    if (!verifyPreimage(preimageHex, pending.id)) {
      throw new WalletUsageError('That preimage does not settle this mint invoice.')
    }
    // The preimage is the note's k1, so it is persisted with the claim
    // BEFORE the receive runs: a failure from here to the note landing
    // (timeout, crash, changed mint key) leaves reconcile() everything it
    // needs to re-drive the receive, and the money is never memory-only.
    pending.preimageHex = preimageHex
    pending.state = 'claimed'
    pending.updatedAt = now()
    await this.persist()
    // If this throws, state and preimage stay persisted as they are -
    // reconcile() owns the retry from here.
    // Declare an amount only when the fee pins one exactly. Where the
    // mint's rounding is still open, we do not know what this note is
    // worth until it answers, and a declared amount we invented would
    // only make receive() warn about our own guess.
    const floor = pending.minNetMsat ?? pending.expectedNetMsat
    const declared = floor === pending.expectedNetMsat ? pending.expectedNetMsat : undefined
    const result = await this.receive(buildNoteUrl(pending.baseUrl, preimageHex, declared))
    delete pending.preimageHex
    pending.updatedAt = now()
    await this.persist()
    if (result.note.amountMsat > pending.expectedNetMsat || result.note.amountMsat < floor) {
      result.warnings.push(
        `expected ${floor === pending.expectedNetMsat ? `${pending.expectedNetMsat}` : `${floor}-${pending.expectedNetMsat}`} msat net but the mint credited ${result.note.amountMsat} msat`
      )
    }
    return result
  }

  // Polls LUD-21 verify until the invoice settles, then claims.
  async awaitMint(pending: PendingMint, options: {timeoutMs?: number; intervalMs?: number} = {}): Promise<ReceiveResult | null> {
    const timeoutMs = options.timeoutMs ?? 60_000
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new WalletUsageError('The wait must be a positive, finite number of milliseconds.')
    }
    if (!pending.verifyUrl) {
      throw new WalletUsageError(
        'This mint offers no LUD-21 verify - pay the invoice, then run `notecase receive` and paste <baseUrl>?k1=<payment preimage>.'
      )
    }
    const deadline = now() + timeoutMs
    for (;;) {
      const verification = await fetchInvoiceVerification(pending.verifyUrl, this.opts)
      if (verification.settled && verification.preimage) {
        return this.claimMint(pending, verification.preimage)
      }
      if (now() > deadline) return null
      await new Promise(resolve => setTimeout(resolve, options.intervalMs ?? 1_000))
    }
  }

  // ---- moving value between mints ----

  // A transfer is a mint at the destination paid for by a melt at the
  // source: B issues an invoice, A pays it, and B's payment preimage is
  // the note that lands. Nothing here is new protocol, which is the point
  // - it is startMint, melt and awaitMint in a row, so every safety rule
  // those already follow (persist before disclose, melt-OK-means-in-flight,
  // rotate on claim) applies unchanged.
  //
  // The failure that matters is the middle one. A melt's OK only means the
  // payment is in flight, so between here and B settling there is a window
  // where A's note is burned and B's note does not exist yet. That window
  // is not closed by trying harder; it is closed by never reporting success
  // the wallet has not seen, and leaving reconcile() to finish either way.
  async transfer(
    grossMsat: number,
    fromMintHost: string,
    toMintHost: string,
    options: {timeoutMs?: number; intervalMs?: number} = {}
  ): Promise<{
    pending: PendingMint
    melt: MeltRecord
    fee: MintFee | null
    result: ReceiveResult | null
    ambiguous: boolean
  }> {
    const from = this.mintEntry(fromMintHost)
    const to = this.mintEntry(toMintHost)
    if (from.host === to.host) {
      // Melting a note to pay the same mint's own invoice is a self-payment
      // against one node. It moves nothing and proves nothing, and it still
      // costs both fees.
      throw new WalletUsageError('A transfer needs two different mints.')
    }

    const {pending, fee} = await this.startMint(grossMsat, to.host)
    if (!pending.verifyUrl) {
      // Without verify there is no way to learn the preimage, and the
      // preimage IS the note. Refuse before burning anything at the source.
      this.data.pendingMints = this.data.pendingMints.filter(record => record !== pending)
      await this.persist()
      throw new WalletUsageError(
        `${to.host} offers no LUD-21 verify, so a transfer into it could not claim the note it paid for.`
      )
    }

    let melt: MeltRecord
    let ambiguous: boolean
    try {
      ;({melt, ambiguous} = await this.melt(pending.pr, `mint@${to.host}`, from.host))
    } catch (err) {
      // A definitive refusal means melt() burned nothing and the source
      // note is untouched, so the invoice we just asked the destination
      // for will never be paid. Drop it rather than leave a pending mint
      // sitting 'awaiting' forever: it cannot resolve, and it makes the
      // wallet report unresolved outcomes that reconcile has no answer
      // for. An ambiguous melt is the opposite case and keeps its pending.
      this.data.pendingMints = this.data.pendingMints.filter(record => record !== pending)
      await this.persist()
      throw err
    }
    if (ambiguous) return {pending, melt, fee, result: null, ambiguous: true}

    const result = await this.awaitMint(pending, options)
    return {pending, melt, fee, result, ambiguous: false}
  }

  // ---- melting ----

  // `sendMsat` is for an invoice that states no amount: the payee left the
  // figure to the payer, so the wallet has to be told it. A mint melting
  // such an invoice sends the whole-sat floor of the note it burns, which
  // is why this prepares a note of exactly the amount asked for rather
  // than passing the figure to the mint - there is nowhere on the wire to
  // put it. Supplying it for an invoice that already names an amount is
  // refused rather than silently ignored: the two figures could differ,
  // and guessing which one the payer meant is not the wallet's call.
  async melt(
    pr: string,
    target: string,
    mintHost?: string,
    options: {sendMsat?: number} = {}
  ): Promise<{melt: MeltRecord; ambiguous: boolean}> {
    const decoded = tryDecodeBolt11(pr)
    if (!decoded) throw new WalletUsageError('That is not a decodable BOLT-11 invoice.')
    const expiresAt = (decoded.timestamp + decoded.expirySeconds) * 1000
    if (expiresAt < now()) throw new WalletUsageError('That invoice has expired.')
    if (decoded.amountMsats !== null && options.sendMsat !== undefined) {
      throw new WalletUsageError('That invoice already states its amount - drop the amount argument.')
    }
    if (decoded.amountMsats === null && options.sendMsat === undefined) {
      throw new WalletUsageError('That invoice states no amount - say how much to send.')
    }
    const amountMsat = decoded.amountMsats === null ? options.sendMsat! : Number(decoded.amountMsats)
    if (!Number.isSafeInteger(amountMsat) || amountMsat <= 0) {
      throw new WalletUsageError('That invoice amount is out of range.')
    }
    // The mint sends the whole-sat floor of whatever note it burns, so a
    // sub-sat amount would quietly send less than asked. Refuse instead.
    if (decoded.amountMsats === null && amountMsat % 1000 !== 0) {
      throw new WalletUsageError('An amountless invoice can only be paid a whole number of sats.')
    }

    const note = await this.prepareExact(amountMsat, mintHost)
    const melt: MeltRecord = {
      paymentHash: decoded.paymentHashHex,
      noteId: note.id,
      pr,
      amountMsat,
      target,
      state: 'in-flight',
      createdAt: now(),
      updatedAt: now()
    }
    // Recorded before the wire call: OK from the mint means in flight, and
    // a lost answer means reconcile owns it - never a guess.
    this.data.melts.push(melt)
    this.touch(note, 'melting')
    await this.persist()

    try {
      const result = await meltNote(note.callback, note.k1, pr, this.opts)
      if (result.verify) {
        melt.verifyUrl = result.verify
        melt.updatedAt = now()
        await this.persist()
      }
      return {melt, ambiguous: false}
    } catch (err) {
      if (err instanceof PendingNoteError) return {melt, ambiguous: true}
      if (err instanceof AmbiguousMintError) return {melt, ambiguous: true}
      // Definitive refusal: nothing happened, the note is untouched.
      this.data.melts = this.data.melts.filter(record => record !== melt)
      this.touch(note, 'live')
      await this.persist()
      throw err
    }
  }

  // ---- reconciliation ----

  async reconcile(): Promise<ReconcileEvent[]> {
    const events: ReconcileEvent[] = []

    // Mint invoices we were waiting on.
    for (const pending of [...this.data.pendingMints]) {
      if (pending.state !== 'awaiting' || !pending.verifyUrl) continue
      try {
        const verification = await fetchInvoiceVerification(pending.verifyUrl, this.opts)
        if (verification.settled && verification.preimage) {
          const result = await this.claimMint(pending, verification.preimage)
          events.push({kind: 'mint-claimed', detail: `${result.note.amountMsat} msat from ${pending.mintHost}`})
          continue
        }
        const decoded = tryDecodeBolt11(pending.pr)
        if (decoded && (decoded.timestamp + decoded.expirySeconds) * 1000 < now()) {
          pending.state = 'expired'
          pending.updatedAt = now()
          events.push({kind: 'mint-expired', detail: `${pending.grossMsat} msat invoice at ${pending.mintHost}`})
        }
      } catch {
        events.push({kind: 'unreachable', detail: `${pending.mintHost} could not answer about a pending mint`})
      }
    }

    // Claims that persisted their preimage but crashed (or failed) before
    // the receive landed. hashK1 is sha256 and the note's id IS the invoice
    // payment hash, so a note under pending.id - in any state - means the
    // claim already landed and the held preimage can simply be dropped.
    // Otherwise the receive is re-driven from the persisted record.
    for (const pending of [...this.data.pendingMints]) {
      if (pending.state !== 'claimed' || !pending.preimageHex) continue
      if (this.data.notes.some(note => note.id === pending.id)) {
        delete pending.preimageHex
        pending.updatedAt = now()
        continue
      }
      try {
        const reFloor = pending.minNetMsat ?? pending.expectedNetMsat
        const result = await this.receive(
          buildNoteUrl(
            pending.baseUrl,
            pending.preimageHex,
            reFloor === pending.expectedNetMsat ? pending.expectedNetMsat : undefined
          )
        )
        delete pending.preimageHex
        pending.updatedAt = now()
        events.push({kind: 'mint-claimed', detail: `${result.note.amountMsat} msat from ${pending.mintHost}`})
      } catch (err) {
        if (err instanceof WalletUsageError && err.message === 'This note is already in the wallet.') {
          // an odd state, but the money is provably here - clean up
          delete pending.preimageHex
          pending.updatedAt = now()
          continue
        }
        // the preimage stays persisted; the next reconcile tries again
        events.push({
          kind: 'mint-claim-retry',
          detail: `${pending.mintHost} has not confirmed a paid mint yet - will try again`
        })
      }
    }

    // Staged and ambiguous mutation outputs, grouped by the inputs they
    // replaced: one probe of an input tells the whole group's fate.
    const groups = new Map<string, NoteRecord[]>()
    for (const note of this.data.notes) {
      if ((note.state === 'staged' || note.state === 'ambiguous') && note.replaces?.length) {
        const key = note.replaces.join(',')
        groups.set(key, [...(groups.get(key) ?? []), note])
      }
    }
    for (const [key, staged] of groups) {
      const inputIds = key.split(',')
      const input = this.noteById(inputIds[0]!)
      if (!input) continue
      const probe = await probeBurnedNote(buildNoteUrl(input.baseUrl, input.k1), this.opts)
      if (probe === 'live') {
        // The mutation never landed. Inputs stand; the staged secrets
        // minted nothing. A melting input stays the melt machinery's.
        for (const id of inputIds) {
          const note = this.noteById(id)
          if (note && note.state === 'ambiguous') this.touch(note, 'live')
        }
        this.data.notes = this.data.notes.filter(note => !staged.includes(note))
        events.push({kind: 'mutation-unwound', detail: `${staged.length} staged output(s) discarded, inputs restored`})
      } else if (probe === 'gone') {
        for (const id of inputIds) {
          const note = this.noteById(id)
          if (note && note.state !== 'spent') this.touch(note, 'spent')
        }
        for (const output of staged) {
          try {
            const info = await fetchNoteInfo(buildNoteUrl(output.baseUrl, output.k1), this.opts)
            output.amountMsat = info.maxWithdrawable
            this.touch(output, 'live')
            events.push({kind: 'output-recovered', detail: `${info.maxWithdrawable} msat at ${output.mintHost}`})
          } catch (err) {
            if (err instanceof NoteSpentError) {
              this.touch(output, 'spent')
            } else if (err instanceof NoteUnknownError) {
              events.push({kind: 'output-missing', detail: `staged note unknown at ${output.mintHost} - kept for another look`})
            }
            // network trouble: keep as is
          }
        }
      }
      // 'unknown': no information, everything holds
    }

    // Melts in flight: LUD-21 verify proves settlement; a staged rotate
    // probe distinguishes "restored" from "still pending" without ever
    // risking the note.
    for (const melt of this.data.melts) {
      if (melt.state !== 'in-flight') continue
      const note = this.noteById(melt.noteId)
      if (!note) continue
      if (melt.verifyUrl) {
        try {
          const verification = await fetchInvoiceVerification(melt.verifyUrl, this.opts)
          if (verification.settled) {
            melt.state = 'settled'
            melt.updatedAt = now()
            if (verification.preimage && verifyPreimage(verification.preimage, melt.paymentHash)) {
              melt.proofPreimage = verification.preimage
            }
            this.touch(note, 'spent')
            events.push({kind: 'melt-settled', detail: `${melt.amountMsat} msat to ${melt.target}`})
            continue
          }
        } catch {
          // fall through to the rotate probe
        }
      }
      try {
        const [rotated] = await this.mutate([note], {kind: 'rotate'})
        // The rotate succeeded: the melt failed and the mint restored the
        // note - now safely under a fresh secret.
        rotated!.origin = 'recovered'
        melt.state = 'returned'
        melt.updatedAt = now()
        await this.persist()
        events.push({kind: 'melt-returned', detail: `${melt.amountMsat} msat back from ${melt.target}`})
      } catch (err) {
        if (err instanceof PendingNoteError) {
          events.push({kind: 'melt-pending', detail: `${melt.amountMsat} msat to ${melt.target} still in flight`})
        } else if (err instanceof NoteSpentError || err instanceof NoteUnknownError || err instanceof ServiceRejectedError) {
          melt.state = 'settled'
          melt.updatedAt = now()
          this.touch(note, 'spent')
          events.push({kind: 'melt-settled', detail: `${melt.amountMsat} msat to ${melt.target} (burn confirmed)`})
        }
        // ambiguous: the staged rotate output holds; the next reconcile
        // resolves it through the group probe above
      }
    }

    // A mint that rotated its signing key and published the old one as
    // retired. Nothing to fix, but the holder should hear it once.
    for (const entry of this.data.mints) {
      if (!entry.keyRotatedAt || entry.keyRotationReported) continue
      entry.keyRotationReported = true
      events.push({
        kind: 'mint-key-rotated',
        detail: `${entry.host} rotated its signing key on ${new Date(entry.keyRotatedAt).toISOString().slice(0, 10)} - the old one is kept, so notes it signed still verify`
      })
    }

    // Notes found by a restore that the mint was holding for something in
    // flight. They replace nothing, so the group probe above has no way to
    // reach them: they are settled by asking the mint directly.
    for (const note of this.data.notes.filter(
      record => record.state === 'ambiguous' && !record.replaces?.length
    )) {
      try {
        const info = await fetchNoteInfo(buildNoteUrl(note.baseUrl, note.k1), this.opts)
        note.amountMsat = info.maxWithdrawable
        if (!note.callback) note.callback = info.callback
        this.touch(note, 'live')
        events.push({kind: 'note-restored', detail: `${note.amountMsat} msat recovered at ${note.mintHost}`})
      } catch (err) {
        if (err instanceof NoteSpentError || err instanceof NoteUnknownError) {
          note.detail = 'found by a restore, but the mint had already burned it'
          this.touch(note, 'spent')
        }
        // still pending, or the mint is quiet: it holds for the next pass
      }
    }

    // Notes taken offline on a signature alone. The person who handed one
    // over still knows its secret, so the first thing a connection is good
    // for is rotating it out from under them.
    for (const note of this.data.notes.filter(record => record.state === 'live' && record.unrotated)) {
      try {
        if (!note.callback) {
          // Taken from a mint this wallet holds no other note of: ask it
          // where its callback is, and take its word on the value while
          // we are there.
          const info = await fetchNoteInfo(buildNoteUrl(note.baseUrl, note.k1), this.opts)
          note.callback = info.callback
          note.amountMsat = info.maxWithdrawable
          note.updatedAt = now()
          await this.persist()
        }
        const [rotated] = await this.mutate([note], {kind: 'rotate'})
        delete rotated!.unrotated
        events.push({
          kind: 'offline-note-rotated',
          detail: `${rotated!.amountMsat} msat taken offline at ${note.mintHost} is now under a fresh secret`
        })
      } catch (err) {
        if (err instanceof NoteSpentError || err instanceof NoteUnknownError) {
          note.detail = 'taken offline, but the mint had already burned it - whoever handed it over spent it first'
          this.touch(note, 'spent')
          events.push({
            kind: 'offline-note-lost',
            detail: `${note.amountMsat} msat taken offline at ${note.mintHost} was already spent`
          })
        }
        // anything else leaves it unrotated, and the next reconcile tries
      }
    }

    await this.persist()
    return events
  }

  // ---- restore from the seed ----

  // Walks a mint's ladder of derived secrets and asks it which are still
  // worth something. This is the whole reason the secrets are derived: a
  // wallet that has lost everything but twelve words and the name of a
  // mint can find its money by asking the mint.
  async restoreFromMint(host: string, options: {gap?: number} = {}): Promise<{found: NoteRecord[]; next: number}> {
    const root = this.noteRoot()
    if (!root) throw new WalletUsageError('This wallet has no recovery words, so there is nothing to restore from.')
    const entry = this.mintEntry(host)
    let baseUrl = entry.baseUrl
    if (!baseUrl) {
      const pay = await fetchPayRequest(entry.payUrl, this.opts)
      if (!pay.withdrawLink) throw new WalletUsageError(`${entry.host} no longer advertises notes.`)
      baseUrl = fromLud17(pay.withdrawLink)
      entry.baseUrl = baseUrl
    }

    const result = await restoreNotes(baseUrl, root, entry.host, {gap: options.gap ?? 20, start: 0}, this.opts)
    const found: NoteRecord[] = []
    for (const restored of result.found) {
      const id = hashK1(restored.k1)
      if (this.data.notes.some(note => note.id === id)) continue
      // A note URL carries no callback, so the mint is asked for one -
      // and for what the note is really worth while it is answering. If
      // it will not say, the record is kept anyway and marked for
      // reconcile to finish: the secret is the money, not the callback.
      let callback = ''
      let amountMsat = restored.amountMsat ?? 0
      try {
        const info = await fetchNoteInfo(buildNoteUrl(baseUrl, restored.k1), this.opts)
        callback = info.callback
        amountMsat = info.maxWithdrawable
      } catch {
        // leave it for reconcile
      }
      const record: NoteRecord = {
        id,
        k1: restored.k1,
        amountMsat,
        baseUrl,
        callback,
        mintHost: entry.host,
        index: restored.index,
        state: restored.state === 'pending' ? 'ambiguous' : 'live',
        origin: 'recovered',
        ...(callback === '' && restored.state === 'live' ? {unrotated: true} : {}),
        createdAt: now(),
        updatedAt: now()
      }
      this.data.notes.push(record)
      found.push(record)
    }
    this.data.counters ??= {}
    this.data.counters[entry.host] = Math.max(this.counterFor(entry.host), result.next)
    await this.persist()
    return {found, next: result.next}
  }

  async restoreAll(options: {gap?: number} = {}): Promise<Array<{host: string; found: NoteRecord[]; error?: string}>> {
    const results: Array<{host: string; found: NoteRecord[]; error?: string}> = []
    for (const entry of [...this.data.mints]) {
      try {
        const {found} = await this.restoreFromMint(entry.host, options)
        results.push({host: entry.host, found})
      } catch (err) {
        results.push({host: entry.host, found: [], error: (err as Error).message})
      }
    }
    return results
  }

  // ---- checking every note against its mint ----

  // Notes the sweep asks about: the ones the wallet is counting as money.
  // Staged, ambiguous and melting records belong to reconcile(), which
  // knows what mutation they came from; asking about them here would
  // second-guess it with less information.
  private checkableNotes(mintHost?: string): NoteRecord[] {
    return this.liveNotes().filter(note => !mintHost || note.mintHost === mintHost)
  }

  // Ask every mint whether the notes this wallet thinks it holds are still
  // there. A note burned out of band - the other copy of a bearer note
  // spent first, a melt whose answer never arrived, a rotate someone else
  // completed - stays listed as money until something asks.
  //
  // This costs nothing in privacy. The mint issued every one of these
  // notes to this wallet and sees each one the moment it is spent; asking
  // after them tells it nothing it does not already hold.
  //
  // A dry run by default: the report is the whole point, and marking money
  // spent is the caller's decision to take with it in front of them.
  async checkNotes(options: {apply?: boolean; mintHost?: string} = {}): Promise<CheckReport> {
    const report: CheckReport = {
      checked: 0,
      spent: [],
      unknown: [],
      pending: [],
      valueChanged: [],
      unreachable: [],
      staleSignature: []
    }

    const byHost = new Map<string, NoteRecord[]>()
    for (const note of this.checkableNotes(options.mintHost)) {
      byHost.set(note.mintHost, [...(byHost.get(note.mintHost) ?? []), note])
    }

    for (const [host, notes] of byHost) {
      // Findings are held per host and only merged if the whole host
      // answered. A mint that goes quiet halfway through has told us
      // nothing about the notes it did not answer for, and a partial
      // sweep must never look like a complete one.
      const found: Omit<CheckReport, 'unreachable' | 'staleSignature'> = {
        checked: 0,
        spent: [],
        unknown: [],
        pending: [],
        valueChanged: []
      }
      // Purely local, and worth knowing whether the mint answers or not:
      // a note still signed by a key this mint has retired.
      for (const note of notes) {
        if (!note.signature) continue
        if (this.verifyAgainstKnownKeys(host, note.k1, note.amountMsat, note.signature).historic) {
          report.staleSignature.push(note)
        }
      }
      let reachable = true
      let next = 0
      const ask = async (): Promise<void> => {
        for (;;) {
          if (!reachable) return
          const note = notes[next++]
          if (!note) return
          try {
            const info = await fetchNoteInfo(buildNoteUrl(note.baseUrl, note.k1), this.opts)
            found.checked += 1
            if (info.maxWithdrawable !== note.amountMsat) {
              found.valueChanged.push({note, amountMsat: info.maxWithdrawable})
            }
          } catch (err) {
            if (err instanceof NoteSpentError) {
              found.checked += 1
              found.spent.push(note)
            } else if (err instanceof NoteUnknownError) {
              found.checked += 1
              found.unknown.push(note)
            } else if (err instanceof PendingNoteError || (err instanceof ServiceRejectedError && /pending/i.test(err.reason))) {
              found.checked += 1
              found.pending.push(note)
            } else if (err instanceof ServiceRejectedError) {
              // A refusal that names no outcome we understand. Counted as
              // asked, but nothing is concluded from it.
              found.checked += 1
            } else {
              // A timeout, a dropped socket, a mint answering rubbish: no
              // information about any note here.
              reachable = false
            }
          }
        }
      }
      await Promise.all(Array.from({length: CHECK_CONCURRENCY}, () => ask()))
      if (!reachable) {
        report.unreachable.push(host)
        continue
      }
      report.checked += found.checked
      report.spent.push(...found.spent)
      report.unknown.push(...found.unknown)
      report.pending.push(...found.pending)
      report.valueChanged.push(...found.valueChanged)
    }

    if (options.apply) {
      for (const note of report.spent) this.touch(note, 'spent')
      for (const note of report.unknown) {
        // Filed as spent because that is what it is worth, but the reason
        // is kept: "the mint has never heard of this" is not the same
        // story as "somebody spent it", and the holder should read both.
        note.detail = `${note.mintHost} does not know this note`
        this.touch(note, 'spent')
      }
      for (const note of report.pending) this.touch(note, 'ambiguous')
      for (const changed of report.valueChanged) {
        changed.note.amountMsat = changed.amountMsat
        changed.note.updatedAt = now()
      }
      await this.persist()
    }
    return report
  }

  // ---- offline verification ----

  verifyNoteOffline(input: string): {valid: boolean; reason: string} {
    const url = resolveNoteInput(input)
    if (!url) return {valid: false, reason: 'not a note URL'}
    const k1 = noteK1(url)
    const signature = noteSignature(url)
    const amount = noteDeclaredAmount(url)
    if (!k1 || !signature || amount === null) {
      return {valid: false, reason: 'the note carries no k1, signature or amount to verify offline'}
    }
    const host = serverOf(url)
    const pinned = this.data.pubkeyPins[host]
    if (!pinned) return {valid: false, reason: `no pinned mint pubkey for ${host} - receive from it once first`}
    const verdict = this.verifyAgainstKnownKeys(host, k1, amount, signature)
    if (!verdict.valid) {
      return {valid: false, reason: `the signature does not verify against any key ${host} is known to sign with`}
    }
    return {
      valid: true,
      reason: verdict.historic
        ? `signed by a key ${host} has since retired - still good, and a rotate re-signs it under the current one`
        : `signed by the pinned key for ${host}`
    }
  }

  mintUsername(entry: MintEntry): string {
    return lightningAddressUsername(entry.payUrl) ?? 'mint'
  }
}
