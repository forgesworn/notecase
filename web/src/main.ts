import './style.css'
import {animate, stagger, utils} from 'animejs'
import {renderSVG} from 'uqr'
import {toBech32Lnurl} from 'lnurlcash-kit'
import {Wallet, WalletUsageError, InsufficientFundsError, PinMismatchError} from '../../src/wallet.ts'
import {payWithNwc, invoiceFromNwc, nwcStatus} from '../../src/nwc.ts'
import type {NoteRecord, PendingMint} from '../../src/types.ts'
import {
  biometricAvailable,
  createBrowserWallet,
  enableBiometric,
  unlockWithBiometric,
  unlockWithPin,
  walletExists,
  type BrowserStore
} from './browser-store.ts'
import {icons} from './icons.ts'

// notecase web - the same Wallet engine the CLI drives, behind an
// icon-first, thumb-sized surface. Nothing here touches protocol logic:
// every rule lives in src/wallet.ts and is shared with the CLI and tests.

const app = document.getElementById('app')!
let store: BrowserStore | null = null
let wallet: Wallet | null = null
let viewEpoch = 0

const WALLET_OPTS = {timeoutMs: 20_000}

// ---------- tiny DOM + motion helpers ----------

const el = (html: string): HTMLElement => {
  const template = document.createElement('template')
  template.innerHTML = html.trim()
  return template.content.firstElementChild as HTMLElement
}

const sats = (msat: number): string => {
  const whole = msat / 1000
  const text = Number.isInteger(whole) ? whole.toLocaleString('en-GB') : whole.toFixed(3)
  return text.replace(/,/g, ' ')
}

const toast = (message: string, kind: 'ok' | 'err' | '' = ''): void => {
  const node = el(`<div class="toast ${kind}"></div>`)
  node.textContent = message
  document.getElementById('toasts')!.append(node)
  animate(node, {opacity: [0, 1], y: [16, 0], duration: 320, ease: 'outCubic'})
  setTimeout(() => {
    animate(node, {opacity: 0, y: 10, duration: 280, ease: 'inCubic', onComplete: () => node.remove()})
  }, 3400)
}

const burst = (host: HTMLElement): void => {
  host.classList.add('burst-host')
  const sparks: HTMLElement[] = []
  for (let i = 0; i < 14; i++) {
    const spark = el('<i class="spark"></i>')
    spark.style.left = '50%'
    spark.style.top = '50%'
    host.append(spark)
    sparks.push(spark)
  }
  animate(sparks, {
    x: () => utils.random(-110, 110),
    y: () => utils.random(-90, 60),
    scale: [1, 0],
    opacity: [1, 0],
    duration: 800,
    delay: stagger(14),
    ease: 'outExpo',
    onComplete: () => sparks.forEach(spark => spark.remove())
  })
}

const show = (build: () => HTMLElement): void => {
  viewEpoch += 1
  app.replaceChildren(build())
  const view = app.firstElementChild as HTMLElement
  animate(view, {opacity: [0, 1], y: [14, 0], duration: 340, ease: 'outCubic'})
  const tiles = view.querySelectorAll('.tile, .note-row')
  if (tiles.length) {
    animate(tiles, {opacity: [0, 1], y: [18, 0], delay: stagger(45), duration: 380, ease: 'outCubic'})
  }
}

const busy = async <T>(button: HTMLButtonElement, work: () => Promise<T>): Promise<T | undefined> => {
  const label = button.innerHTML
  button.disabled = true
  button.innerHTML = `${icons.refresh} <span>Working…</span>`
  button.classList.add('pulse')
  try {
    return await work()
  } catch (err) {
    const message =
      err instanceof WalletUsageError || err instanceof InsufficientFundsError || err instanceof PinMismatchError
        ? err.message
        : (err as Error).message || 'Something went wrong.'
    toast(message, 'err')
    return undefined
  } finally {
    button.disabled = false
    button.classList.remove('pulse')
    button.innerHTML = label
  }
}

