import {afterEach, describe, expect, it} from 'vitest'
import {createFakeBackend, createMoneyer, fakeBolt11, type FakeBackend, type Moneyer} from '@forgesworn/moneyer'
import {bolt11PaymentHash} from 'farrier-kit/bolt11'
import {bytesToHex, hexToBytes, randomBytes} from '@noble/hashes/utils.js'
import {sha256} from '@noble/hashes/sha2.js'
import {finalizeEvent, matchFilter, nip44, type Event, type Filter} from 'nostr-tools'
import {NwcClient} from '@forgesworn/nwc-kit'
import type {NwcEvent, NwcFilter, NwcTransport} from '@forgesworn/nwc-kit'
import type {NostrTransport} from '../src/nostr.ts'
import {NwcService, connectionUri, newConnection} from '../src/nwcservice.ts'
import {walletBridge} from '../src/nwcbridge.ts'
import {payWithNwc} from '../src/nwc.ts'
import {makeWallet} from './helpers.ts'

// Somebody else spending through this wallet.
//
// The client in every test here is nwc-kit - the same one notecase uses to
// spend through other people's wallets, which verifies event signatures,
// matches responses to requests and refuses a payment whose preimage does
// not settle the invoice. Nothing less would prove the service works: a
// hand-rolled test client would accept whatever this happens to send.
//
// The wallet behind it is a real moneyer over a fake funding source, so a
// pay_invoice really does melt a real note and really is proved by LUD-21
// verify.

const RELAY = 'wss://relay.test'

// One in-memory relay wearing both faces: the notecase transport the
// service is built on, and the nwc-kit transport the client is built on.
const fakeRelay = () => {
  const stored: Event[] = []
  const live: Array<{filter: Filter; onEvent: (event: Event) => void}> = []
  const deliver = (event: Event) => {
    stored.push(event)
    for (const subscription of [...live]) {
      if (matchFilter(subscription.filter, event)) subscription.onEvent(event)
    }
  }
  const nostr: NostrTransport = {
    query: async (_relays, filter) => stored.filter(event => matchFilter(filter, event)),
    subscribe: (_relays, filter, onEvent) => {
      const entry = {filter, onEvent}
      live.push(entry)
      for (const event of [...stored]) if (matchFilter(filter, event)) onEvent(event)
      return {
        close: () => {
          const index = live.indexOf(entry)
          if (index >= 0) live.splice(index, 1)
        }
      }
    },
    publish: async (relays, event) => {
      deliver(event)
      return {ok: [...relays], failed: []}
    },
    close: () => {}
  }
  const nwc: NwcTransport = {
    query: async (_relays, filter) => stored.filter(event => matchFilter(filter as Filter, event)) as NwcEvent[],
    subscribe: (_relays, filter, handlers) => {
      const subscription = nostr.subscribe([RELAY], filter as Filter, event =>
        handlers.onevent(event as NwcEvent)
      )
      return {close: () => subscription.close()}
    },
    publish: async (relays, event) => {
      deliver(event as Event)
      return [...relays].map(relay => ({relay, accepted: true}))
    },
    close: () => {}
  }
  return {nostr, nwc, stored, deliver}
}

// A raw NIP-47 request, bypassing the client's own idea of what the
// service will answer. A hostile caller does not read the info event
// first, so the gate that matters is the one on this side of the wire.
const ask = async (
  relay: ReturnType<typeof fakeRelay>,
  connection: {serviceSecretHex: string; servicePubkey: string; clientSecretHex: string},
  method: string,
  params: Record<string, unknown> = {}
): Promise<{result_type: string; result?: unknown; error?: {code: string; message: string}}> => {
  const clientSecret = hexToBytes(connection.clientSecretHex)
  const key = nip44.getConversationKey(clientSecret, connection.servicePubkey)
  const request = finalizeEvent(
    {
      kind: 23194,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ['p', connection.servicePubkey],
        ['encryption', 'nip44_v2']
      ],
      content: nip44.encrypt(JSON.stringify({method, params}), key)
    },
    clientSecret
  )
  const answer = new Promise<Event>((resolve, reject) => {
    const timer = setTimeout(() => {
      subscription.close()
      reject(new Error(`no answer to ${method}`))
    }, 5_000)
    const subscription = relay.nostr.subscribe([RELAY], {kinds: [23195], '#e': [request.id]}, event => {
      clearTimeout(timer)
      subscription.close()
      resolve(event)
    })
  })
  relay.deliver(request)
  const event = await answer
  return JSON.parse(nip44.decrypt(event.content, key)) as {result_type: string}
}

