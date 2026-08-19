import {NwcClient, type NwcTransport} from '@forgesworn/nwc-kit'
import {tryDecodeBolt11} from 'farrier-kit/bolt11'
import {verifyPreimage} from 'farrier-kit/preimage'

// Nostr Wallet Connect is the wallet's optional Lightning arm: it pays
// mint invoices and issues melt invoices through a connection the user
// already trusts with spending. Every invoice is decoded and checked
// before paying, and every claimed payment is verified against the
// invoice's payment hash - per the nwc-kit security model, a passing call
// is not evidence money moved; the preimage is.

export type NwcOptions = {transport?: NwcTransport}

const withClient = async <T>(uri: string, options: NwcOptions, fn: (client: NwcClient) => Promise<T>): Promise<T> => {
  const client = new NwcClient(uri, options.transport ? {transport: options.transport} : {})
  try {
    return await fn(client)
  } finally {
    client.close()
  }
}

export class NwcPaymentUnprovenError extends Error {}

// Pays `pr` and returns its settlement preimage. For an LNURLcash mint
// invoice that preimage IS the freshly minted note's spend secret, so the
// caller can claim without even polling LUD-21 verify.
export const payWithNwc = async (uri: string, pr: string, options: NwcOptions = {}): Promise<{preimageHex: string; feesPaidMsat: number | null}> => {
  const decoded = tryDecodeBolt11(pr)
  if (!decoded || decoded.amountMsats === null) throw new Error('That invoice is not decodable with an amount.')
  return withClient(uri, options, async client => {
    const capabilities = await client.connect()
    if (!capabilities.methods.includes('pay_invoice')) {
      throw new Error('The connected wallet cannot pay invoices.')
    }
    const result = await client.payInvoice({invoice: pr})
    if (!result.preimage || !verifyPreimage(result.preimage, decoded.paymentHashHex)) {
      throw new NwcPaymentUnprovenError(
        'The wallet claims payment but its preimage does not settle this invoice.'
      )
    }
    return {preimageHex: result.preimage, feesPaidMsat: result.fees_paid ?? null}
  })
}

// Asks the connected wallet for an invoice to melt into, and checks the
// invoice it returns actually is one: decodable, the right amount.
export const invoiceFromNwc = async (
  uri: string,
  amountMsat: number,
  description: string,
  options: NwcOptions = {}
): Promise<{pr: string; paymentHashHex: string}> => {
  return withClient(uri, options, async client => {
    const capabilities = await client.connect()
    if (!capabilities.methods.includes('make_invoice')) {
      throw new Error('The connected wallet cannot issue invoices.')
    }
    const transaction = await client.makeInvoice({amount: amountMsat, description})
    const pr = transaction.invoice
    if (typeof pr !== 'string') throw new Error('The wallet did not return an invoice.')
    const decoded = tryDecodeBolt11(pr)
    if (!decoded) throw new Error('The wallet returned an undecodable invoice.')
    if (decoded.amountMsats !== BigInt(amountMsat)) {
      throw new Error(`The wallet returned an invoice for ${decoded.amountMsats} msat, not ${amountMsat}.`)
    }
    return {pr, paymentHashHex: decoded.paymentHashHex}
  })
}

export const nwcStatus = async (
  uri: string,
  options: NwcOptions = {}
): Promise<{methods: string[]; balanceMsat: number | null; alias: string | null}> => {
  return withClient(uri, options, async client => {
    const capabilities = await client.connect()
    let balanceMsat: number | null = null
    if (capabilities.methods.includes('get_balance')) {
      balanceMsat = (await client.getBalance()).balance
    }
    let alias: string | null = null
    if (capabilities.methods.includes('get_info')) {
      const info = await client.getInfo()
      alias = (info as {alias?: string}).alias ?? null
    }
    return {methods: [...capabilities.methods], balanceMsat, alias}
  })
}