const topBar = (title: string, onBack: () => void): HTMLElement => {
  const bar = el(`<div class="top">
    <button class="btn-icon" data-back aria-label="Back">${icons.back}</button>
    <div class="brand">${title}</div>
    <span class="spacer"></span>
  </div>`)
  bar.querySelector('[data-back]')!.addEventListener('click', onBack)
  return bar
}

// ---------- PIN pad ----------

const pinPad = (options: {
  title: string
  subtitle: string
  biometric?: boolean
  onBiometric?: () => void
  onComplete: (pin: string) => Promise<'ok' | 'retry'>
}): HTMLElement => {
  const view = el(`<div class="view pinwrap">
    <div>
      <div class="mark" style="color:var(--gold)">${icons.logo}</div>
      <h1></h1>
      <p></p>
    </div>
    <div class="dots">${'<i></i>'.repeat(6)}</div>
    <div class="pad"></div>
  </div>`)
  view.querySelector('h1')!.textContent = options.title
  view.querySelector('p')!.textContent = options.subtitle
  const dots = [...view.querySelectorAll('.dots i')] as HTMLElement[]
  const pad = view.querySelector('.pad')!
  let entry = ''

  const paint = () => dots.forEach((dot, index) => dot.classList.toggle('on', index < entry.length))

  const press = async (digit: string) => {
    if (entry.length >= 6) return
    entry += digit
    paint()
    if (entry.length === 6) {
      const verdict = await options.onComplete(entry)
      if (verdict === 'retry') {
        animate(view.querySelector('.dots')!, {x: [0, -14, 11, -7, 4, 0], duration: 420, ease: 'inOutQuad'})
        if (navigator.vibrate) navigator.vibrate(80)
        entry = ''
        setTimeout(paint, 200)
      }
    }
  }

  for (const key of ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'bio', '0', 'back']) {
    if (key === 'bio') {
      const button = el(`<button class="soft" aria-label="Unlock with biometrics">${options.biometric ? icons.face : ''}</button>`)
      if (options.biometric) button.addEventListener('click', () => options.onBiometric?.())
      pad.append(button)
    } else if (key === 'back') {
      const button = el(`<button class="soft" aria-label="Delete">${icons.backspace}</button>`)
      button.addEventListener('click', () => {
        entry = entry.slice(0, -1)
        paint()
      })
      pad.append(button)
    } else {
      const button = el(`<button>${key}</button>`)
      button.addEventListener('click', () => press(key))
      pad.append(button)
    }
  }
  return view
}

// ---------- views ----------

const viewSetup = (): void =>
  show(() =>
    pinPad({
      title: 'Welcome to notecase',
      subtitle: 'Choose a 6-digit PIN. It guards the notes on this device.',
      onComplete: async first => {
        show(() =>
          pinPad({
            title: 'Once more',
            subtitle: 'Repeat the PIN to confirm it.',
            onComplete: async second => {
              if (second !== first) {
                toast('The PINs did not match - start again.', 'err')
                setTimeout(viewSetup, 500)
                return 'retry'
              }
              store = await createBrowserWallet(first)
              wallet = new Wallet(store.data, store.save, WALLET_OPTS)
              viewHome()
              toast('Wallet created. Mint or receive your first note.', 'ok')
              return 'ok'
            }
          })
        )
        return 'ok'
      }
    })
  )

const viewLocked = async (): Promise<void> => {
  const canBio = await biometricAvailable().catch(() => false)
  const tryBio = async () => {
    const opened = await unlockWithBiometric().catch(() => null)
    if (opened) {
      store = opened
      wallet = new Wallet(opened.data, opened.save, WALLET_OPTS)
      viewHome()
    }
  }
  show(() =>
    pinPad({
      title: 'notecase',
      subtitle: 'A case for Lightning bearer notes.',
      biometric: canBio,
      onBiometric: tryBio,
      onComplete: async pin => {
        const opened = await unlockWithPin(pin).catch(() => null)
        if (!opened) return 'retry'
        store = opened
        wallet = new Wallet(opened.data, opened.save, WALLET_OPTS)
        viewHome()
        return 'ok'
      }
    })
  )
}

