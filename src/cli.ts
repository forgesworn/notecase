#!/usr/bin/env node
import {parseArgs} from 'node:util'
import {createInterface} from 'node:readline/promises'
import {Writable} from 'node:stream'
import {utf8ToBytes} from '@noble/hashes/utils.js'
import {splitSecret, shareToWords, wordsToShare, reconstructSecret} from '@forgesworn/shamir-words'
import {NoteSpentError, NoteUnknownError, toBech32Lnurl} from 'lnurlcash-kit'
import {initWallet, openWallet, BadMnemonicError, NoWalletError, WrongPinError, seedFromMnemonic, type WalletStore} from './store.ts'
import {Wallet, BadSignatureError, InsufficientFundsError, PinMismatchError, WalletUsageError} from './wallet.ts'
import {createWalletFetch} from './fetchguard.ts'
import {invoiceFromNwc, nwcStatus, payWithNwc} from './nwc.ts'
import {npubOf, poolTransport} from './nostr.ts'
import type {NoteRecord} from './types.ts'

const HELP = `notecase - a case for Lightning bearer notes (LNURLcash, LUD-25)

  notecase init [--insecure-plaintext] [--restore]
  notecase seed
  notecase restore [--mint <host>]
  notecase adopt
  notecase mints add <address|lnurl> [--label <name>]
  notecase mints list
  notecase mints use <host>
  notecase mints info [host]
  notecase balance
  notecase list [--all]
  notecase mint <sats> [--mint <host>] [--manual] [--wait <seconds>]
  notecase receive [note] [--force] [--offline]
  notecase check [--apply] [--resign] [--mint <host>]
  notecase ladder [set <sats,sats,...>] [--copies <n>] [--mint <host>]
  notecase prepare [--apply] [--mint <host>]
  notecase send <sats> [--mint <host>] [--offline] [--overpay]
  notecase send <sats> --to <npub|nip05>
  notecase address | address claim <name> [--mint <host>]
  notecase inbox
  notecase reclaim [id]
  notecase melt <bolt11> [<sats>]
  notecase melt <sats> --to <lightning-address>
  notecase melt <sats> --to-nwc
  notecase transfer <sats> --from <host> --to <host> [--wait <seconds>]
  notecase reconcile
  notecase verify <note>
  notecase nwc set [uri] | nwc status | nwc clear
  notecase nostr init | nostr show | nostr relays [set <url>...]
  notecase heartwood link <bunker://...> | heartwood notes | heartwood collect
  notecase heartwood send <id> --to <npub> | heartwood unlink
  notecase backup export | backup shares [--threshold N --count M] | backup recover-key
  notecase backup nostr on|off|push|pull

Offline mode is asked for, never guessed at: --offline on send and receive
means no call is made to any mint at all. The ladder and prepare commands
keep small notes in the case so an offline payment can be made at all -
a wallet holding one big note cannot pay a small amount without a mint.

Amounts are sats; add --msat for milli-satoshi precision. The PIN is read
from $NOTECASE_PIN or prompted. Omit the argument to receive or nwc set
and you are prompted for it instead - prefer that: whatever goes on the
command line lands in your shell history, and these two are live secrets.
Notes are bearer money: whoever sees a k1 owns it, which is why this tool
never prints one unless you ask it to send.

A transfer moves value between two mints you already hold notes at: the
destination issues an invoice, the source melts a note to pay it, and the
payment preimage becomes the note that lands. Both mints charge for it, so
you always receive less than you send.

Sending to an npub or a NIP-05 address (name@host) seals the note to that
key and leaves it on their inbox relays; they need no wallet yet to be paid. \`inbox\` opens what was sent to
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
      from: {type: 'string'},
      'to-nwc': {type: 'boolean', default: false},
      threshold: {type: 'string'},
      count: {type: 'string'},
      all: {type: 'boolean', default: false},
      apply: {type: 'boolean', default: false},
      force: {type: 'boolean', default: false},
      resign: {type: 'boolean', default: false},
      restore: {type: 'boolean', default: false},
      offline: {type: 'boolean', default: false},
      overpay: {type: 'boolean', default: false},
      copies: {type: 'string'},
      file: {type: 'string'}
    }
  })
  // Publishes the mint list when it has actually changed and the holder
  // asked for that. Quiet on success and on being switched off; a relay
  // refusing is worth one line, because the holder believes they have a
  // backup.
  const pushMintBackupIfDue = async (w: Wallet): Promise<void> => {
    if (!w.mintBackupNeedsPush()) return
    const transport = poolTransport()
    try {
      const result = await w.pushMintBackup(transport)
      if (result.ok.length === 0) {
        console.log('  (mint-list backup: no relay accepted it - run `notecase backup nostr push` later)')
      }
    } catch {
      console.log('  (mint-list backup: could not reach a relay - run `notecase backup nostr push` later)')
    } finally {
      transport.close()
    }
  }

  const [command, ...rest] = positionals
  if (values.help || !command) {
    console.log(HELP)
    return
  }

  if (command === 'init') {
    // Restoring reads the words first: a wrong list should fail before a
    // PIN ceremony, not after it.
    let restoring: string | undefined
    if (values.restore) {
      const words = (await promptHidden('Your twelve recovery words: ')).trim()
      if (!words) throw new WalletUsageError('Give the twelve words to restore from.')
      seedFromMnemonic(words)
      restoring = words
    }
    const store = values['insecure-plaintext']
      ? await initWallet({...(restoring ? {mnemonic: restoring} : {})})
      : await initWallet({pin: await getPin(true), ...(restoring ? {mnemonic: restoring} : {})})
    console.log(
      store.encrypted
        ? 'Wallet created, PIN-locked.'
        : 'Wallet created UNENCRYPTED - anyone who reads the file owns the notes in it.'
    )
    if (restoring) {
      console.log('Restored from your words. Add the mints you used, then `notecase restore`.')
      return
    }
    console.log('\nWrite these twelve words down, on paper, in this order. They are the only')
    console.log('way back to your notes if this device is lost, and they are shown once.\n')
    console.log(`  ${store.mnemonic}\n`)
    console.log('Anyone who reads them can spend everything this wallet ever holds.')
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
          const named = mint.info?.name ? ` "${mint.info.name}"` : ''
          console.log(`${marker} ${mint.host}${named}${mint.label ? ` (${mint.label})` : ''}${pin ? ` pinned ${pin.slice(0, 16)}…` : ''}`)
          // The operator's own words, and marked as unread if the holder
          // has not been shown this one yet.
          if (mint.info?.motd) {
            const unread = mint.info.motd !== mint.motdSeen ? ' (new)' : ''
            console.log(`    notice${unread}: ${mint.info.motd}`)
          }
          if (mint.keyRotatedAt) {
            const retired = wallet.pubkeyHistoryFor(mint.host).length
            console.log(
              `    signing key rotated on ${new Date(mint.keyRotatedAt).toISOString().slice(0, 10)}; ${retired} retired key${retired === 1 ? '' : 's'} kept so older notes still verify`
            )
          }
        }
        if (store.data.mints.length === 0) console.log('No mints yet - `notecase mints add <address>`.')
      } else if (sub === 'use' && arg) {
        wallet.mintEntry(arg)
        store.data.settings.defaultMintHost = arg
        await store.save()
        console.log(`Default mint is now ${arg}.`)
      } else if (sub === 'info') {
        const host = arg ?? store.data.settings.defaultMintHost
        if (!host) throw new WalletUsageError('Which mint? `notecase mints info <host>`.')
        const entry = wallet.mintEntry(host)
        // Re-read rather than print a cache: this is the command you run
        // to find out what a mint is saying NOW.
        const {info} = await wallet.refreshMintInfo(host).catch(() => ({info: entry.info}))
        console.log(`${entry.host}${entry.label ? ` (${entry.label})` : ''}`)
        // Everything below is the mint's own claim about itself. Shown as
        // that, never as something this wallet has checked.
        if (!info || Object.keys(info).length === 0) {
          console.log('  This mint publishes nothing about itself.')
        } else {
          if (info.name) console.log(`  name:        ${info.name}`)
          if (info.description) console.log(`  about:       ${info.description}`)
          if (info.contact?.nostr) console.log(`  nostr:       ${info.contact.nostr}`)
          if (info.contact?.email) console.log(`  email:       ${info.contact.email}`)
          if (info.contact?.url) console.log(`  url:         ${info.contact.url}`)
          if (info.tosUrl) console.log(`  terms:       ${info.tosUrl}`)
          if (info.version) console.log(`  version:     ${info.version}`)
          if (info.motd) console.log(`  notice:      ${info.motd}`)
        }
        const fee = entry.mintFee
        console.log(
          fee
            ? `  mint fee:    ${fee.baseFeeMsat} msat + ${fee.feePpm} ppm`
            : '  mint fee:    none advertised'
        )
        const pinned = store.data.pubkeyPins[entry.host]
        if (pinned) console.log(`  pinned key:  ${pinned}`)
        console.log('\n  All of the above is what the mint says about itself, not something notecase has checked.')
        if (info?.motd) await wallet.markMotdSeen(host)
      } else {
        console.log('mints add <address> | mints list | mints use <host> | mints info [host]')
      }
      // Backing up is worth nothing if it only happens when somebody
      // remembers. A change to the list publishes the list.
      await pushMintBackupIfDue(wallet)
      return
    }

    case 'seed': {
      // The PIN was already given to open the store. Asking again is the
      // point: the words are the whole wallet, and a shoulder is cheap.
      if (store.encrypted && !process.env.NOTECASE_PIN) {
        await openWallet({pin: await getPin()})
      }
      if (!store.data.mnemonic) {
        console.log(
          store.data.seedHex
            ? 'This wallet has a seed but not the words that made it - they cannot be worked back out.'
            : 'This wallet has no recovery words: it was made before they existed. Your notes are only in this file, so keep `notecase backup export` safe.'
        )
        return
      }
      console.log('These twelve words are your wallet. Anyone who reads them owns everything in it.\n')
      console.log(`  ${store.data.mnemonic}\n`)
      console.log('On paper, in this order. Not in a photo, not in a password manager you do not own.')
      return
    }

    case 'restore': {
      if (!wallet.hasSeed()) {
        throw new WalletUsageError('This wallet has no recovery words, so there is nothing to restore from.')
      }
      if (!store.data.mints.length && wallet.mintBackupEnabled()) {
        // Words alone are only enough if the wallet can find out which
        // mints to ask. This is the half that makes seed-only restore work.
        console.log('Looking for a mint list on Nostr\u2026')
        const transport = poolTransport()
        try {
          const pulled = await wallet.pullMintBackup(transport)
          if (pulled.added.length) {
            console.log(`  found ${pulled.added.length} mint(s): ${pulled.added.join(', ')}`)
            if (pulled.pins) console.log(`  and ${pulled.pins} pinned signing key(s)`)
          } else if (pulled.found) {
            console.log('  a backup is there, but it lists no mints.')
          } else {
            console.log('  nothing published under this seed.')
          }
        } finally {
          transport.close()
        }
      }
      if (!store.data.mints.length) {
        throw new WalletUsageError(
          wallet.mintBackupEnabled()
            ? 'No mints known and none published - add the mints you used: `notecase mints add <address>`.'
            : 'Add the mints you used first - `notecase mints add <address>`.'
        )
      }
      const hosts = values.mint ? [values.mint] : store.data.mints.map(mint => mint.host)
      let total = 0
      for (const host of hosts) {
        try {
          const result = await wallet.restoreFromMint(host)
          total += result.found.length
          console.log(
            result.found.length
              ? `${host}: ${result.found.length} note(s), ${sats(result.found.reduce((sum, note) => sum + note.amountMsat, 0))}`
              : `${host}: nothing of yours left there.`
          )
          for (const note of result.found) {
            console.log(`  ${shortId(note)}  ${sats(note.amountMsat)}  index ${note.index}${note.state === 'ambiguous' ? '  (the mint is holding it - `notecase reconcile`)' : ''}`)
          }
        } catch (err) {
          console.log(`${host}: could not be asked - ${(err as Error).message}`)
        }
      }
      if (total) console.log(`\nRestored ${sats(wallet.balanceMsat())} in total. Run \`notecase reconcile\` to finish anything the mints were holding.`)
      return
    }

    case 'adopt': {
      const legacy = wallet.legacyNotes()
      if (!legacy.length) {
        console.log('Every note here is already on your recovery words.')
        return
      }
      console.log(`${legacy.length} note(s) are not covered by your words yet. Rotating them costs nothing.`)
      const result = await wallet.adoptLegacyNotes()
      for (const note of result.adopted) console.log(`  adopted ${sats(note.amountMsat)} (${shortId(note)})`)
      for (const failure of result.failed) console.log(`  ${shortId(failure.note)}: ${failure.reason}`)
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
      const legacy = wallet.legacyNotes()
      if (legacy.length) {
        console.log(
          `${legacy.length} note(s) are not covered by your recovery words - \`notecase adopt\` fixes that for free.`
        )
      }
      const unrotated = wallet.unrotatedMsat()
      if (unrotated > 0) {
        console.log(`of which ${sats(unrotated)} taken offline and not rotated yet - \`notecase reconcile\` fixes that.`)
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
      const result = values.offline
        ? await wallet.receiveOffline(input)
        : await wallet.receive(input, {acceptBadSignature: values.force})
      for (const warning of result.warnings) console.log(`  warning: ${warning}`)
      console.log(`Received ${sats(result.note.amountMsat)} at ${result.note.mintHost} (${shortId(result.note)}).`)
      return
    }

    case 'check': {
      const report = await wallet.checkNotes({apply: values.apply, ...(values.mint ? {mintHost: values.mint} : {})})
      console.log(
        `Checked ${report.checked} note${report.checked === 1 ? '' : 's'} against ${report.checked === 0 ? 'no' : 'their'} mint${values.apply ? '' : ' (nothing changed - add --apply)'}.`
      )
      const lines = (title: string, notes: NoteRecord[]) => {
        if (!notes.length) return
        const total = notes.reduce((sum, note) => sum + note.amountMsat, 0)
        console.log(`  ${title}: ${notes.length} (${sats(total)})`)
        for (const note of notes) console.log(`    ${shortId(note)}  ${sats(note.amountMsat)}  ${note.mintHost}`)
      }
      lines('already spent at the mint', report.spent)
      lines('unknown to the mint', report.unknown)
      lines('locked by something in flight', report.pending)
      for (const changed of report.valueChanged) {
        console.log(
          `  value corrected: ${shortId(changed.note)} ${sats(changed.note.amountMsat)} -> ${sats(changed.amountMsat)} at ${changed.note.mintHost}`
        )
      }
      for (const host of report.unreachable) {
        console.log(`  ${host} did not answer - its notes were left alone.`)
      }
      if (report.staleSignature.length) {
        console.log(
          `  signed by a key the mint has retired: ${report.staleSignature.length}${values.resign ? '' : ' - `notecase check --resign` re-signs them, which costs nothing'}`
        )
        if (values.resign) {
          for (const note of report.staleSignature) {
            try {
              const fresh = await wallet.rotateLive(note)
              console.log(`    re-signed ${shortId(note)} -> ${shortId(fresh)}`)
            } catch (err) {
              console.log(`    ${shortId(note)} could not be re-signed: ${(err as Error).message}`)
            }
          }
        }
      }
      const findings =
        report.spent.length +
        report.unknown.length +
        report.pending.length +
        report.valueChanged.length +
        report.staleSignature.length
      if (findings === 0 && report.unreachable.length === 0) console.log('Everything is where you left it.')
      else if (!values.apply && findings > 0) console.log('Run `notecase check --apply` to write this down.')
      // Asking costs nothing away: the mint issued these notes to this
      // wallet and sees each one spent, so a sweep tells it nothing new.
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
      if (values.offline) {
        // Offline is a promise, never a guess: no wire call is made here
        // at all, which is why it has to be asked for.
        const handed = await wallet.sendOffline(amountMsat, values.mint, {acceptOverpay: values.overpay})
        console.log(
          handed.notes.length === 1
            ? `A bearer note for ${sats(handed.totalMsat)} - whoever sees this owns it:\n`
            : `${handed.notes.length} bearer notes worth ${sats(handed.totalMsat)} together - hand over every one:\n`
        )
        for (const noteUrl of handed.urls) console.log(noteUrl)
        if (handed.overpayMsat > 0) {
          console.log(`\nThat overpays by ${sats(handed.overpayMsat)}: offline, nothing can be split to the exact amount.`)
        }
        if (handed.capped) {
          console.log('\nOnly the largest notes at that mint were considered - there are more than the search looks at.')
        }
        console.log('\nThe recipient takes it with `notecase receive --offline`, on the mint signature alone.')
        console.log('If it is never claimed, `notecase reclaim` takes it back.')
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

    case 'ladder': {
      const [sub, arg] = rest
      const host = values.mint ?? store.data.settings.defaultMintHost
      if (!host) throw new WalletUsageError('No mint configured - `notecase mints add <address>` first.')
      if (sub === 'set') {
        const denominations = (arg ?? '')
          .split(/[\s,]+/)
          .filter(Boolean)
          .map(Number)
        if (!denominations.length || denominations.some(value => !Number.isSafeInteger(value) || value <= 0)) {
          throw new WalletUsageError('Give the denominations in whole sats, e.g. `notecase ladder set 100,500,1000,5000`.')
        }
        const copies = values.copies ? Number(values.copies) : wallet.ladderFor(host).copies
        await wallet.setLadder(host, denominations, copies)
      }
      const {ladder, copies} = wallet.ladderFor(host)
      console.log(`Cash drawer at ${host}: ${copies} each of ${ladder.map(value => `${value} sat`).join(', ')}.`)
      const plan = wallet.ladderPlan(host)
      if (!plan.cut.length && !plan.short.length) {
        console.log('The drawer is full.')
      } else {
        if (plan.cut.length) {
          console.log(`${plan.cut.length} note(s) to cut, costing ${sats(plan.feeMsat)} in split fees - \`notecase prepare --apply\`.`)
        }
        if (plan.short.length) {
          console.log(`${plan.short.length} note(s) cannot be cut: nothing at that mint is big enough.`)
        }
      }
      return
    }

    case 'prepare': {
      const host = values.mint ?? store.data.settings.defaultMintHost
      if (!host) throw new WalletUsageError('No mint configured - `notecase mints add <address>` first.')
      const plan = wallet.ladderPlan(host)
      if (!plan.cut.length) {
        console.log(
          plan.short.length
            ? `Nothing at ${host} is big enough to cut the ${plan.short.length} note(s) the drawer still wants.`
            : `The cash drawer at ${host} is already full.`
        )
        return
      }
      console.log(
        `Cutting ${plan.cut.map(value => sats(value)).join(', ')} at ${host} costs ${sats(plan.feeMsat)} in split fees.`
      )
      if (plan.short.length) {
        console.log(`  ${plan.short.length} more note(s) wanted, but nothing there is big enough to cut them.`)
      }
      if (!values.apply) {
        console.log('Nothing changed - run `notecase prepare --apply` to cut them.')
        return
      }
      const done = await wallet.prepareOffline(host)
      console.log(
        `Cut ${done.made.length} note(s) for ${sats(done.feeMsat)} in fees: ${done.made.map(note => `${sats(note.amountMsat)} (${shortId(note)})`).join(', ')}.`
      )
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
      // A second positional after an invoice is what to send, for an
      // invoice that names no amount of its own. It has no meaning
      // alongside an amount request, which already carries its figure.
      let sendMsat: number | undefined
      if (rest[1] !== undefined) {
        if (target !== 'invoice') {
          throw new WalletUsageError('An amount request takes its figure first - `notecase melt <sats> --to ...`.')
        }
        sendMsat = parseAmountMsat(rest[1], values.msat)
      }
      const {melt, ambiguous} = await wallet.melt(pr, target, values.mint, sendMsat === undefined ? {} : {sendMsat})
      console.log(
        ambiguous
          ? 'The melt may be in flight - `notecase reconcile` will settle what happened.'
          : `Melting ${sats(melt.amountMsat)} to ${target} - OK means in flight, \`notecase reconcile\` confirms.`
      )
      return
    }

    case 'transfer': {
      const grossMsat = parseAmountMsat(rest[0], values.msat)
      if (!values.from || !values.to) {
        throw new WalletUsageError('A transfer needs --from <host> and --to <host>.')
      }
      let waitMs = 300_000
      if (values.wait !== undefined) {
        const seconds = Number(values.wait)
        if (!Number.isFinite(seconds) || seconds <= 0) {
          throw new WalletUsageError('--wait takes a positive number of seconds.')
        }
        waitMs = seconds * 1000
      }
      console.log(`Minting ${sats(grossMsat)} at ${values.to}, paid by melting at ${values.from}\u2026`)
      const moved = await wallet.transfer(grossMsat, values.from, values.to, {timeoutMs: waitMs})
      if (moved.fee) {
        console.log(`  ${values.to} withholds a fee - expect ${sats(moved.pending.expectedNetMsat)} net.`)
      }
      if (moved.ambiguous) {
        console.log(
          'The melt may be in flight - `notecase reconcile` will settle what happened at both ends.'
        )
        return
      }
      if (!moved.result) {
        console.log(
          `\nMelted at ${values.from}, but ${values.to} has not settled yet - \`notecase reconcile\` will claim it once it does.`
        )
        return
      }
      for (const warning of moved.result.warnings) console.log(`  warning: ${warning}`)
      console.log(
        `\nMoved ${sats(moved.melt.amountMsat)} from ${values.from} to ${values.to}, landing ${sats(moved.result.note.amountMsat)} (${shortId(moved.result.note)}).`
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

    case 'address': {
      const [sub, wanted] = rest
      if (sub === 'claim') {
        if (!wanted) throw new WalletUsageError('address claim <name> [--mint <host>]')
        const price = await wallet.namePriceMsat(values.mint)
        if (price === null) {
          throw new WalletUsageError(`${values.mint ?? store.data.settings.defaultMintHost} is not handing out lightning addresses.`)
        }
        console.log(
          price > 0
            ? `Claiming ${wanted} costs ${sats(price)}, paid with a note of that mint.`
            : `Claiming ${wanted} is free at that mint.`
        )
        const claimed = await wallet.registerName({name: wanted, ...(values.mint ? {mintHost: values.mint} : {})})
        console.log(`${claimed.address} is yours. Payments to it arrive as notes sealed to your npub - \`notecase inbox\` opens them.`)
        return
      }
      const address = wallet.lightningAddress()
      console.log(address ?? 'No lightning address yet - `notecase address claim <name>`.')
      return
    }

    case 'inbox': {
      const transport = poolTransport()
      try {
        const result = await wallet.receiveFromNostr(transport)
        for (const r of result.received) {
          for (const warning of r.warnings) console.log(`  warning: ${warning}`)
          console.log(`Received ${sats(r.note.amountMsat)} at ${r.note.mintHost} (${shortId(r.note)})${r.note.receivedFrom ? ` from ${npubOf(r.note.receivedFrom)}` : ''}.`)
          if (r.note.zap) {
            console.log(
              `  zap from ${npubOf(r.note.zap.senderPubkey)}${r.note.zap.content ? `: ${r.note.zap.content}` : ''}`
            )
          }
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
        } else if (sub === 'trust' || sub === 'untrust') {
          if (!arg) throw new WalletUsageError(`heartwood ${sub} <npub|hex|nip05>`)
          if (sub === 'trust') console.log('  hold the device button to trust this sender')
          const result = await wallet.heartwoodTrust(transport, arg, sub === 'untrust')
          console.log(
            result.changed
              ? `${npubOf(result.pubkeyHex)} is ${result.trusted ? 'now trusted: its notes are stored without a hold.' : 'no longer trusted.'}`
              : `${npubOf(result.pubkeyHex)} was already ${result.trusted ? 'trusted' : 'untrusted'}.`
          )
        } else if (sub === 'pair') {
          console.log('  hold the device button to mint a slot for another wallet')
          const result = await wallet.heartwoodPairWallet(transport, arg ?? 'another wallet')
          console.log(`Slot ${result.slotIndex} ("${result.label}"). Paste this into the other wallet once; the secret is one-time:`)
          console.log(result.uri)
        } else if (sub === 'trusted') {
          const trusted = await wallet.heartwoodTrusted(transport)
          if (!trusted.length) console.log('The device trusts no senders; every note needs a hold.')
          for (const pk of trusted) console.log(npubOf(pk))
        } else if (sub === 'inbox') {
          console.log('  hold the device button to sign its inbox list')
          const result = await wallet.publishHeartwoodInbox(transport)
          console.log(`Device inbox (kind 10050) lists ${result.relays.join(', ')}.`)
          if (result.ok.length) console.log(`  published on: ${result.ok.join(', ')}`)
          if (result.failed.length) console.log(`  failed: ${result.failed.join(', ')}`)
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
          console.log('heartwood link <bunker://...> | inbox | notes | collect | send <id> --to <npub> | trust <npub|nip05> | untrust <npub> | trusted | pair [label] | unlink')
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
      if (sub === 'nostr') {
        const action = rest[1]
        if (action === 'on' || action === 'off') {
          // Switching on looks for an existing list first. A wallet
          // restored from words has no mints yet, and that emptiness must
          // not become the backup.
          const lookup = action === 'on' ? poolTransport() : null
          try {
            await wallet.setMintBackup(action === 'on', lookup ?? undefined)
          } finally {
            lookup?.close()
          }
          if (action === 'on' && store.data.mints.length > 0) {
            console.log(`Found a published mint list: ${store.data.mints.map(m => m.host).join(', ')}`)
          }
          if (action === 'off') {
            console.log('Mint-list backup off. Anything already published stays on the relays until it is replaced.')
            return
          }
          console.log(
            `Mint-list backup on, publishing as ${wallet.mintBackupPubkey().slice(0, 16)}\u2026`
          )
          console.log('  Your MINTS and pinned keys go to your relays, encrypted under a key derived')
          console.log('  from your seed. Not your notes, not your balance, and not linked to your npub.')
        }
        if (action === 'on' || action === 'push') {
          if (!wallet.mintBackupEnabled()) {
            throw new WalletUsageError('Mint-list backup is off - `notecase backup nostr on` first.')
          }
          const transport = poolTransport()
          try {
            const result = await wallet.pushMintBackup(transport)
            console.log(
              result.ok.length
                ? `Published to ${result.ok.length} relay(s)${result.failed.length ? `, ${result.failed.length} refused` : ''}.`
                : 'No relay accepted it - nothing is backed up.'
            )
          } finally {
            transport.close()
          }
          return
        }
        if (action === 'pull') {
          if (!wallet.hasSeed()) throw new WalletUsageError('This wallet has no seed to look under.')
          const transport = poolTransport()
          try {
            const pulled = await wallet.pullMintBackup(transport)
            if (!pulled.found) console.log('Nothing published under this seed.')
            else if (!pulled.added.length && !pulled.pins) console.log('Found a backup; everything in it is already here.')
            else {
              if (pulled.added.length) console.log(`Added ${pulled.added.length} mint(s): ${pulled.added.join(', ')}`)
              if (pulled.pins) console.log(`Restored ${pulled.pins} pinned signing key(s).`)
            }
          } finally {
            transport.close()
          }
          return
        }
        if (action !== 'on' && action !== 'off') {
          console.log('backup nostr on | off | push | pull')
        }
        return
      }
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
  if (err instanceof BadMnemonicError) {
    console.error(err.message)
    process.exitCode = 1
    return
  }
  if (err instanceof BadSignatureError) {
    console.error(`Refused: ${err.message}.`)
    console.error('If you are certain this note is good, `notecase receive --force` takes it anyway.')
    process.exitCode = 1
    return
  }
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
