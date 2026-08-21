#!/usr/bin/env node
import {parseArgs} from 'node:util'
import {createInterface} from 'node:readline/promises'
import {Writable} from 'node:stream'
import {utf8ToBytes} from '@noble/hashes/utils.js'
import {splitSecret, shareToWords, wordsToShare, reconstructSecret} from '@forgesworn/shamir-words'
import {NoteSpentError, NoteUnknownError, toBech32Lnurl} from 'lnurlcash-kit'
import {initWallet, openWallet, NoWalletError, WrongPinError, type WalletStore} from './store.ts'
import {Wallet, InsufficientFundsError, PinMismatchError, WalletUsageError} from './wallet.ts'
import {createWalletFetch} from './fetchguard.ts'
import {invoiceFromNwc, nwcStatus, payWithNwc} from './nwc.ts'
import {npubOf, poolTransport} from './nostr.ts'
import type {NoteRecord} from './types.ts'

const HELP = `notecase - a case for Lightning bearer notes (LNURLcash, LUD-25)

  notecase init [--insecure-plaintext]
  notecase mints add <address|lnurl> [--label <name>]
  notecase mints list
  notecase mints use <host>
  notecase balance
  notecase list [--all]
  notecase mint <sats> [--mint <host>] [--manual] [--wait <seconds>]
  notecase receive [note]
  notecase send <sats> [--mint <host>]
  notecase send <sats> --to <npub>
  notecase inbox
  notecase reclaim [id]
  notecase melt <bolt11>
  notecase melt <sats> --to <lightning-address>
  notecase melt <sats> --to-nwc
  notecase reconcile
  notecase verify <note>
  notecase nwc set [uri] | nwc status | nwc clear
  notecase nostr init | nostr show | nostr relays [set <url>...]
  notecase heartwood link <bunker://...> | heartwood notes | heartwood collect
  notecase heartwood send <id> --to <npub> | heartwood unlink
  notecase backup export | backup shares [--threshold N --count M] | backup recover-key

Amounts are sats; add --msat for milli-satoshi precision. The PIN is read
from $NOTECASE_PIN or prompted. Omit the argument to receive or nwc set
and you are prompted for it instead - prefer that: whatever goes on the
command line lands in your shell history, and these two are live secrets.
Notes are bearer money: whoever sees a k1 owns it, which is why this tool
never prints one unless you ask it to send.

Sending to an npub seals the note to that key and leaves it on their inbox
relays; they need no wallet yet to be paid. \`inbox\` opens what was sent to
you and claims it at once, which burns the copy on the relay.`

const sats = (msat: number): string =>
  msat % 1000 === 0 ? `${msat / 1000} sat` : `${(msat / 1000).toFixed(3)} sat`

const shortId = (note: NoteRecord): string => note.id.slice(0, 8)

const promptHidden = async (question: string): Promise<string> => {
  if (!process.stdin.isTTY) {
    const rl = createInterface({input: process.stdin})
    const answer = await rl.question('')
    rl.close()
    return answer
  }
  let muted = false
  const muteable = new Writable({
    write(chunk: Buffer, _enc, callback) {
      if (!muted) process.stdout.write(chunk)
      callback()
    }
  })
  const rl = createInterface({input: process.stdin, output: muteable, terminal: true})
  process.stdout.write(question)
  muted = true
  const answer = await rl.question('')
  muted = false
  rl.close()
  process.stdout.write('\n')
  return answer
}

const getPin = async (confirm = false): Promise<string> => {
  if (process.env.NOTECASE_PIN) return process.env.NOTECASE_PIN
  const pin = await promptHidden('PIN: ')
  if (!pin) throw new WalletUsageError('An empty PIN is not a PIN.')
  if (confirm) {
    const again = await promptHidden('PIN again: ')
    if (again !== pin) throw new WalletUsageError('The PINs did not match.')
  }
  return pin
}

const parseAmountMsat = (value: string | undefined, msatFlag: boolean): number => {
  if (!value || !/^\d+$/.test(value)) throw new WalletUsageError('Give an amount as a whole number.')
  const amount = Number(value)
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new WalletUsageError('That amount is out of range.')
  return msatFlag ? amount : amount * 1000
}

const openStore = async (): Promise<WalletStore> => {
  try {
    return await openWallet({})
  } catch (err) {
    if (err instanceof WrongPinError) {
      return openWallet({pin: await getPin()})
    }
    throw err
  }
}