const noteRow = (note: NoteRecord): HTMLElement => {
  const row = el(`<div class="note-row">
    <div class="coin">${icons.note}</div>
    <div class="who"><b></b><small></small></div>
    <div class="amt"></div>
  </div>`)
  row.querySelector('b')!.textContent = note.origin === 'change' ? 'change' : note.origin
  row.querySelector('small')!.textContent = note.mintHost
  row.querySelector('.amt')!.textContent = `${sats(note.amountMsat)} sat`
  return row
}

const viewHome = (): void => {
  const w = wallet!
  show(() => {
    const view = el(`<div class="view">
      <div class="top">
        <div class="brand" style="color:var(--gold)">${icons.logo}<span style="color:var(--ink)">notecase</span></div>
        <span class="spacer"></span>
        <button class="btn-icon" data-settings aria-label="Settings">${icons.settings}</button>
      </div>
      <div class="hero burst-host">
        <div class="amount"><span data-balance>0</span><span class="unit">sat</span></div>
        <div class="sub" data-sub></div>
      </div>
      <div class="actions">
        <button class="tile" data-go="receive">${icons.receive}<b>Receive</b></button>
        <button class="tile" data-go="send">${icons.send}<b>Send</b></button>
        <button class="tile" data-go="mint">${icons.mint}<b>Mint</b></button>
        <button class="tile" data-go="melt">${icons.melt}<b>Melt</b></button>
      </div>
      <div class="section-title">Notes</div>
      <div class="stack" data-notes></div>
    </div>`)

    const balance = w.balanceMsat()
    const counter = {value: 0}
    const balanceEl = view.querySelector('[data-balance]')!
    animate(counter, {
      value: balance / 1000,
      duration: 900,
      ease: 'outExpo',
      onUpdate: () => (balanceEl.textContent = sats(Math.round(counter.value) * 1000))
    })
    balanceEl.textContent = '0'

    const mints = w.balanceByMint()
    view.querySelector('[data-sub]')!.textContent =
      mints.size === 0 ? 'nothing minted yet' : mints.size === 1 ? `at ${[...mints.keys()][0]}` : `across ${mints.size} mints`

    if (w.needsReconcile()) {
      const chip = el(`<button class="chip">${icons.refresh}<span>unresolved outcomes - tap to reconcile</span></button>`)
      chip.addEventListener('click', () =>
        busy(chip as HTMLButtonElement, async () => {
          const events = await w.reconcile()
          events.forEach(event => toast(`${event.kind}: ${event.detail}`, 'ok'))
          if (events.length === 0) toast('Nothing to resolve.')
          viewHome()
        })
      )
      view.querySelector('.hero')!.append(chip)
    }

    const list = view.querySelector('[data-notes]')!
    const live = w.liveNotes().sort((a, b) => b.createdAt - a.createdAt)
    if (live.length === 0) {
      list.append(
        el(`<div class="empty">${icons.note}<br/>No notes yet.<br/>Mint one, or receive one from a friend.</div>`)
      )
    } else {
      live.forEach(note => list.append(noteRow(note)))
    }

    view.querySelector('[data-settings]')!.addEventListener('click', viewSettings)
    view.querySelectorAll<HTMLButtonElement>('[data-go]').forEach(button =>
      button.addEventListener('click', () => {
        const go = button.dataset.go
        if (go === 'receive') viewReceive()
        if (go === 'send') viewSend()
        if (go === 'mint') viewMint()
        if (go === 'melt') viewMelt()
      })
    )
    return view
  })
}

