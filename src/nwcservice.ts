import {finalizeEvent, getPublicKey, verifyEvent, type Event} from 'nostr-tools'
import {nip44} from 'nostr-tools'
import {bytesToHex, hexToBytes} from '@noble/hashes/utils.js'
import {tryDecodeBolt11} from 'farrier-kit/bolt11'
import type {NostrTransport} from './nostr.ts'

// The other end of Nostr Wallet Connect.
//
// nwc.ts is the client: this wallet spending through somebody else's
// Lightning. This is the service: somebody else spending through THIS
// wallet, over NIP-47, without ever seeing a note.
//
// A connection is a capability, and what it is a capability over is cash.
// A bearer note that leaves is gone - no chargeback, no invoice to
// dispute, nobody to ring. So the policy is not a hardening pass to do
// later, it is the feature:
//
//   - the method list is an allowlist, and it defaults to no spending and
//     no balance disclosure. Both are opt-in, per connection.
//   - a connection that may spend MUST carry a budget. There is no
//     unlimited grant to give out by accident.
//   - a request that arrives twice is answered once. Every mutation is
//     idempotent by request id, because a replayed pay_invoice is a second
//     payment and a relay will happily hand you the same event again.
//   - spends on one connection are serialised, so the budget check and the
//     record of what it cost cannot interleave.
//
// The runtime knows nothing about bearer notes. It speaks NIP-47 to a
// `NwcServiceWallet`, which wallet.ts implements - so the same runtime can
// front anything that can invoice and pay.

export const NWC_INFO_KIND = 13194
export const NWC_REQUEST_KIND = 23194
export const NWC_RESPONSE_KIND = 23195

// What a fresh grant may do unless it is told otherwise: look at what it
// is owed and ask to be paid. Neither spends, neither discloses a balance.
export const DEFAULT_METHODS = ['get_info', 'make_invoice', 'lookup_invoice'] as const
// Everything the runtime can answer at all. `pay_invoice` spends;
// `get_balance` tells a stranger how much there is to steal.
export const SUPPORTED_METHODS = [
  'get_info',
  'get_balance',
  'make_invoice',
  'lookup_invoice',
  'pay_invoice'
] as const
export type NwcMethod = (typeof SUPPORTED_METHODS)[number]

export const SPENDING_METHODS: readonly string[] = ['pay_invoice']

// A request older than this is not answered. NIP-47 requests carry their
// own `expiration`, but that is the client's word for it: a relay
// replaying a week-old event must not be able to spend, whatever the event
// says about itself. Slightly generous, because clock skew is real.
const MAX_REQUEST_AGE_SECS = 300
const MAX_REQUEST_FUTURE_SECS = 60

// How many answered request ids a connection remembers. A replay only has
// to be caught while it is still inside MAX_REQUEST_AGE_SECS, so this is
// far more than enough, and it is bounded because it is persisted.
const SEEN_LIMIT = 256

export class NwcServiceError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

// Thrown by a wallet that refused a payment BEFORE anything could leave:
// a bad invoice, an expired one, not enough money. It is the only failure
// that gives the budget back, because it is the only one where the wallet
// knows nothing went out. Anything ambiguous keeps the charge - the same
// rule the mint's own melt follows, for the same reason.
export class NwcPaymentNotSentError extends NwcServiceError {
  constructor(message: string) {
    super('PAYMENT_FAILED', message)
  }
}

// An invoice as NIP-47 describes it. The wallet fills in what it knows;
// absent fields are simply left out rather than sent as null.
export type NwcInvoiceView = {
  type: 'incoming' | 'outgoing'
  invoice: string
  paymentHash: string
  amountMsat: number
  feesPaidMsat?: number
  preimage?: string
  description?: string
  settledAt?: number
  createdAt: number
  expiresAt?: number
}

// What the runtime needs of a wallet. Everything money-related lives
// behind this, so the NIP-47 plumbing can be tested against a wallet that
// does nothing, and a different wallet can be fronted by the same runtime.
export type NwcServiceWallet = {
  alias(): string
  balanceMsat(): number
  makeInvoice(request: {amountMsat: number; description?: string}): Promise<NwcInvoiceView>
  // Pays, and returns the settlement preimage. NIP-47 says a successful
  // pay_invoice carries one, and a careful client (ours included) checks
  // it against the invoice's payment hash - so a wallet that cannot prove
  // settlement must throw rather than answer with a hopeful blank.
  payInvoice(request: {invoice: string; amountMsat: number}): Promise<{preimage: string; feesPaidMsat: number}>
  lookupInvoice(query: {paymentHash?: string; invoice?: string}): Promise<NwcInvoiceView | null>
}