let mint: {moneyer: Moneyer; backend: FakeBackend} | null = null
const startMoneyer = async () => {
  const backend = createFakeBackend()
  const moneyer = await createMoneyer(
    {
      host: '127.0.0.1',
      port: 0,
      username: 'mint',
      description: 'an LNURLcash note',
      minSendableMsat: 1000,
      maxSendableMsat: 100_000_000,
      minMintMsat: 1000,
      mintFee: null,
      signingKey: bytesToHex(randomBytes(32)),
      dbPath: ':memory:',
      backend: {kind: 'fake'},
      verify: true,
      maxK1s: 21,
      sunset: false
    },
    {backend, confirmDelaysMs: [0, 10]}
  )
  mint = {moneyer, backend}
  return mint
}
afterEach(async () => {
  await mint?.moneyer.close()
  mint = null
})

// A wallet with money in it, at a real mint.
const fundedWallet = async (amountMsat: number) => {
  const {moneyer, backend} = mint!
  const made = makeWallet()
  await made.wallet.addMint(`mint@${new URL(moneyer.url).host}`)
  const {pending} = await made.wallet.startMint(amountMsat)
  backend.control.settleInvoice(pending.id)
  await made.wallet.awaitMint(pending, {timeoutMs: 5_000, intervalMs: 10})
  return made
}

// An invoice the mint's funding source can pay, whose preimage it will
// hand back through /verify - so a melt into it is provable.
const payableInvoice = (amountMsat: number) => {
  const preimage = bytesToHex(randomBytes(32))
  const paymentHash = bytesToHex(sha256(hexToBytes(preimage)))
  mint!.backend.control.registerPaymentPreimage(paymentHash, preimage)
  return {pr: fakeBolt11({amountMsat, paymentHashHex: paymentHash}), preimage, paymentHash}
}

const serviceFor = async (
  made: ReturnType<typeof makeWallet>,
  relay: ReturnType<typeof fakeRelay>,
  grant: Parameters<(typeof made)['wallet']['grantNwc']>[0]
) => {
  const connection = await made.wallet.grantNwc({relays: [RELAY], ...grant})
  const service = new NwcService({
    wallet: walletBridge(made.wallet, {proofTimeoutMs: 5_000, proofIntervalMs: 10}),
    transport: relay.nostr,
    persist: async () => {}
  })
  await service.serve(connection)
  return {connection, service, uri: connectionUri(connection)}
}

describe('a grant is a capability, and a narrow one by default', () => {
  it('refuses to create one that can spend without a budget', async () => {
    await startMoneyer()
    const made = await fundedWallet(50_000)
    await expect(
      made.wallet.grantNwc({name: 'greedy', relays: [RELAY], methods: ['pay_invoice']})
    ).rejects.toThrow(/no unlimited grant/)
    // and nothing was written down
    expect(made.wallet.nwcGrants()).toHaveLength(0)
  })

  it('hands out neither spending nor the balance unless asked', async () => {
    await startMoneyer()
    const made = await fundedWallet(50_000)
    const relay = fakeRelay()
    const {connection, uri, service} = await serviceFor(made, relay, {name: 'reader'})

    const client = new NwcClient(uri, {transport: relay.nwc})
    const capabilities = await client.connect()
    expect(capabilities.methods).toEqual(['get_info', 'make_invoice', 'lookup_invoice'])
    expect(capabilities.encryptions).toContain('nip44_v2')

    // The client refuses on its own, because the service never advertised
    // either of them.
    await expect(client.getBalance()).rejects.toThrow(/does not advertise get_balance/)
    await expect(client.payInvoice({invoice: payableInvoice(10_000).pr})).rejects.toThrow(
      /does not advertise pay_invoice/
    )

    // A caller who ignores the advertisement and asks anyway is refused by
    // the service itself, which is the gate that actually holds.
    expect(await ask(relay, connection, 'get_balance')).toMatchObject({
      error: {code: 'RESTRICTED', message: 'This connection may not get_balance.'}
    })
    expect(await ask(relay, connection, 'pay_invoice', {invoice: payableInvoice(10_000).pr})).toMatchObject({
      error: {code: 'RESTRICTED'}
    })
    // and a method this wallet has never heard of is named as such
    expect(await ask(relay, connection, 'multi_pay_keysend')).toMatchObject({
      error: {code: 'RESTRICTED', message: 'This wallet cannot answer multi_pay_keysend.'}
    })

    // the refusals cost nothing: the money is exactly where it was
    expect(made.wallet.balanceMsat()).toBe(50_000)
    client.close()
    service.close()
  })
})