const viewReceive = (): void => {
  const w = wallet!
  show(() => {
    const view = el(`<div class="view"></div>`)
    view.append(topBar('Receive a note', viewHome))
    view.append(
      el(`<div class="stack">
        <div class="field">
          <label>Paste the note you were given</label>
          <textarea data-input placeholder="lnurlw://… or LNURL1…" autocomplete="off" spellcheck="false"></textarea>
        </div>
        <button class="btn btn-ghost" data-paste>${icons.paste}<span>Paste from clipboard</span></button>
        <button class="btn btn-gold" data-receive>${icons.receive}<span>Receive</span></button>
        <p class="warn">Receiving rotates the note to a fresh secret straight away, so whoever sent it can no longer spend it.</p>
      </div>`)
    )
    const input = view.querySelector('textarea')!
    view.querySelector('[data-paste]')!.addEventListener('click', async () => {
      input.value = await navigator.clipboard.readText().catch(() => input.value)
    })
    const receiveButton = view.querySelector('[data-receive]') as HTMLButtonElement
    receiveButton.addEventListener('click', () =>
      busy(receiveButton, async () => {
        const result = await w.receive(input.value.trim())
        result.warnings.forEach(warning => toast(warning, 'err'))
        burst(view.querySelector('.stack')!)
        toast(`Received ${sats(result.note.amountMsat)} sat`, 'ok')
        setTimeout(viewHome, 650)
      })
    )
    return view
  })
}

const qrCard = (text: string): HTMLElement => {
  const card = el('<div class="qr" role="img" aria-label="QR code"></div>')
  card.innerHTML = renderSVG(text, {border: 1})
  return card
}

const viewSend = (): void => {
  const w = wallet!
  show(() => {
    const view = el(`<div class="view"></div>`)
    view.append(topBar('Send', viewHome))
    view.append(
      el(`<div class="stack">
        <div class="amount-input"><input data-amount inputmode="numeric" pattern="[0-9]*" placeholder="0" /><span class="unit">sat</span></div>
        <button class="btn btn-gold" data-cut>${icons.send}<span>Cut a note</span></button>
        <p class="warn">notecase splits or merges your notes to the exact amount, then hands you a fresh bearer note to share.</p>
      </div>`)
    )
    const cut = view.querySelector('[data-cut]') as HTMLButtonElement
    cut.addEventListener('click', () =>
      busy(cut, async () => {
        const amount = Number((view.querySelector('[data-amount]') as HTMLInputElement).value)
        if (!Number.isSafeInteger(amount) || amount <= 0) throw new WalletUsageError('Give an amount in whole sats.')
        const note = await w.send(amount * 1000)
        const url = w.noteUrlFor(note)
        show(() => {
          const done = el('<div class="view"></div>')
          done.append(topBar('Your note', viewHome))
          const body = el(`<div class="stack center">
            <div class="hero burst-host" style="padding:6px 0 0"><div class="amount">${sats(note.amountMsat)}<span class="unit">sat</span></div></div>
            <p class="warn">Whoever sees this note owns it. Show the QR or share the text - once, to one person.</p>
          </div>`)
          body.insertBefore(qrCard(toBech32Lnurl(url)), body.querySelector('p'))
          const copyUrl = el(`<button class="btn">${icons.copy}<span>Copy note URL</span></button>`)
          copyUrl.addEventListener('click', async () => {
            await navigator.clipboard.writeText(url)
            toast('Note URL copied', 'ok')
          })
          const copyLnurl = el(`<button class="btn btn-ghost">${icons.copy}<span>Copy LNURL</span></button>`)
          copyLnurl.addEventListener('click', async () => {
            await navigator.clipboard.writeText(toBech32Lnurl(url))
            toast('LNURL copied', 'ok')
          })
          body.append(copyUrl, copyLnurl)
          done.append(body)
          setTimeout(() => burst(body.querySelector('.hero')!), 350)
          return done
        })
      })
    )
    return view
  })
}

const mintPicker = (w: Wallet): HTMLElement => {
  const hosts = w.data.mints.map(mint => mint.host)
  const picker = el(`<div class="field"><label>Mint</label><select data-mint>${hosts
    .map(host => `<option ${host === w.data.settings.defaultMintHost ? 'selected' : ''}>${host}</option>`)
    .join('')}</select></div>`)
  return picker
}

