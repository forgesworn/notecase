import {
  AmbiguousMintError,
  NoteSpentError,
  NoteUnknownError,
  PendingNoteError,
  ServiceRejectedError,
  applyMintFee,
  buildNoteUrl,
  defaultRandomSecret,
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
  rotateNoteWithHash,
  serverOf,
  splitNoteWithHash,
  fromLud17,
  lightningAddressUsername,
  verifyNoteSignature,
  type LnurlcashOptions,
  type MintFee
} from 'lnurlcash-kit'
import {tryDecodeBolt11} from 'farrier-kit/bolt11'
import {verifyPreimage} from 'farrier-kit/preimage'
import type {MeltRecord, MintEntry, NoteOrigin, NoteRecord, PendingMint, WalletData} from './types.ts'

// The ordering rule this whole module is built around: a fresh secret is
// PERSISTED before its hash goes on the wire, and nothing is deleted until
// the service's answer proves what happened. A crash at any point leaves a
// record reconcile() can resolve; at no point is a disclosed secret held
// only in memory. That is what the kit's *WithHash variants exist for.

export class InsufficientFundsError extends Error {}
export class PinMismatchError extends Error {}
export class WalletUsageError extends Error {}

export type ReceiveResult = {note: NoteRecord; warnings: string[]}

export type ReconcileEvent = {kind: string; detail: string}

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

  balanceByMint(): Map<string, number> {
    const byMint = new Map<string, number>()
    for (const note of this.liveNotes()) {
      byMint.set(note.mintHost, (byMint.get(note.mintHost) ?? 0) + note.amountMsat)
    }
    return byMint
  }

  needsReconcile(): boolean {
    return (
      this.data.notes.some(note => note.state === 'staged' || note.state === 'ambiguous' || note.state === 'melting') ||
      this.data.pendingMints.some(pending => pending.state === 'awaiting')
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

  // Trust on first use. A changed key is surfaced hard: it is either a mint
  // rotating its identity or something standing between the wallet and it.
  private pinPubkey(host: string, observed: string | undefined): void {
    if (!observed) return
    const pinned = this.data.pubkeyPins[host]
    if (pinned && pinned !== observed) {
      throw new PinMismatchError(
        `${host} now presents mint pubkey ${observed.slice(0, 16)}… but was pinned to ${pinned.slice(0, 16)}…`
      )
    }
    if (!pinned) this.data.pubkeyPins[host] = observed
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

    const secret = (this.opts.randomSecret ?? defaultRandomSecret)()
    const staged: NoteRecord[] =
      plan.kind === 'split'
        ? [
            this.record(template, secret, plan.amountMsat, 'split', inputIds),
            this.record(template, (this.opts.randomSecret ?? defaultRandomSecret)(), changeMsat, 'change', inputIds)
          ]
        : [this.record(template, secret, mergedMsat, origin, inputIds)]

    // The hashes are about to be disclosed: the secrets go to disk first.
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
      if (err instanceof AmbiguousMintError) {
        // The mutation MAY have landed. The staged secrets are then the
        // only copy of the outputs - everything holds until reconcile.
        for (const note of staged) this.touch(note, 'ambiguous')
        for (const input of inputs) this.touch(input, 'ambiguous')
        await this.persist()
        throw err
      }
      // Definitive refusal or nothing-sent: the mutation did not happen,
      // the staged secrets minted nothing, the inputs are untouched.
      this.data.notes = this.data.notes.filter(note => !staged.includes(note))
      await this.persist()
      throw err
    }
  }

  // ---- receiving ----

  async receive(input: string): Promise<ReceiveResult> {
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
    this.pinPubkey(mintHost, info.mintPubkey)

    const declared = noteDeclaredAmount(url)
    if (declared !== null && declared !== info.maxWithdrawable) {
      warnings.push(
        `the note URL claims ${declared} msat but the mint says ${info.maxWithdrawable} msat - the mint is authoritative`
      )
    }
    const signature = noteSignature(url)
    const pinned = this.data.pubkeyPins[mintHost]
    if (signature && pinned && !verifyNoteSignature(k1, info.maxWithdrawable, signature, pinned)) {
      warnings.push('the offline signature on this note does not verify - provenance is unproven')
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
    const [rotated] = await this.mutate([note], {kind: 'rotate'})
    return rotated!
  }

  // Takes back a handed-over note nobody has claimed yet: receiving our own
  // copy rotates it to a fresh secret, dead to whoever saw the old one. If
  // the recipient DID claim it, the receive fails with spent/unknown and
  // markTaken is the honest resolution.
  async reclaim(note: NoteRecord): Promise<ReceiveResult> {
    if (note.state !== 'sent') throw new WalletUsageError('Only a sent note can be reclaimed.')
    return this.receive(this.noteUrlFor(note))
  }

  // The recipient took the note (or it should simply stop being offered
  // back): out of the sent list, into history.
  async markTaken(note: NoteRecord): Promise<void> {
    if (note.state !== 'sent') throw new WalletUsageError('Only a sent note can be marked taken.')
    this.touch(note, 'spent')
    await this.persist()
  }

  noteUrlFor(note: NoteRecord): string {
    return buildNoteUrl(note.baseUrl, note.k1, note.amountMsat)
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
      expectedNetMsat: fee ? applyMintFee(grossMsat, fee) : grossMsat,
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
    pending.state = 'claimed'
    pending.updatedAt = now()
    await this.persist()
    const result = await this.receive(buildNoteUrl(pending.baseUrl, preimageHex, pending.expectedNetMsat))
    if (result.note.amountMsat !== pending.expectedNetMsat) {
      result.warnings.push(
        `expected ${pending.expectedNetMsat} msat net but the mint credited ${result.note.amountMsat} msat`
      )
    }
    return result
  }

  // Polls LUD-21 verify until the invoice settles, then claims.
  async awaitMint(pending: PendingMint, options: {timeoutMs?: number; intervalMs?: number} = {}): Promise<ReceiveResult | null> {
    if (!pending.verifyUrl) {
      throw new WalletUsageError(
        'This mint offers no LUD-21 verify - pay the invoice, then claim with `notecase receive <baseUrl>?k1=<payment preimage>`.'
      )
    }
    const deadline = now() + (options.timeoutMs ?? 60_000)
    for (;;) {
      const verification = await fetchInvoiceVerification(pending.verifyUrl, this.opts)
      if (verification.settled && verification.preimage) {
        return this.claimMint(pending, verification.preimage)
      }
      if (now() > deadline) return null
      await new Promise(resolve => setTimeout(resolve, options.intervalMs ?? 1_000))
    }
  }

  // ---- melting ----

  async melt(pr: string, target: string, mintHost?: string): Promise<{melt: MeltRecord; ambiguous: boolean}> {
    const decoded = tryDecodeBolt11(pr)
    if (!decoded) throw new WalletUsageError('That is not a decodable BOLT-11 invoice.')
    if (decoded.amountMsats === null) throw new WalletUsageError('Amountless invoices cannot be melted into.')
    const expiresAt = (decoded.timestamp + decoded.expirySeconds) * 1000
    if (expiresAt < now()) throw new WalletUsageError('That invoice has expired.')
    const amountMsat = Number(decoded.amountMsats)
    if (!Number.isSafeInteger(amountMsat)) throw new WalletUsageError('That invoice amount is out of range.')

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

    await this.persist()
    return events
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
    return verifyNoteSignature(k1, amount, signature, pinned)
      ? {valid: true, reason: `signed by the pinned key for ${host}`}
      : {valid: false, reason: 'the signature does not verify against the pinned mint pubkey'}
  }

  mintUsername(entry: MintEntry): string {
    return lightningAddressUsername(entry.payUrl) ?? 'mint'
  }
}
