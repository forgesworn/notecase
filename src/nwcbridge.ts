import type {Wallet} from './wallet.ts'
import {InsufficientFundsError, WalletUsageError} from './wallet.ts'
import {NwcPaymentNotSentError, NwcServiceError, type NwcInvoiceView, type NwcServiceWallet} from './nwcservice.ts'
import {tryDecodeBolt11} from 'farrier-kit/bolt11'

// The bearer-note wallet, in the shape NIP-47 expects.
//
// Everything awkward about fronting a mint with a wallet protocol lives
// here rather than in the runtime:
//
//   - make_invoice is a mint quote. The note appears when the invoice is
//     paid, which the serve loop's reconcile pass claims.
//   - pay_invoice is a melt, and a melt returns "in flight", not "paid".
//     NIP-47 promises a preimage and a careful client checks it, so this
//     waits for LUD-21 verify to prove settlement and refuses to answer
//     until it can. A hopeful blank would be a lie the client would catch
//     anyway.
//   - fees_paid is measured, not guessed: what the balance actually lost
//     beyond the invoice amount, which is the mint's split fee on the note
//     that funded it.

export type NwcBridgeOptions = {
  // How long to wait for a melt to prove itself before answering. A melt
  // that has not settled by then is still in flight - the answer is an
  // error, the money is not necessarily lost, and reconcile will finish
  // the story either way.
  proofTimeoutMs?: number
  proofIntervalMs?: number
  mintHost?: string
}

export const walletBridge = (wallet: Wallet, options: NwcBridgeOptions = {}): NwcServiceWallet => ({
  alias: () => wallet.data.settings.lightningAddress ?? 'notecase',

  balanceMsat: () => wallet.balanceMsat(),

  async makeInvoice({amountMsat, description}) {
    let pending
    try {
      pending = (await wallet.startMint(amountMsat, options.mintHost)).pending
    } catch (err) {
      throw new NwcServiceError('OTHER', (err as Error).message)
    }
    const decoded = tryDecodeBolt11(pending.pr)
    const view: NwcInvoiceView = {
      type: 'incoming',
      invoice: pending.pr,
      paymentHash: pending.id,
      amountMsat: pending.grossMsat,
      createdAt: Math.floor(pending.createdAt / 1000),
      ...(description === undefined ? {} : {description}),
      ...(decoded
        ? {expiresAt: decoded.timestamp + decoded.expirySeconds}
        : {})
    }
    return view
  },

  async payInvoice({invoice, amountMsat}) {
    const before = wallet.balanceMsat()
    const decoded = tryDecodeBolt11(invoice)
    const sendMsat = decoded && decoded.amountMsats === null ? amountMsat : undefined
    let melt
    let ambiguous
    try {
      const result = await wallet.melt(invoice, 'nwc', options.mintHost, {
        ...(sendMsat === undefined ? {} : {sendMsat})
      })
      melt = result.melt
      ambiguous = result.ambiguous
    } catch (err) {
      // These two are refusals: the wallet decided not to try, so nothing
      // left and the budget goes back. Anything else might have moved.
      if (err instanceof WalletUsageError || err instanceof InsufficientFundsError) {
        throw new NwcPaymentNotSentError((err as Error).message)
      }
      throw new NwcServiceError('PAYMENT_FAILED', (err as Error).message)
    }
    if (ambiguous) {
      throw new NwcServiceError(
        'OTHER',
        'The melt may be in flight and could not be confirmed - reconcile will settle what happened.'
      )
    }
    const proven = await wallet.awaitMeltProof(melt, {
      ...(options.proofTimeoutMs === undefined ? {} : {timeoutMs: options.proofTimeoutMs}),
      ...(options.proofIntervalMs === undefined ? {} : {intervalMs: options.proofIntervalMs})
    })
    if (!proven?.proofPreimage) {
      throw new NwcServiceError(
        'OTHER',
        'The melt is in flight but the mint has not proved it settled yet - reconcile will finish it.'
      )
    }
    const after = wallet.balanceMsat()
    const feesPaidMsat = Math.max(0, before - after - melt.amountMsat)
    return {preimage: proven.proofPreimage, feesPaidMsat}
  },

  async lookupInvoice({paymentHash, invoice}) {
    const pending = wallet.data.pendingMints.find(
      record => (paymentHash && record.id === paymentHash) || (invoice && record.pr === invoice)
    )
    if (pending) {
      const decoded = tryDecodeBolt11(pending.pr)
      const note = wallet.noteById(pending.id)
      return {
        type: 'incoming',
        invoice: pending.pr,
        paymentHash: pending.id,
        amountMsat: pending.grossMsat,
        createdAt: Math.floor(pending.createdAt / 1000),
        ...(decoded ? {expiresAt: decoded.timestamp + decoded.expirySeconds} : {}),
        ...(pending.state === 'claimed'
          ? {settledAt: Math.floor(pending.updatedAt / 1000), ...(note ? {amountMsat: note.amountMsat} : {})}
          : {})
      } satisfies NwcInvoiceView
    }
    const melt = wallet.data.melts.find(
      record => (paymentHash && record.paymentHash === paymentHash) || (invoice && record.pr === invoice)
    )
    if (!melt) return null
    return {
      type: 'outgoing',
      invoice: melt.pr,
      paymentHash: melt.paymentHash,
      amountMsat: melt.amountMsat,
      createdAt: Math.floor(melt.createdAt / 1000),
      ...(melt.state === 'settled' ? {settledAt: Math.floor(melt.updatedAt / 1000)} : {}),
      ...(melt.proofPreimage === undefined ? {} : {preimage: melt.proofPreimage})
    } satisfies NwcInvoiceView
  }
})