const viewMint = (): void => {
  const w = wallet!
  if (w.data.mints.length === 0) {
    viewSettings()
    toast('Add a mint first - Settings, then "Add a mint".')
    return
  }
  show(() => {
    const view = el(`<div class="view"></div>`)
    view.append(topBar('Mint notes', viewHome))
    const form = el(`<div class="stack">
      <div class="amount-input"><input data-amount inputmode="numeric" pattern="[0-9]*" placeholder="0" /><span class="unit">sat</span></div>
      <button class="btn btn-gold" data-mintgo>${icons.mint}<span>${w.data.settings.nwcUri ? 'Mint - pay with connected wallet' : 'Create the invoice'}</span></button>
      <p class="warn">Paying the mint's invoice strikes a bearer note; notecase claims and rotates it the moment it settles.</p>
    </div>`)
    form.prepend(mintPicker(w))
    view.append(form)

    const go = form.querySelector('[data-mintgo]') as HTMLButtonElement
    go.addEventListener('click', () =>
      busy(go, async () => {
        const amount = Number((form.querySelector('[data-amount]') as HTMLInputElement).value)
        if (!Number.isSafeInteger(amount) || amount <= 0) throw new WalletUsageError('Give an amount in whole sats.')
        const host = (form.querySelector('[data-mint]') as HTMLSelectElement).value
        const {pending, fee} = await w.startMint(amount * 1000, host)
        if (fee) toast(`This mint withholds a fee - expect ${sats(pending.expectedNetMsat)} sat net.`)
        if (w.data.settings.nwcUri) {
          const paid = await payWithNwc(w.data.settings.nwcUri, pending.pr)
          const result = await w.claimMint(pending, paid.preimageHex)
          result.warnings.forEach(warning => toast(warning, 'err'))
          toast(`Minted ${sats(result.note.amountMsat)} sat`, 'ok')
          viewHome()
        } else {
          viewMintInvoice(pending)
        }
      })
    )
    return view
  })
}

const viewMintInvoice = (pending: PendingMint): void => {
  const w = wallet!
  const epoch = viewEpoch + 1
  show(() => {
    const view = el('<div class="view"></div>')
    view.append(topBar('Pay to mint', viewHome))
    const body = el(`<div class="stack center">
      <p class="pulse" style="color:var(--ink-dim)">Waiting for the payment…</p>
      <p class="warn">Pay this invoice from any Lightning wallet. The note is claimed automatically when it settles.</p>
    </div>`)
    body.prepend(qrCard(pending.pr.toUpperCase()))
    const copy = el(`<button class="btn">${icons.copy}<span>Copy invoice</span></button>`)
    copy.addEventListener('click', async () => {
      await navigator.clipboard.writeText(pending.pr)
      toast('Invoice copied', 'ok')
    })
    body.append(copy)
    view.append(body)
    return view
  })
  void (async () => {
    const result = await w.awaitMint(pending, {timeoutMs: 600_000, intervalMs: 1_800}).catch(() => null)
    if (viewEpoch !== epoch) return
    if (result) {
      result.warnings.forEach(warning => toast(warning, 'err'))
      toast(`Minted ${sats(result.note.amountMsat)} sat`, 'ok')
      viewHome()
    } else {
      toast('Not settled yet - the home screen chip will claim it once paid.')
      viewHome()
    }
  })()
}