export type NwcConnection = {
  id: string
  name: string
  // This connection's own service identity. One key per connection: two
  // grants share nothing a relay can correlate, and revoking one is
  // deleting a key rather than re-issuing everybody else's.
  serviceSecretHex: string
  servicePubkey: string
  // The secret handed out inside the URI, kept so the URI can be shown
  // again, and the pubkey it implies, which is the only sender whose
  // requests this connection answers.
  clientSecretHex: string
  clientPubkey: string
  relays: string[]
  methods: string[]
  // Only meaningful when a spending method is granted, and then required.
  budgetMsat?: number
  spentMsat: number
  // A ceiling on any single payment, so one bad request cannot spend the
  // whole budget at once.
  maxPaymentMsat?: number
  // Request ids already answered, newest last. The reason a replay is idle.
  seen?: string[]
  createdAt: number
  lastUsedAt?: number
  revokedAt?: number
}

export const connectionUri = (connection: NwcConnection): string => {
  const relays = connection.relays.map(relay => `relay=${encodeURIComponent(relay)}`).join('&')
  return `nostr+walletconnect://${connection.servicePubkey}?${relays}&secret=${connection.clientSecretHex}`
}

export const spendableMethods = (methods: string[]): boolean =>
  methods.some(method => SPENDING_METHODS.includes(method))

// The rules a grant has to pass before it exists, rather than when it is
// first used. A capability nobody can describe is one nobody can revoke.
export const validateGrant = (input: {
  methods: string[]
  budgetMsat?: number
  maxPaymentMsat?: number
  relays: string[]
}): void => {
  if (input.relays.length === 0) throw new NwcServiceError('OTHER', 'A connection needs at least one relay.')
  if (input.methods.length === 0) throw new NwcServiceError('OTHER', 'A connection needs at least one method.')
  for (const method of input.methods) {
    if (!(SUPPORTED_METHODS as readonly string[]).includes(method)) {
      throw new NwcServiceError('NOT_IMPLEMENTED', `This wallet cannot answer ${method}.`)
    }
  }
  if (spendableMethods(input.methods)) {
    if (input.budgetMsat === undefined) {
      throw new NwcServiceError(
        'OTHER',
        'A connection that can spend needs a budget - there is no unlimited grant.'
      )
    }
    if (!Number.isSafeInteger(input.budgetMsat) || input.budgetMsat <= 0) {
      throw new NwcServiceError('OTHER', 'The budget must be a positive integer of milli-satoshis.')
    }
  } else if (input.budgetMsat !== undefined) {
    throw new NwcServiceError('OTHER', 'A budget means nothing on a connection that cannot spend.')
  }
  if (input.maxPaymentMsat !== undefined) {
    if (!Number.isSafeInteger(input.maxPaymentMsat) || input.maxPaymentMsat <= 0) {
      throw new NwcServiceError('OTHER', 'The per-payment ceiling must be a positive integer of milli-satoshis.')
    }
    if (input.budgetMsat !== undefined && input.maxPaymentMsat > input.budgetMsat) {
      throw new NwcServiceError('OTHER', 'The per-payment ceiling is above the whole budget.')
    }
  }
}

export const remainingBudgetMsat = (connection: NwcConnection): number =>
  connection.budgetMsat === undefined ? 0 : Math.max(0, connection.budgetMsat - connection.spentMsat)

// The info event: how a client learns what this connection may do. NIP-47
// makes discovery mandatory, and nwc-kit's own client refuses a service
// that does not advertise NIP-44 v2, which is the right thing to refuse.
export const infoEvent = (connection: NwcConnection): Event =>
  finalizeEvent(
    {
      kind: NWC_INFO_KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['encryption', 'nip44_v2']],
      content: connection.methods.join(' ')
    },
    hexToBytes(connection.serviceSecretHex)
  )

type Answer = {result_type: string; result?: unknown; error?: {code: string; message: string}}

const conversationKey = (connection: NwcConnection): Uint8Array =>
  nip44.getConversationKey(hexToBytes(connection.serviceSecretHex), connection.clientPubkey)

