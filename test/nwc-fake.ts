import {finalizeEvent, getPublicKey} from 'nostr-tools/pure'
import * as nip44 from 'nostr-tools/nip44'
import {bytesToHex, randomBytes} from '@noble/hashes/utils.js'
import type {NwcEvent, NwcTransport} from '@forgesworn/nwc-kit'

// A complete NIP-47 wallet service behind an injected transport: real
// keys, real signatures, real NIP-44 v2 - only the relay is imaginary.
// nwc-kit's client verifies every event signature and matches responses to
// requests, so nothing less than the real ceremony would pass, which is
// the point: these tests exercise the same code paths a live wallet would.

export type FakeNwcHandlers = {
  payInvoice?: (params: {invoice: string}) => Promise<{preimage: string; fees_paid?: number}> | {preimage: string; fees_paid?: number}
  makeInvoice?: (params: {amount: number; description?: string}) => Promise<Record<string, unknown>> | Record<string, unknown>
  getBalance?: () => {balance: number}
}

export type FakeNwcWallet = {
  uri: string
  transport: NwcTransport
  requests: Array<{method: string; params: unknown}>
}

export const createFakeNwcWallet = (handlers: FakeNwcHandlers): FakeNwcWallet => {
  const walletSecret = randomBytes(32)
  const walletPubkey = getPublicKey(walletSecret)
  const clientSecretHex = bytesToHex(randomBytes(32))
  const uri = `nostr+walletconnect://${walletPubkey}?relay=${encodeURIComponent('wss://fake.relay.local')}&secret=${clientSecretHex}`

  const methods = ['get_info', 'get_balance', 'pay_invoice', 'make_invoice']
  const nowSec = () => Math.floor(Date.now() / 1000)
  const infoEvent = finalizeEvent(
    {kind: 13194, created_at: nowSec(), tags: [['encryption', 'nip44_v2']], content: methods.join(' ')},
    walletSecret
  ) as NwcEvent

  const subscribers: Array<{onevent: (event: NwcEvent) => void}> = []
  const requests: Array<{method: string; params: unknown}> = []

  const handle = async (method: string, params: any): Promise<Record<string, unknown>> => {
    switch (method) {
      case 'get_info':
        return {alias: 'fake-nwc-wallet', methods, notifications: []}
      case 'get_balance':
        return handlers.getBalance?.() ?? {balance: 0}
      case 'pay_invoice': {
        if (!handlers.payInvoice) throw new Error('NOT_IMPLEMENTED')
        return await handlers.payInvoice(params)
      }
      case 'make_invoice': {
        if (!handlers.makeInvoice) throw new Error('NOT_IMPLEMENTED')
        return await handlers.makeInvoice(params)
      }
      default:
        throw new Error('NOT_IMPLEMENTED')
    }
  }

  const transport: NwcTransport = {
    async query(_relays, filter) {
      return filter.kinds?.includes(13194) ? [infoEvent] : []
    },
    subscribe(_relays, _filter, subscriptionHandlers) {
      const subscriber = {onevent: subscriptionHandlers.onevent}
      subscribers.push(subscriber)
      return {
        close() {
          const index = subscribers.indexOf(subscriber)
          if (index >= 0) subscribers.splice(index, 1)
        }
      }
    },
    async publish(_relays, event) {
      const conversationKey = nip44.v2.utils.getConversationKey(walletSecret, event.pubkey)
      const request = JSON.parse(nip44.v2.decrypt(event.content, conversationKey)) as {method: string; params: unknown}
      requests.push(request)
      let payload: Record<string, unknown>
      try {
        payload = {result_type: request.method, result: await handle(request.method, request.params)}
      } catch (err) {
        payload = {
          result_type: request.method,
          error: {code: 'INTERNAL', message: (err as Error).message}
        }
      }
      const response = finalizeEvent(
        {
          kind: 23195,
          created_at: nowSec(),
          tags: [
            ['p', event.pubkey],
            ['e', event.id]
          ],
          content: nip44.v2.encrypt(JSON.stringify(payload), conversationKey)
        },
        walletSecret
      ) as NwcEvent
      queueMicrotask(() => {
        for (const subscriber of [...subscribers]) subscriber.onevent(response)
      })
      return [{relay: 'wss://fake.relay.local', accepted: true}]
    },
    close() {}
  }

  return {uri, transport, requests}
}