const viewMelt = (): void => {
  const w = wallet!
  show(() => {
    const view = el('<div class="view"></div>')
    view.append(topBar('Melt to Lightning', viewHome))
    const hasNwc = Boolean(w.data.settings.nwcUri)
    const body = el(`<div class="stack">
      <div class="seg" role="tablist">
        <button class="on" data-tab="invoice">Invoice</button>
        <button data-tab="address">Address</button>
        ${hasNwc ? '<button data-tab="nwc">My wallet</button>' : ''}
      </div>
      <div data-pane></div>
      <button class="btn btn-gold" data-meltgo>${icons.melt}<span>Melt</span></button>
      <p class="warn">Melting burns a note of exactly the invoice's amount; the mint pays the invoice. OK means in flight - the home chip confirms settlement.</p>
    </div>`)
    view.append(body)

    let tab = 'invoice'
    const pane = body.querySelector('[data-pane]')!
    const paint = () => {
      body.querySelectorAll('[data-tab]').forEach(button =>
        button.classList.toggle('on', (button as HTMLElement).dataset.tab === tab)
      )
      if (tab === 'invoice') {
        pane.replaceChildren(
          el(`<div class="field"><label>BOLT-11 invoice</label><textarea data-pr placeholder="lnbc…" spellcheck="false"></textarea></div>`)
        )
      } else if (tab === 'address') {
        pane.replaceChildren(
          el(`<div class="stack">
            <div class="field"><label>Lightning Address</label><input data-addr placeholder="them@wallet.example" autocomplete="off" /></div>
            <div class="amount-input"><input data-amount inputmode="numeric" placeholder="0" /><span class="unit">sat</span></div>
          </div>`)
        )
      } else {
        pane.replaceChildren(
          el(`<div class="stack">
            <p style="color:var(--ink-dim);font-size:15px">Cash a note straight into your connected NWC wallet.</p>
            <div class="amount-input"><input data-amount inputmode="numeric" placeholder="0" /><span class="unit">sat</span></div>
          </div>`)
        )
      }
    }
    body.querySelectorAll('[data-tab]').forEach(button =>
      button.addEventListener('click', () => {
        tab = (button as HTMLElement).dataset.tab!
        paint()
      })
    )
    paint()

    const go = body.querySelector('[data-meltgo]') as HTMLButtonElement
    go.addEventListener('click', () =>
      busy(go, async () => {
        let pr: string
        let target: string
        if (tab === 'invoice') {
          pr = (pane.querySelector('[data-pr]') as HTMLTextAreaElement).value.trim()
          target = 'invoice'
          if (!pr) throw new WalletUsageError('Paste the invoice to pay.')
        } else {
          const amount = Number((pane.querySelector('[data-amount]') as HTMLInputElement).value)
          if (!Number.isSafeInteger(amount) || amount <= 0) throw new WalletUsageError('Give an amount in whole sats.')
          if (tab === 'address') {
            const address = (pane.querySelector('[data-addr]') as HTMLInputElement).value.trim()
            if (!address) throw new WalletUsageError('Give a Lightning Address.')
            const {resolveLnurlPay} = await import('farrier-kit/lnurl')
            const resolved = await resolveLnurlPay({address, amountMsats: BigInt(amount * 1000)})
            pr = resolved.bolt11
            target = address
          } else {
            const invoice = await invoiceFromNwc(w.data.settings.nwcUri!, amount * 1000, 'notecase melt')
            pr = invoice.pr
            target = 'my wallet'
          }
        }
        const {ambiguous} = await w.melt(pr, target)
        toast(ambiguous ? 'The melt may be in flight - reconciling shortly.' : `Melting to ${target} - in flight.`, 'ok')
        viewHome()
        // settle it in the background while the user carries on
        for (let i = 0; i < 8; i++) {
          await new Promise(resolve => setTimeout(resolve, 2_200))
          const events = await w.reconcile().catch(() => [])
          const done = events.find(event => event.kind === 'melt-settled' || event.kind === 'melt-returned')
          if (done) {
            toast(`${done.kind === 'melt-settled' ? 'Melt settled' : 'Melt failed - note recovered'}: ${done.detail}`, 'ok')
            viewHome()
            break
          }
        }
      })
    )
    return view
  })
}