// A response is only ever addressed back to the sender of the request it
// answers, encrypted to that same conversation.
const responseEvent = (connection: NwcConnection, request: Event, answer: Answer): Event =>
  finalizeEvent(
    {
      kind: NWC_RESPONSE_KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ['p', request.pubkey],
        ['e', request.id],
        ['encryption', 'nip44_v2']
      ],
      content: nip44.encrypt(JSON.stringify(answer), conversationKey(connection))
    },
    hexToBytes(connection.serviceSecretHex)
  )

const invoiceResult = (view: NwcInvoiceView): Record<string, unknown> => ({
  type: view.type,
  invoice: view.invoice,
  payment_hash: view.paymentHash,
  amount: view.amountMsat,
  created_at: view.createdAt,
  ...(view.description === undefined ? {} : {description: view.description}),
  ...(view.expiresAt === undefined ? {} : {expires_at: view.expiresAt}),
  ...(view.settledAt === undefined ? {} : {settled_at: view.settledAt}),
  ...(view.preimage === undefined ? {} : {preimage: view.preimage}),
  ...(view.feesPaidMsat === undefined ? {} : {fees_paid: view.feesPaidMsat})
})

export type NwcServiceOptions = {
  wallet: NwcServiceWallet
  transport: NostrTransport
  // Called after anything that changed a connection - a spend recorded, a
  // request id remembered - so the caller can persist. Awaited BEFORE the
  // answer goes out: a budget that was spent must be on disk before the
  // payer is told it worked.
  persist: () => Promise<void>
  log?: (message: string) => void
  now?: () => number
}

// One running service over many connections. Each connection is its own
// subscription under its own key; nothing is shared between them but the
// wallet behind and the budget arithmetic.
export class NwcService {
  private readonly subscriptions = new Map<string, {close(): void}>()
  private readonly queues = new Map<string, Promise<void>>()
  private readonly connections = new Map<string, NwcConnection>()
  private readonly now: () => number
  private readonly opts: NwcServiceOptions

  constructor(opts: NwcServiceOptions) {
    this.opts = opts
    this.now = opts.now ?? (() => Date.now())
  }

  // Publishes the info event and starts listening. Idempotent per
  // connection: serving one already served replaces its subscription
  // rather than doubling it, which is what a re-grant needs.
  async serve(connection: NwcConnection): Promise<void> {
    if (connection.revokedAt) return
    this.stop(connection.id)
    this.connections.set(connection.id, connection)
    await this.opts.transport.publish(connection.relays, infoEvent(connection))
    const since = Math.floor(this.now() / 1000) - MAX_REQUEST_AGE_SECS
    const subscription = this.opts.transport.subscribe(
      connection.relays,
      {kinds: [NWC_REQUEST_KIND], '#p': [connection.servicePubkey], since},
      event => this.enqueue(connection.id, event)
    )
    this.subscriptions.set(connection.id, subscription)
    this.opts.log?.(`serving ${connection.name} on ${connection.relays.join(', ')}`)
  }

  stop(connectionId: string): void {
    this.subscriptions.get(connectionId)?.close()
    this.subscriptions.delete(connectionId)
    this.connections.delete(connectionId)
  }

  close(): void {
    for (const id of [...this.subscriptions.keys()]) this.stop(id)
  }

  // Every request on one connection runs after the last one has finished.
  // Two pay_invoice requests arriving together must not both read the same
  // remaining budget and both decide there is room.
  private enqueue(connectionId: string, event: Event): void {
    const previous = this.queues.get(connectionId) ?? Promise.resolve()
    const next = previous
      .then(() => this.handle(connectionId, event))
      .catch(err => this.opts.log?.(`request failed: ${(err as Error).message}`))
    this.queues.set(connectionId, next)
  }