describe('being paid through a bearer-note wallet', () => {
  it('issues a mint quote as an invoice, and the note lands when it is paid', async () => {
    const {backend} = await startMoneyer()
    const made = await fundedWallet(21_000)
    const relay = fakeRelay()
    const {uri, service} = await serviceFor(made, relay, {name: 'shop'})

    const client = new NwcClient(uri, {transport: relay.nwc})
    await client.connect()
    const quote = await client.makeInvoice({amount: 30_000, description: 'a coffee'})
    expect(quote.invoice).toMatch(/^lnbc/)
    expect(quote.amount).toBe(30_000)

    // The payer pays it. Nothing has landed in the wallet yet - a quote is
    // not money until the mint says it was paid.
    expect(made.wallet.balanceMsat()).toBe(21_000)
    backend.control.settleInvoice(quote.payment_hash!)
    await made.wallet.reconcile()
    expect(made.wallet.balanceMsat()).toBe(51_000)

    const looked = await client.lookupInvoice({payment_hash: quote.payment_hash!})
    expect(looked.settled_at).toBeGreaterThan(0)
    client.close()
    service.close()
  })
})

describe('spending through a bearer-note wallet', () => {
  it('melts a note and answers with a preimage the payer can check', async () => {
    await startMoneyer()
    const made = await fundedWallet(50_000)
    const relay = fakeRelay()
    const {connection, service, uri} = await serviceFor(made, relay, {
      name: 'agent',
      methods: ['get_info', 'get_balance', 'pay_invoice'],
      budgetMsat: 30_000
    })

    const invoice = payableInvoice(10_000)
    // payWithNwc is notecase's own client: it refuses any preimage that
    // does not settle the invoice, so a passing call here is proof the
    // melt really happened, not that the service said so.
    const paid = await payWithNwc(uri, invoice.pr, {transport: relay.nwc})
    expect(paid.preimageHex).toBe(invoice.preimage)

    expect(connection.spentMsat).toBe(10_000)
    expect(made.wallet.balanceMsat()).toBe(40_000)
    service.close()
  })

  it('stops at the budget, and says which ceiling it hit', async () => {
    await startMoneyer()
    const made = await fundedWallet(50_000)
    const relay = fakeRelay()
    const {connection, service, uri} = await serviceFor(made, relay, {
      name: 'agent',
      methods: ['get_info', 'pay_invoice'],
      budgetMsat: 12_000,
      maxPaymentMsat: 8_000
    })
    const client = new NwcClient(uri, {transport: relay.nwc})
    await client.connect()

    // over the per-payment ceiling
    await expect(client.payInvoice({invoice: payableInvoice(9_000).pr})).rejects.toThrow(/ceiling for one payment/)
    // under it, and it goes through
    const first = payableInvoice(8_000)
    const paid = await client.payInvoice({invoice: first.pr})
    expect(paid.preimage).toBe(first.preimage)
    // now the budget, not the ceiling, is what stops the next one
    await expect(client.payInvoice({invoice: payableInvoice(5_000).pr})).rejects.toThrow(/4000 msat of its budget left/)

    expect(connection.spentMsat).toBe(8_000)
    expect(made.wallet.balanceMsat()).toBe(42_000)
    client.close()
    service.close()
  })

  it('pays once when the same request arrives twice', async () => {
    await startMoneyer()
    const made = await fundedWallet(50_000)
    const relay = fakeRelay()
    const {connection, service, uri} = await serviceFor(made, relay, {
      name: 'agent',
      methods: ['get_info', 'pay_invoice'],
      budgetMsat: 30_000
    })
    const client = new NwcClient(uri, {transport: relay.nwc})
    await client.connect()

    const invoice = payableInvoice(10_000)
    const paid = await client.payInvoice({invoice: invoice.pr})
    expect(paid.preimage).toBe(invoice.preimage)

    // The relay hands the very same signed request back. A wallet that
    // treats it as new pays twice; the money is gone and nobody asked for
    // it. It must be answered exactly once.
    const request = relay.stored.find(event => event.kind === 23194)!
    relay.deliver(request)
    await new Promise(resolve => setTimeout(resolve, 150))

    expect(connection.spentMsat).toBe(10_000)
    expect(made.wallet.balanceMsat()).toBe(40_000)
    expect(made.wallet.data.melts).toHaveLength(1)
    client.close()
    service.close()
  })

  it('writes the request down before the money moves, not after', async () => {
    // The crash window. If a spending request is only remembered once it
    // has finished, a process that dies mid-payment comes back with no
    // record of it - and the client, having had no answer, retries. The id
    // has to be on disk before anything leaves.
    await startMoneyer()
    const made = await fundedWallet(50_000)
    const relay = fakeRelay()
    const connection = await made.wallet.grantNwc({
      name: 'agent',
      relays: [RELAY],
      methods: ['get_info', 'pay_invoice'],
      budgetMsat: 30_000
    })
    let asked = false
    const persisted: string[] = []
    const service = new NwcService({
      wallet: {
        alias: () => 'stuck',
        balanceMsat: () => 50_000,
        makeInvoice: () => Promise.reject(new Error('not here')),
        // never settles: the payment is in flight for the whole test, the
        // way it would be at the moment of a crash
        payInvoice: () => {
          asked = true
          return new Promise(() => {})
        },
        lookupInvoice: async () => null
      },
      transport: relay.nostr,
      persist: async () => {
        persisted.push(JSON.stringify(connection.seen ?? []))
      }
    })
    await service.serve(connection)

    void ask(relay, connection, 'pay_invoice', {invoice: payableInvoice(1_000).pr}).catch(() => {})
    await new Promise(resolve => setTimeout(resolve, 200))

    expect(asked).toBe(true)
    // remembered, and persisted, while the payment is still hanging
    expect(connection.seen).toHaveLength(1)
    expect(persisted[0]).toContain(connection.seen![0])
    service.close()
  })

  it('ignores a request signed by anyone but the holder of the secret', async () => {
    await startMoneyer()
    const made = await fundedWallet(50_000)
    const relay = fakeRelay()
    const {connection, service} = await serviceFor(made, relay, {
      name: 'agent',
      methods: ['get_info', 'pay_invoice'],
      budgetMsat: 30_000
    })

    // A stranger who knows the service pubkey - it is in the info event,
    // which is public - builds a perfectly valid request of their own. It
    // is sealed to the right recipient but under their own key, and NIP-44
    // is authenticated, so the service cannot open it and never answers.
    const stranger = newConnection({name: 'stranger', relays: [RELAY]})
    const forged = {
      ...connection,
      clientSecretHex: stranger.clientSecretHex,
      clientPubkey: stranger.clientPubkey
    }
    const client = new NwcClient(connectionUri(forged), {transport: relay.nwc, requestTimeoutMs: 500})
    await client.connect()
    await expect(client.payInvoice({invoice: payableInvoice(1_000).pr})).rejects.toThrow()
    // not refused - unanswerable. Nothing was published back at all.
    expect(relay.stored.filter(event => event.kind === 23195)).toHaveLength(0)

    expect(connection.spentMsat).toBe(0)
    expect(made.wallet.balanceMsat()).toBe(50_000)
    client.close()
    service.close()
  })

  it('gives the budget back when the wallet refused before anything moved', async () => {
    await startMoneyer()
    const made = await fundedWallet(20_000)
    const relay = fakeRelay()
    const {connection, service, uri} = await serviceFor(made, relay, {
      name: 'agent',
      methods: ['get_info', 'pay_invoice'],
      budgetMsat: 100_000
    })
    const client = new NwcClient(uri, {transport: relay.nwc})
    await client.connect()

    // More than the wallet holds: the melt never starts, so the grant has
    // not spent anything and must not be charged for it.
    await expect(client.payInvoice({invoice: payableInvoice(50_000).pr})).rejects.toThrow()
    expect(connection.spentMsat).toBe(0)
    expect(made.wallet.balanceMsat()).toBe(20_000)
    client.close()
    service.close()
  })

  it('stops answering a revoked grant', async () => {
    await startMoneyer()
    const made = await fundedWallet(50_000)
    const relay = fakeRelay()
    const {connection, service, uri} = await serviceFor(made, relay, {
      name: 'agent',
      methods: ['get_info', 'pay_invoice'],
      budgetMsat: 30_000
    })
    await made.wallet.revokeNwc(connection.id)
    service.stop(connection.id)

    const client = new NwcClient(uri, {transport: relay.nwc, requestTimeoutMs: 300})
    await expect(client.payInvoice({invoice: payableInvoice(1_000).pr})).rejects.toThrow()
    expect(made.wallet.balanceMsat()).toBe(50_000)
    client.close()
    service.close()
  })
})