const viewSettings = (): void => {
  const w = wallet!
  const s = store!
  show(() => {
    const view = el('<div class="view"></div>')
    view.append(topBar('Settings', viewHome))
    const body = el('<div class="stack"></div>')

    // mints
    const mints = el(`<div class="card"><div class="section-title" style="margin:0">Mints</div></div>`)
    for (const mint of w.data.mints) {
      const row = el(`<div class="kv"><b></b><span></span></div>`)
      row.querySelector('b')!.textContent = `${mint.host}${mint.host === w.data.settings.defaultMintHost ? ' •' : ''}`
      row.querySelector('span')!.textContent = w.data.pubkeyPins[mint.host]
        ? `pinned ${w.data.pubkeyPins[mint.host]!.slice(0, 12)}…`
        : 'no pin yet'
      mints.append(row)
    }
    const addRow = el(`<div class="row">
      <input data-newmint placeholder="mint@mint.example" autocomplete="off" style="flex:2" />
      <button class="btn" style="flex:1">${icons.plus}<span>Add</span></button>
    </div>`)
    const addButton = addRow.querySelector('button') as HTMLButtonElement
    addButton.addEventListener('click', () =>
      busy(addButton, async () => {
        const entry = await w.addMint((addRow.querySelector('[data-newmint]') as HTMLInputElement).value.trim())
        toast(`Added ${entry.host}`, 'ok')
        viewSettings()
      })
    )
    mints.append(addRow)
    body.append(mints)

    // nwc
    const nwc = el(`<div class="card"><div class="section-title" style="margin:0">Lightning wallet (NWC)</div></div>`)
    if (w.data.settings.nwcUri) {
      const status = el(`<div class="kv"><span>connection</span><b>configured</b></div>`)
      nwc.append(status)
      const check = el(`<button class="btn btn-ghost">${icons.bolt}<span>Check connection</span></button>`)
      check.addEventListener('click', () =>
        busy(check as HTMLButtonElement, async () => {
          const result = await nwcStatus(w.data.settings.nwcUri!)
          toast(
            `${result.alias ?? 'wallet'} - ${result.methods.length} methods${result.balanceMsat !== null ? `, ${sats(result.balanceMsat)} sat` : ''}`,
            'ok'
          )
        })
      )
      const clear = el(`<button class="btn btn-ghost danger-text">Remove connection</button>`)
      clear.addEventListener('click', async () => {
        delete w.data.settings.nwcUri
        await s.save()
        viewSettings()
      })
      nwc.append(check, clear)
    } else {
      const row = el(`<div class="stack">
        <input data-nwc placeholder="nostr+walletconnect://…" autocomplete="off" />
        <button class="btn">${icons.bolt}<span>Connect</span></button>
      </div>`)
      const connect = row.querySelector('button') as HTMLButtonElement
      connect.addEventListener('click', () =>
        busy(connect, async () => {
          const uri = (row.querySelector('[data-nwc]') as HTMLInputElement).value.trim()
          await nwcStatus(uri)
          w.data.settings.nwcUri = uri
          await s.save()
          toast('Wallet connected', 'ok')
          viewSettings()
        })
      )
      nwc.append(row)
    }
    body.append(nwc)

    // security
    const security = el(`<div class="card"><div class="section-title" style="margin:0">Security</div></div>`)
    const bio = el(`<button class="btn btn-ghost">${icons.face}<span>Enable biometric unlock</span></button>`)
    bio.addEventListener('click', () =>
      busy(bio as HTMLButtonElement, async () => {
        const enabled = await enableBiometric(s.storeKey)
        toast(enabled ? 'Biometric unlock enabled' : 'This device did not offer it', enabled ? 'ok' : 'err')
      })
    )
    const backup = el(`<button class="btn btn-ghost">${icons.copy}<span>Download encrypted backup</span></button>`)
    backup.addEventListener('click', () => {
      const blob = new Blob([localStorage.getItem('notecase.wallet.v1') ?? ''], {type: 'application/json'})
      const link = document.createElement('a')
      link.href = URL.createObjectURL(blob)
      link.download = 'notecase-backup.json'
      link.click()
      URL.revokeObjectURL(link.href)
      toast('Backup downloaded - it opens only with this wallet’s key.', 'ok')
    })
    const lock = el(`<button class="btn">${icons.lock}<span>Lock now</span></button>`)
    lock.addEventListener('click', () => {
      store = null
      wallet = null
      void viewLocked()
    })
    security.append(bio, backup, lock)
    body.append(security)

    view.append(body)
    return view
  })
}

// ---------- boot ----------

if (walletExists()) void viewLocked()
else viewSetup()