  private async handle(connectionId: string, event: Event): Promise<void> {
    const connection = this.connections.get(connectionId)
    if (!connection || connection.revokedAt) return

    // Anyone can publish an event tagged at this pubkey - it is in the
    // info event, which is public. What actually keeps a stranger out is
    // further down: the conversation key is derived from THIS connection's
    // client pubkey, so NIP-44 cannot open anything anyone else sealed.
    // This comparison is only the cheap rejection of noise before the
    // expensive one.
    if (event.pubkey !== connection.clientPubkey) return
    if (!verifyEvent(event)) return

    const seconds = Math.floor(this.now() / 1000)
    if (event.created_at < seconds - MAX_REQUEST_AGE_SECS) return
    if (event.created_at > seconds + MAX_REQUEST_FUTURE_SECS) return
    const expiration = event.tags.find(tag => tag[0] === 'expiration')?.[1]
    if (expiration && Number(expiration) < seconds) return

    // The replay gate. It sits before the method runs and, for anything
    // that spends, the id is written down BEFORE the money moves - so a
    // crash mid-payment leaves a request that will not be tried again
    // rather than one that might be paid twice.
    const seen = connection.seen ?? []
    if (seen.includes(event.id)) {
      this.opts.log?.(`ignored a replayed request on ${connection.name}`)
      return
    }

    let request: {method?: unknown; params?: unknown}
    try {
      request = JSON.parse(nip44.decrypt(event.content, conversationKey(connection))) as typeof request
    } catch {
      this.opts.log?.(`could not read a request on ${connection.name}`)
      return
    }
    const method = typeof request.method === 'string' ? request.method : ''
    const params = (request.params ?? {}) as Record<string, unknown>

    const remember = async () => {
      connection.seen = [...seen, event.id].slice(-SEEN_LIMIT)
      connection.lastUsedAt = this.now()
      await this.opts.persist()
    }

    // A spending request is written down before it runs, so a crash
    // between the two leaves a request that will not be tried again rather
    // than one that might be paid twice. Everything else is written down
    // afterwards, where a crash costs only a repeated read.
    const spending = SPENDING_METHODS.includes(method)
    if (spending) await remember()

    let answer: Answer
    try {
      if (!connection.methods.includes(method)) {
        throw new NwcServiceError(
          'RESTRICTED',
          (SUPPORTED_METHODS as readonly string[]).includes(method)
            ? `This connection may not ${method}.`
            : `This wallet cannot answer ${method}.`
        )
      }
      answer = {result_type: method, result: await this.dispatch(connection, method, params)}
    } catch (err) {
      const code = err instanceof NwcServiceError ? err.code : 'INTERNAL'
      const message = (err as Error).message || 'The wallet could not answer that.'
      answer = {result_type: method, error: {code, message}}
      this.opts.log?.(`refused ${method || 'an unnamed method'} on ${connection.name}: ${message}`)
    }
    if (!spending) await remember()
    await this.opts.transport.publish(connection.relays, responseEvent(connection, event, answer))
  }

  private async dispatch(
    connection: NwcConnection,
    method: string,
    params: Record<string, unknown>
  ): Promise<unknown> {
    const wallet = this.opts.wallet
    switch (method) {
      case 'get_info':
        return {
          alias: wallet.alias(),
          // A bearer note is Lightning value at a mint, so the network is
          // whatever the mint's node is on; the wallet itself has no node
          // and says so rather than guessing.
          network: 'mainnet',
          methods: connection.methods,
          notifications: []
        }
      case 'get_balance':
        return {balance: wallet.balanceMsat()}
      case 'make_invoice': {
        const amountMsat = Number(params.amount)
        if (!Number.isSafeInteger(amountMsat) || amountMsat <= 0) {
          throw new NwcServiceError('OTHER', 'make_invoice needs an amount in milli-satoshis.')
        }
        const description = typeof params.description === 'string' ? params.description : undefined
        const view = await wallet.makeInvoice({
          amountMsat,
          ...(description === undefined ? {} : {description})
        })
        return invoiceResult(view)
      }
      case 'lookup_invoice': {
        const paymentHash = typeof params.payment_hash === 'string' ? params.payment_hash : undefined
        const invoice = typeof params.invoice === 'string' ? params.invoice : undefined
        if (!paymentHash && !invoice) {
          throw new NwcServiceError('OTHER', 'lookup_invoice needs a payment_hash or an invoice.')
        }
        const view = await wallet.lookupInvoice({
          ...(paymentHash === undefined ? {} : {paymentHash}),
          ...(invoice === undefined ? {} : {invoice})
        })
        if (!view) throw new NwcServiceError('NOT_FOUND', 'No invoice here by that name.')
        return invoiceResult(view)
      }
      case 'pay_invoice': {
        const invoice = typeof params.invoice === 'string' ? params.invoice.trim() : ''
        if (!invoice) throw new NwcServiceError('OTHER', 'pay_invoice needs an invoice.')
        const amountMsat = this.priceOf(invoice, params)
        this.charge(connection, amountMsat)
        // Spent BEFORE the attempt and persisted, so a crash mid-payment
        // leaves a budget that has paid for it. The other order lets one
        // connection spend its grant twice by dying at the right moment.
        connection.spentMsat += amountMsat
        await this.opts.persist()
        try {
          const paid = await wallet.payInvoice({invoice, amountMsat})
          return {preimage: paid.preimage, fees_paid: paid.feesPaidMsat}
        } catch (err) {
          if (err instanceof NwcPaymentNotSentError) {
            connection.spentMsat -= amountMsat
            await this.opts.persist()
          }
          throw err
        }
      }
      default:
        throw new NwcServiceError('NOT_IMPLEMENTED', `This wallet cannot answer ${method}.`)
    }
  }