const main = async (): Promise<void> => {
  const {values, positionals} = parseArgs({
    allowPositionals: true,
    options: {
      help: {type: 'boolean', default: false},
      'insecure-plaintext': {type: 'boolean', default: false},
      label: {type: 'string'},
      mint: {type: 'string'},
      manual: {type: 'boolean', default: false},
      wait: {type: 'string'},
      msat: {type: 'boolean', default: false},
      to: {type: 'string'},
      'to-nwc': {type: 'boolean', default: false},
      threshold: {type: 'string'},
      count: {type: 'string'},
      all: {type: 'boolean', default: false},
      file: {type: 'string'}
    }
  })
  const [command, ...rest] = positionals
  if (values.help || !command) {
    console.log(HELP)
    return
  }

  if (command === 'init') {
    const store = values['insecure-plaintext']
      ? await initWallet({})
      : await initWallet({pin: await getPin(true)})
    console.log(
      store.encrypted
        ? 'Wallet created, PIN-locked. Consider `notecase backup shares` once it holds real value.'
        : 'Wallet created UNENCRYPTED - anyone who reads the file owns the notes in it.'
    )
    return
  }

  const store = await openStore()
  const wallet = new Wallet(store.data, store.save, {fetch: createWalletFetch()})
  const nwcUri = store.data.settings.nwcUri

  switch (command) {
    case 'mints': {
      const [sub, arg] = rest
      if (sub === 'add' && arg) {
        const entry = await wallet.addMint(arg, values.label)
        console.log(`Added ${entry.host}${entry.label ? ` (${entry.label})` : ''} - default mint is ${store.data.settings.defaultMintHost}.`)
      } else if (sub === 'list') {
        for (const mint of store.data.mints) {
          const marker = mint.host === store.data.settings.defaultMintHost ? '*' : ' '
          const pin = store.data.pubkeyPins[mint.host]
          console.log(`${marker} ${mint.host}${mint.label ? ` (${mint.label})` : ''}${pin ? ` pinned ${pin.slice(0, 16)}…` : ''}`)
        }
        if (store.data.mints.length === 0) console.log('No mints yet - `notecase mints add <address>`.')
      } else if (sub === 'use' && arg) {
        wallet.mintEntry(arg)
        store.data.settings.defaultMintHost = arg
        await store.save()
        console.log(`Default mint is now ${arg}.`)
      } else {
        console.log('mints add <address> | mints list | mints use <host>')
      }
      return
    }

    case 'balance': {
      const byMint = wallet.balanceByMint()
      if (byMint.size === 0) {
        console.log('0 sat')
      } else {
        for (const [host, msat] of byMint) console.log(`${sats(msat)}  at ${host}`)
        if (byMint.size > 1) console.log(`${sats(wallet.balanceMsat())}  total`)
      }
      if (wallet.needsReconcile()) console.log('Some outcomes are unresolved - run `notecase reconcile`.')
      return
    }

    case 'list': {
      for (const note of store.data.notes) {
        if (!values.all && note.state !== 'live') continue
        console.log(`${shortId(note)}  ${sats(note.amountMsat).padStart(14)}  ${note.state.padEnd(9)}  ${note.mintHost}  (${note.origin})`)
      }
      return
    }

    case 'mint': {
      const grossMsat = parseAmountMsat(rest[0], values.msat)
      const {pending, fee} = await wallet.startMint(grossMsat, values.mint)
      if (fee) console.log(`This mint withholds a fee - expect ${sats(pending.expectedNetMsat)} net for ${sats(grossMsat)} paid.`)
      if (nwcUri && !values.manual) {
        console.log('Paying the mint invoice through the connected NWC wallet…')
        const paid = await payWithNwc(nwcUri, pending.pr, {})
        const result = await wallet.claimMint(pending, paid.preimageHex)
        for (const warning of result.warnings) console.log(`  warning: ${warning}`)
        console.log(`Minted ${sats(result.note.amountMsat)} at ${result.note.mintHost} (${shortId(result.note)}).`)
      } else {
        console.log('Pay this invoice, then the note is claimed automatically:\n')
        console.log(pending.pr)
        let waitMs = 300_000
        if (values.wait !== undefined) {
          const seconds = Number(values.wait)
          if (!Number.isFinite(seconds) || seconds <= 0) {
            throw new WalletUsageError('--wait takes a positive number of seconds.')
          }
          waitMs = seconds * 1000
        }
        const result = await wallet.awaitMint(pending, {timeoutMs: waitMs})
        if (!result) {
          console.log('\nNot settled yet - `notecase reconcile` will claim it once paid.')
        } else {
          for (const warning of result.warnings) console.log(`  warning: ${warning}`)
          console.log(`\nMinted ${sats(result.note.amountMsat)} at ${result.note.mintHost} (${shortId(result.note)}).`)
        }
      }
      return
    }

    case 'receive': {
      // Prefer the prompt over argv: a note URL on the command line lands
      // in shell history, and the k1 in it is the money.
      const input = (rest[0] ?? (await promptHidden('Note: '))).trim()
      if (!input) throw new WalletUsageError('Give the note to receive.')
      const result = await wallet.receive(input)
      for (const warning of result.warnings) console.log(`  warning: ${warning}`)
      console.log(`Received ${sats(result.note.amountMsat)} at ${result.note.mintHost} (${shortId(result.note)}).`)
      return
    }

    case 'send': {
      const amountMsat = parseAmountMsat(rest[0], values.msat)
      if (values.to) {
        const transport = poolTransport()
        try {
          const sent = await wallet.sendToNostr(transport, amountMsat, values.to, values.mint)
          console.log(`Sent ${sats(sent.note.amountMsat)} to ${npubOf(sent.recipientHex)} (${shortId(sent.note)}).`)
          if (!sent.inboxKnown) {
            console.log('  warning: they publish no inbox relays (kind 10050) - the wrap went to your relays and they may not look there.')
          }
          if (sent.relays.length) console.log(`  on: ${sent.relays.join(', ')}`)
          if (sent.failed.length) console.log(`  failed: ${sent.failed.join(', ')}`)
          if (!sent.relays.length) console.log('  No relay took it. The note is still yours: `notecase reclaim` takes it back.')
          else console.log('  If they never claim it, `notecase reclaim` rotates it back to you.')
        } finally {
          transport.close()
        }
        return
      }
      const note = await wallet.send(amountMsat, values.mint)
      const url = wallet.noteUrlFor(note)
      console.log(`A bearer note for ${sats(note.amountMsat)} - whoever sees this owns it:\n`)
      console.log(url)
      console.log(`\n${toBech32Lnurl(url)}`)
      console.log('\nIf it is never claimed, `notecase receive` with the URL above takes it back.')
      return
    }

    case 'melt': {
      const first = rest[0]
      if (!first) throw new WalletUsageError('Give a bolt11 invoice, or an amount with --to/--to-nwc.')
      let pr: string
      let target: string
      if (/^\d+$/.test(first)) {
        const amountMsat = parseAmountMsat(first, values.msat)
        if (values.to) {
          const {resolveLnurlPay} = await import('farrier-kit/lnurl')
          const resolved = await resolveLnurlPay({
            address: values.to,
            amountMsats: BigInt(amountMsat),
            fetchImpl: createWalletFetch()
          })
          pr = resolved.bolt11
          target = values.to
        } else if (values['to-nwc']) {
          if (!nwcUri) throw new WalletUsageError('No NWC connection - `notecase nwc set <uri>` first.')
          const invoice = await invoiceFromNwc(nwcUri, amountMsat, 'notecase melt')
          pr = invoice.pr
          target = 'nwc'
        } else {
          throw new WalletUsageError('An amount needs --to <address> or --to-nwc.')
        }
      } else {
        pr = first
        target = 'invoice'
      }
      const {melt, ambiguous} = await wallet.melt(pr, target, values.mint)
      console.log(
        ambiguous
          ? 'The melt may be in flight - `notecase reconcile` will settle what happened.'
          : `Melting ${sats(melt.amountMsat)} to ${target} - OK means in flight, \`notecase reconcile\` confirms.`
      )
      return
    }

    case 'reconcile': {
      const events = await wallet.reconcile()
      if (events.length === 0) console.log('Nothing to resolve.')
      for (const event of events) console.log(`${event.kind}: ${event.detail}`)
      return
    }

    case 'verify': {
      if (!rest[0]) throw new WalletUsageError('Give the note to verify.')
      const verdict = wallet.verifyNoteOffline(rest[0])
      console.log(`${verdict.valid ? 'VALID' : 'NOT VERIFIED'} - ${verdict.reason}`)
      process.exitCode = verdict.valid ? 0 : 1
      return
    }

    case 'inbox': {
      const transport = poolTransport()
      try {
        const result = await wallet.receiveFromNostr(transport)
        for (const r of result.received) {
          for (const warning of r.warnings) console.log(`  warning: ${warning}`)
          console.log(`Received ${sats(r.note.amountMsat)} at ${r.note.mintHost} (${shortId(r.note)})${r.note.receivedFrom ? ` from ${npubOf(r.note.receivedFrom)}` : ''}.`)
        }
        for (const s of result.skipped) console.log(`  skipped ${s.wrapId.slice(0, 8)}: ${s.reason}`)
        if (!result.received.length && !result.skipped.length) console.log('Nothing new.')
      } finally {
        transport.close()
      }
      return
    }

    case 'reclaim': {
      const sent = wallet.sentNotes()
      const pick = rest[0] ? sent.filter(n => n.id.startsWith(rest[0]!)) : sent
      if (!pick.length) throw new WalletUsageError(rest[0] ? 'No sent note with that id.' : 'Nothing is out on loan.')
      for (const note of pick) {
        try {
          const back = await wallet.reclaim(note)
          console.log(`Reclaimed ${sats(back.note.amountMsat)} (${shortId(note)} -> ${shortId(back.note)}).`)
        } catch (err) {
          // Only the mint saying "gone" settles it; a network failure
          // leaves the note on loan for the next try.
          if (err instanceof NoteSpentError || err instanceof NoteUnknownError) {
            await wallet.markTaken(note)
            console.log(`${shortId(note)} was claimed by the recipient; marked taken.`)
          } else {
            console.log(`${shortId(note)} could not be reclaimed right now: ${(err as Error).message}`)
          }
        }
      }
      return
    }

    case 'nostr': {
      const [sub, ...args] = rest
      if (sub === 'init' || sub === 'show') {
        const identity = await wallet.ensureNostrIdentity()
        console.log(`npub:   ${identity.npub}`)
        console.log(`relays: ${wallet.nostrRelays().join(', ')}`)
        if (sub === 'init') {
          const transport = poolTransport()
          try {
            const published = await wallet.publishInbox(transport)
            console.log(`inbox list published to ${published.ok.length} relay(s)${published.failed.length ? `, failed: ${published.failed.join(', ')}` : ''}.`)
          } finally {
            transport.close()
          }
        }
      } else if (sub === 'relays') {
        if (args[0] === 'set') {
          const relays = args.slice(1).filter(r => /^wss?:\/\//.test(r))
          if (!relays.length) throw new WalletUsageError('Give one or more wss:// relay URLs.')
          await wallet.setNostrRelays(relays)
          const transport = poolTransport()
          try {
            const published = await wallet.publishInbox(transport)
            console.log(`relays set; inbox list published to ${published.ok.length} relay(s).`)
          } finally {
            transport.close()
          }
        } else {
          console.log(wallet.nostrRelays().join('\n'))
        }
      } else {
        console.log('nostr init | nostr show | nostr relays [set <url>...]')
      }
      return
    }

    case 'heartwood': {
      const [sub, arg] = rest
      const transport = poolTransport()
      try {
        if (sub === 'link') {
          const uri = (arg ?? (await promptHidden('bunker URI: '))).trim()
          const link = await wallet.linkHeartwood(transport, uri)
          console.log(`Linked to ${npubOf(link.devicePubkey)} via ${link.relays.join(', ')}.`)
        } else if (sub === 'unlink') {
          await wallet.unlinkHeartwood()
          console.log('Unlinked.')
        } else if (sub === 'notes') {
          const notes = await wallet.heartwoodNotes(transport)
          if (!notes.length) console.log('The device holds no notes.')
          for (const n of notes) {
            const who = n.from ? ` from ${npubOf(n.from).slice(0, 16)}…` : n.sent_to ? ` sent to ${npubOf(n.sent_to).slice(0, 16)}…` : ''
            console.log(`${n.id}  ${n.state.padEnd(9)} ${sats(n.amount_msat).padStart(12)}  ${n.host}${who}`)
          }
        } else if (sub === 'collect') {
          const result = await wallet.collectFromHeartwood(transport, step => console.log(`  ${step}`))
          for (const r of result.collected) {
            console.log(`Collected ${sats(r.note.amountMsat)} at ${r.note.mintHost} (${shortId(r.note)}).`)
          }
          for (const f of result.failed) console.log(`  ${f.id}: ${f.reason}`)
          if (!result.collected.length && !result.failed.length) console.log('Nothing waiting on the device.')
        } else if (sub === 'send') {
          if (!arg || !values.to) throw new WalletUsageError('heartwood send <id> --to <npub>')
          console.log('  hold the device button to send')
          const sent = await wallet.heartwoodSend(transport, arg, values.to)
          console.log(`Sent ${arg} to ${npubOf(sent.recipientHex)}.`)
          if (!sent.inboxKnown) console.log('  warning: they publish no inbox relays (kind 10050) - the wrap went to your relays.')
          if (sent.relays.length) console.log(`  on: ${sent.relays.join(', ')}`)
          if (sent.failed.length) console.log(`  failed: ${sent.failed.join(', ')}`)
        } else {
          console.log('heartwood link <bunker://...> | notes | collect | send <id> --to <npub> | unlink')
        }
      } finally {
        transport.close()
      }
      return
    }

    case 'nwc': {
      const [sub, uri] = rest
      if (sub === 'set') {
        // Prefer the prompt over argv: the URI is a spending capability and
        // the command line lands in shell history.
        const value = (uri ?? (await promptHidden('NWC connection URI: '))).trim()
        if (!value) throw new WalletUsageError('Give the NWC connection URI.')
        store.data.settings.nwcUri = value
        await store.save()
        console.log('NWC connection stored. It is a spending capability - the wallet file guards it.')
      } else if (sub === 'status') {
        if (!nwcUri) throw new WalletUsageError('No NWC connection configured.')
        const status = await nwcStatus(nwcUri)
        console.log(`methods: ${status.methods.join(', ')}`)
        if (status.balanceMsat !== null) console.log(`balance: ${sats(status.balanceMsat)}`)
        if (status.alias) console.log(`wallet:  ${status.alias}`)
      } else if (sub === 'clear') {
        delete store.data.settings.nwcUri
        await store.save()
        console.log('NWC connection removed.')
      } else {
        console.log('nwc set <uri> | nwc status | nwc clear')
      }
      return
    }

    case 'backup': {
      const [sub] = rest
      if (sub === 'export') {
        const body = JSON.stringify(store.data, null, 2)
        if (values.file) {
          const {writeFileSync} = await import('node:fs')
          writeFileSync(values.file, body, {mode: 0o600})
          console.log(`Exported PLAINTEXT wallet data to ${values.file} - it holds spendable secrets.`)
        } else {
          // stderr, so piped stdout stays clean JSON but the caution is seen
          console.error('Printing PLAINTEXT wallet data - it holds spendable secrets.')
          console.log(body)
        }
      } else if (sub === 'shares') {
        if (!store.storeKey) throw new WalletUsageError('Shares protect the store key - this wallet is unencrypted.')
        const threshold = values.threshold ? Number(values.threshold) : 2
        const count = values.count ? Number(values.count) : 3
        const shares = splitSecret(utf8ToBytes(store.storeKey), threshold, count)
        console.log(`Store-key shares, ${threshold}-of-${count}. Keep them apart; any ${threshold} recover the key:\n`)
        shares.forEach((share, index) => {
          console.log(`share ${index + 1}: ${shareToWords(share).join(' ')}\n`)
        })
        console.log('Recovery also needs the wallet file itself - back that up separately.')
      } else if (sub === 'recover-key') {
        const collected = []
        for (;;) {
          const line = await promptHidden(`share ${collected.length + 1} (empty to finish): `)
          if (!line.trim()) break
          collected.push(wordsToShare(line.trim().split(/\s+/)))
        }
        if (collected.length === 0) throw new WalletUsageError('No shares given.')
        const threshold = collected[0]!.threshold
        const secret = reconstructSecret(collected, threshold)
        console.log(new TextDecoder().decode(Uint8Array.from(secret)))
      } else {
        console.log('backup export [--file <path>] | backup shares [--threshold N --count M] | backup recover-key')
      }
      return
    }

    default:
      console.log(HELP)
      process.exitCode = 2
  }
}

main().catch(err => {
  if (
    err instanceof WalletUsageError ||
    err instanceof InsufficientFundsError ||
    err instanceof PinMismatchError ||
    err instanceof NoWalletError ||
    err instanceof WrongPinError
  ) {
    console.error(err.message)
    process.exitCode = 1
    return
  }
  console.error(`${(err as Error).name ?? 'Error'}: ${(err as Error).message}`)
  process.exitCode = 1
})