  // What this payment will cost the budget, read off the invoice itself
  // rather than taken from the request. A budget checked against a figure
  // the payer supplied is not a budget.
  private priceOf(invoice: string, params: Record<string, unknown>): number {
    const decoded = tryDecodeBolt11(invoice)
    if (!decoded) throw new NwcPaymentNotSentError('That is not a decodable BOLT-11 invoice.')
    const asked = params.amount === undefined ? undefined : Number(params.amount)
    if (asked !== undefined && (!Number.isSafeInteger(asked) || asked <= 0)) {
      throw new NwcPaymentNotSentError('That amount is not a whole number of milli-satoshis.')
    }
    if (decoded.amountMsats !== null) {
      const stated = Number(decoded.amountMsats)
      // NIP-47 lets a caller name the amount alongside the invoice. It may
      // agree with the invoice or be absent; it may not overrule it.
      if (asked !== undefined && asked !== stated) {
        throw new NwcPaymentNotSentError(
          `That invoice is for ${stated} msat, not the ${asked} msat asked for.`
        )
      }
      return stated
    }
    if (asked === undefined) {
      throw new NwcPaymentNotSentError('That invoice states no amount - say how much to send.')
    }
    return asked
  }

  // The budget gate. Refuses before anything is attempted, and says which
  // ceiling it hit: a payer told only "no" tries again.
  private charge(connection: NwcConnection, amountMsat: number): void {
    if (connection.budgetMsat === undefined) {
      throw new NwcServiceError('RESTRICTED', 'This connection has no budget to spend from.')
    }
    if (connection.maxPaymentMsat !== undefined && amountMsat > connection.maxPaymentMsat) {
      throw new NwcServiceError(
        'QUOTA_EXCEEDED',
        `That is ${amountMsat} msat and this connection's ceiling for one payment is ${connection.maxPaymentMsat} msat.`
      )
    }
    const remaining = remainingBudgetMsat(connection)
    if (amountMsat > remaining) {
      throw new NwcServiceError(
        'QUOTA_EXCEEDED',
        `That is ${amountMsat} msat and this connection has ${remaining} msat of its budget left.`
      )
    }
  }
}

// A fresh grant. The client secret is what goes in the URI and is never
// needed again by anyone but the holder of it.
export const newConnection = (input: {
  name: string
  relays: string[]
  methods?: string[]
  budgetMsat?: number
  maxPaymentMsat?: number
  secrets?: {serviceSecretHex: string; clientSecretHex: string}
  now?: number
}): NwcConnection => {
  const methods = input.methods ?? [...DEFAULT_METHODS]
  validateGrant({
    methods,
    relays: input.relays,
    ...(input.budgetMsat === undefined ? {} : {budgetMsat: input.budgetMsat}),
    ...(input.maxPaymentMsat === undefined ? {} : {maxPaymentMsat: input.maxPaymentMsat})
  })
  const serviceSecretHex = input.secrets?.serviceSecretHex ?? bytesToHex(randomSecret())
  const clientSecretHex = input.secrets?.clientSecretHex ?? bytesToHex(randomSecret())
  return {
    id: bytesToHex(randomSecret()).slice(0, 16),
    name: input.name,
    serviceSecretHex,
    servicePubkey: getPublicKey(hexToBytes(serviceSecretHex)),
    clientSecretHex,
    clientPubkey: getPublicKey(hexToBytes(clientSecretHex)),
    relays: [...new Set(input.relays)],
    methods,
    spentMsat: 0,
    ...(input.budgetMsat === undefined ? {} : {budgetMsat: input.budgetMsat}),
    ...(input.maxPaymentMsat === undefined ? {} : {maxPaymentMsat: input.maxPaymentMsat}),
    createdAt: input.now ?? Date.now()
  }
}

const randomSecret = (): Uint8Array => {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return bytes
}
