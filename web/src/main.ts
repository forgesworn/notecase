import './style.css'
import {registerSW} from 'virtual:pwa-register'
import {animate, stagger, utils} from 'animejs'
import {renderSVG} from 'uqr'
import type {SetupBiometricResult} from 'keystore-kit'
import {
  buildNoteUrl,
  isBolt11Invoice,
  resolveMintInput,
  resolveNoteInput,
  toBech32Lnurl,
  verifyNoteSignature
} from 'lnurlcash-kit'
import {Wallet, WalletUsageError, InsufficientFundsError, PinMismatchError} from '../../src/wallet.ts'
import {exportBackup, importBackup} from '../../src/backup.ts'
import {payWithNwc, invoiceFromNwc, nwcStatus} from '../../src/nwc.ts'
import type {NoteRecord, PendingMint} from '../../src/types.ts'
import {
  biometricAvailable,
  biometricEnabled,
  createBrowserWallet,
  enableBiometric,
  forgetBrowserWallet,
  unlockWithBiometric,
  unlockWithPin,
  walletExists,
  type BrowserStore
} from './browser-store.ts'
import {scanAvailable, scanQr} from './scanner.ts'
import {icons} from './icons.ts'

// notecase web - the same Wallet engine the CLI drives, behind an
// icon-first, thumb-sized surface. Nothing here touches protocol logic:
// every rule lives in src/wallet.ts and is shared with the CLI and tests.

const app = document.getElementById('app')!
let store: BrowserStore | null = null
let wallet: Wallet | null = null
let viewEpoch = 0

// Every LNURLcash call is a GET with the k1 secret in the query string:
// never let the HTTP cache keep one (even if a mint sends cacheable
// headers), and never send this origin onward as a Referer.
const protocolFetch: typeof fetch = (input, init) =>
  fetch(input, {...init, cache: 'no-store', referrerPolicy: 'no-referrer'})

const WALLET_OPTS = {timeoutMs: 20_000, fetch: protocolFetch}

const SUGGESTED_MINTS = ['mint@moneyer.dev', 'mint@mint.forgesworn.dev']

// ---------- the claim route ----------
// #/claim?u=<note url> (or u=<base>&k1=<secret>&a=<msat>, the hardware-
// vault shape). The secret travels in the fragment, which never reaches a
// server - and is scrubbed from the address bar the moment it is read.

let pendingClaim: string | null = null

const readClaimHash = (): void => {
  const match = location.hash.match(/^#\/claim\?(.+)$/)
  if (!match) return
  const params = new URLSearchParams(match[1]!)
  const u = params.get('u')
  const k1 = params.get('k1')
  const amount = Number(params.get('a'))
  try {
    if (u && k1) pendingClaim = buildNoteUrl(u, k1, Number.isSafeInteger(amount) && amount > 0 ? amount : undefined)
    else if (u) pendingClaim = resolveNoteInput(u)
  } catch {
    pendingClaim = null
  }
  history.replaceState(null, '', location.pathname + location.search)
}

// ---------- tiny DOM + motion helpers ----------

const el = (html: string): HTMLElement => {
  const template = document.createElement('template')
  template.innerHTML = html.trim()
  return template.content.firstElementChild as HTMLElement
}

const sats = (msat: number): string => {
  const whole = msat / 1000
  const text = Number.isInteger(whole) ? whole.toLocaleString('en-GB') : whole.toFixed(3)
  return text.replace(/,/g, ' ')
}

const when = (at: number): string => {
  const delta = Date.now() - at
  if (delta < 60_000) return 'just now'
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} min ago`
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} h ago`
  if (delta < 172_800_000) return 'yesterday'
  return new Date(at).toLocaleDateString('en-GB', {day: 'numeric', month: 'short'})
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

// bearer: what was copied IS the money, so a plain "copied" is not enough -
// say what the clipboard means for a live note.
const copyText = async (text: string, label: string, bearer = false): Promise<void> => {
  try {
    await navigator.clipboard.writeText(text)
    if (bearer) {
      toast(
        `${label} copied. Anyone who sees it owns the sats - the clipboard is readable by other apps, so send it to exactly one person.`,
        'ok'
      )
    } else {
      toast(`${label} copied`, 'ok')
    }
  } catch {
    toast('Copying is blocked here - long-press to copy instead.', 'err')
  }
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
  const tiles = view.querySelectorAll('.tile, .note-row, .feature, .hist-row')
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

const qrCard = (text: string): HTMLElement => {
  const card = el('<div class="qr" role="img" aria-label="QR code"></div>')
  card.innerHTML = renderSVG(text, {border: 1})
  return card
}

// A bearer QR never sits in the DOM waiting for one careless tap: the SVG
// is rendered only when the cover is tapped, and the opaque cover over a
// square veil holds the space until then.
const coveredQr = (text: string): HTMLElement => {
  const wrap = el('<div class="covered"></div>')
  const veil = el('<div class="veil" aria-hidden="true"></div>')
  const cover = el(
    `<button class="cover">${icons.eye}<span>Tap to reveal</span><small>Anyone who sees this code can take the sats.</small></button>`
  )
  cover.addEventListener('click', () => {
    const qr = qrCard(text)
    veil.remove()
    wrap.append(qr)
    animate(cover, {opacity: 0, duration: 220, ease: 'outCubic', onComplete: () => cover.remove()})
    animate(qr, {filter: ['blur(14px)', 'blur(0px)'], scale: [0.98, 1], duration: 420, ease: 'outCubic'})
  })
  wrap.append(veil, cover)
  return wrap
}

const shareButton = (text: string): HTMLElement | null => {
  if (!navigator.share) return null
  const button = el(`<button class="btn btn-ghost">${icons.share}<span>Share</span></button>`)
  button.addEventListener('click', async () => {
    await navigator.share({text}).catch(() => {})
  })
  return button
}

// An amount entry with big digits, preset chips and an optional Max.
const amountField = (options: {presets?: number[]; maxMsat?: number} = {}): {node: HTMLElement; msat: () => number} => {
  const node = el(`<div class="stack">
    <div class="amount-input"><input data-amount inputmode="numeric" pattern="[0-9]*" placeholder="0" /><span class="unit">sat</span></div>
    <div class="presets" data-presets></div>
  </div>`)
  const input = node.querySelector('[data-amount]') as HTMLInputElement
  const presets = node.querySelector('[data-presets]') as HTMLElement
  const chips = (options.presets ?? []).map(value => {
    const chip = el(`<button>${sats(value * 1000)}</button>`)
    chip.addEventListener('click', () => {
      input.value = String(value)
      input.dispatchEvent(new Event('input'))
    })
    return chip
  })
  chips.forEach(chip => presets.append(chip))
  if (options.maxMsat !== undefined && options.maxMsat > 0) {
    const max = el('<button>Max</button>')
    max.addEventListener('click', () => {
      input.value = String(Math.floor(options.maxMsat! / 1000))
      input.dispatchEvent(new Event('input'))
    })
    presets.append(max)
  }
  if (!presets.childElementCount) presets.remove()
  return {
    node,
    msat: () => {
      const amount = Number(input.value)
      if (!Number.isSafeInteger(amount) || amount <= 0) throw new WalletUsageError('Give an amount in whole sats.')
      return amount * 1000
    }
  }
}

const scanButton = (onScan: (value: string) => void): HTMLElement | null => {
  if (!scanAvailable()) return null
  const button = el(`<button class="btn btn-ghost">${icons.scan}<span>Scan a QR</span></button>`)
  button.addEventListener('click', async () => {
    const value = await scanQr()
    if (value) onScan(value)
  })
  return button
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
      const button = el(
        `<button class="soft" aria-label="Unlock with biometrics">${options.biometric ? icons.face : ''}</button>`
      )
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

// ---------- welcome, create, restore, locked ----------

const viewWelcome = (): void =>
  show(() => {
    const view = el(`<div class="view welcome">
      <div class="hero" style="padding-top:36px">
        <div class="mark" style="color:var(--gold)">${icons.logo}</div>
        <h1 style="font-size:clamp(30px,8vw,40px);margin-top:12px">notecase</h1>
        <div class="sub" style="font-size:16px;max-width:40ch;margin:10px auto 0">A case for Lightning bearer notes - money as a secret you hold.</div>
      </div>
      <div class="features">
        <div class="feature">${icons.note}<b>Bearer notes</b><small>No account, no custodian's ledger - holding the secret is holding the money.</small></div>
        <div class="feature">${icons.lock}<b>Sealed on this device</b><small>Encrypted at rest - the PIN gates casual access on this device; a stolen backup is protected by its own passphrase, so pick a real one.</small></div>
        <div class="feature">${icons.mint}<b>Any mint</b><small>Mint, split, merge and melt at any LNURLcash service.</small></div>
      </div>
      <div class="stack" style="margin-top:auto">
        <button class="btn btn-gold" data-create>${icons.plus}<span>Create a wallet</span></button>
        <button class="btn btn-ghost" data-restore>${icons.upload}<span>Restore a backup</span></button>
      </div>
    </div>`)
    view.querySelector('[data-create]')!.addEventListener('click', viewSetup)
    view.querySelector('[data-restore]')!.addEventListener('click', viewRestore)
    return view
  })

const viewSetup = (): void =>
  show(() =>
    pinPad({
      title: 'Choose a PIN',
      subtitle: 'Six digits. It guards the notes on this device.',
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

const viewRestore = (): void =>
  show(() => {
    const view = el('<div class="view"></div>')
    view.append(topBar('Restore a backup', viewWelcome))
    const body = el(`<div class="stack">
      <label class="btn btn-ghost" style="cursor:pointer">${icons.upload}<span data-filename>Choose the backup file</span>
        <input type="file" accept="application/json,.json" style="display:none" />
      </label>
      <div class="field">
        <label>Backup passphrase</label>
        <input data-pass type="password" autocomplete="off" data-1p-ignore data-lpignore="true" placeholder="the passphrase the backup was sealed with" />
      </div>
      <button class="btn btn-gold" data-go>${icons.check}<span>Restore</span></button>
      <p class="warn">Restoring puts every note from the backup on THIS device, then asks for a fresh PIN. If someone else wrote this file, they may still hold copies of these notes - receive or rotate them soon.</p>
    </div>`)
    view.append(body)

    let contents: string | null = null
    const fileInput = body.querySelector('input[type=file]') as HTMLInputElement
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files?.[0]
      if (!file) return
      contents = await file.text()
      body.querySelector('[data-filename]')!.textContent = file.name
    })

    const go = body.querySelector('[data-go]') as HTMLButtonElement
    go.addEventListener('click', () =>
      busy(go, async () => {
        if (!contents) throw new WalletUsageError('Choose the backup file first.')
        const passphrase = (body.querySelector('[data-pass]') as HTMLInputElement).value
        const data = await importBackup(contents, passphrase)
        show(() =>
          pinPad({
            title: 'Choose a PIN',
            subtitle: 'A fresh PIN for this device - the backup passphrase stays what it was.',
            onComplete: async pin => {
              store = await createBrowserWallet(pin, data)
              wallet = new Wallet(store.data, store.save, WALLET_OPTS)
              viewHome()
              toast(`Restored - ${sats(wallet.balanceMsat())} sat across ${data.mints.length} mint(s).`, 'ok')
              return 'ok'
            }
          })
        )
      })
    )
    return view
  })

const viewLocked = async (): Promise<void> => {
  const canBio = await biometricAvailable().catch(() => false)
  const open = (opened: BrowserStore) => {
    store = opened
    wallet = new Wallet(opened.data, opened.save, WALLET_OPTS)
    viewHome()
  }
  const tryBio = async () => {
    const opened = await unlockWithBiometric().catch(() => null)
    if (opened) open(opened)
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
        open(opened)
        return 'ok'
      }
    })
  )
}

// ---------- home ----------

const signedOk = (w: Wallet, note: NoteRecord): boolean => {
  const pinned = w.data.pubkeyPins[note.mintHost]
  return Boolean(
    note.signature && pinned && verifyNoteSignature(note.k1, note.amountMsat, note.signature, pinned)
  )
}

const noteRow = (w: Wallet, note: NoteRecord): HTMLElement => {
  const row = el(`<button class="note-row">
    <div class="coin">${icons.note}</div>
    <div class="who"><b></b><small></small></div>
    <div class="amt"></div>
    <span class="chev">${icons.chevron}</span>
  </button>`)
  row.querySelector('b')!.textContent =
    note.state === 'sent' ? 'handed over' : note.origin === 'change' ? 'change' : note.origin
  row.querySelector('small')!.textContent = `${note.mintHost}${signedOk(w, note) ? ' · signed' : ''}`
  row.querySelector('.amt')!.textContent = `${sats(note.amountMsat)} sat`
  row.addEventListener('click', () => viewNote(note))
  return row
}

const viewHome = (): void => {
  const w = wallet!
  show(() => {
    const view = el(`<div class="view">
      <div class="top">
        <div class="brand" style="color:var(--gold)">${icons.logo}<span style="color:var(--ink)">notecase</span></div>
        <span class="spacer"></span>
        <button class="btn-icon" data-history aria-label="History">${icons.history}</button>
        <button class="btn-icon" data-settings aria-label="Settings">${icons.settings}</button>
      </div>
      <div class="hero burst-host">
        <div class="amount"><span data-balance>0</span><span class="unit">sat</span></div>
        <div class="mint-chips" data-sub></div>
      </div>
      <div class="actions">
        <button class="tile" data-go="receive">${icons.receive}<b>Receive</b></button>
        <button class="tile" data-go="send">${icons.send}<b>Send</b></button>
        <button class="tile" data-go="mint">${icons.mint}<b>Mint</b></button>
        <button class="tile" data-go="melt">${icons.melt}<b>Melt</b></button>
      </div>
      <div data-lists></div>
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

    const sub = view.querySelector('[data-sub]') as HTMLElement
    const mints = w.balanceByMint()
    if (mints.size === 0) {
      sub.textContent = 'nothing minted yet'
    } else {
      for (const [host, msat] of mints) {
        const chip = el(`<button class="chip"><span></span><b>${sats(msat)}</b></button>`)
        chip.querySelector('span')!.textContent = host
        chip.addEventListener('click', () => viewMints())
        sub.append(chip)
      }
    }

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

    const lists = view.querySelector('[data-lists]') as HTMLElement
    const live = w.liveNotes().sort((a, b) => b.createdAt - a.createdAt)
    const sent = w.sentNotes().sort((a, b) => b.updatedAt - a.updatedAt)

    if (live.length === 0 && sent.length === 0) {
      lists.append(
        el(`<div class="empty">${icons.note}<br/>No notes yet.<br/>Mint one with Lightning, or receive one from a friend.</div>`)
      )
    }
    if (live.length) {
      lists.append(el('<div class="section-title">Notes</div>'))
      const stack = el('<div class="stack"></div>')
      live.forEach(note => stack.append(noteRow(w, note)))
      lists.append(stack)
    }
    if (sent.length) {
      lists.append(el('<div class="section-title">Handed over - reclaimable until taken</div>'))
      const stack = el('<div class="stack"></div>')
      sent.forEach(note => stack.append(noteRow(w, note)))
      lists.append(stack)
    }

    view.querySelector('[data-settings]')!.addEventListener('click', viewSettings)
    view.querySelector('[data-history]')!.addEventListener('click', viewHistory)
    view.querySelectorAll<HTMLButtonElement>('[data-go]').forEach(button =>
      button.addEventListener('click', () => {
        const go = button.dataset.go
        if (go === 'receive') viewReceive()
        if (go === 'send') viewSend()
        if (go === 'mint') viewMint()
        if (go === 'melt') viewMelt()
      })
    )

    if (scanAvailable()) {
      const fab = el(`<button class="fab" aria-label="Scan a QR">${icons.scan}</button>`)
      fab.addEventListener('click', async () => {
        const value = await scanQr()
        if (value) classifyScan(value)
      })
      view.append(fab)
    }
    return view
  })

  if (pendingClaim) {
    const claim = pendingClaim
    pendingClaim = null
    viewReceive(claim)
    toast('A note arrived - check it and receive.', 'ok')
  }
}

// One scanner, every payload: the decode says where it goes.
const classifyScan = (raw: string): void => {
  const value = raw.replace(/^lightning:/i, '').trim()
  if (resolveNoteInput(value)) return viewReceive(value)
  if (isBolt11Invoice(value)) return viewMelt(value)
  if (resolveMintInput(value)) return viewMints(value)
  toast('That QR is not a note, an invoice or a mint address.', 'err')
}

// ---------- note detail ----------

const viewNote = (note: NoteRecord): void => {
  const w = wallet!
  const url = w.noteUrlFor(note)
  show(() => {
    const view = el('<div class="view"></div>')
    view.append(topBar(note.state === 'sent' ? 'Handed over' : 'Your note', viewHome))
    const body = el(`<div class="stack center">
      <div class="hero burst-host" style="padding:6px 0 0">
        <div class="amount">${sats(note.amountMsat)}<span class="unit">sat</span></div>
      </div>
      <div class="badges"></div>
      <div class="card" style="text-align:left">
        <div class="kv"><span>mint</span><b></b></div>
        <div class="kv"><span>came from</span><b></b></div>
        <div class="kv"><span>created</span><b>${when(note.createdAt)}</b></div>
        <div class="kv"><span>note id</span><code></code></div>
      </div>
    </div>`)
    // mintHost, origin and id are persisted strings - a crafted backup must
    // never become markup, so they go in as text, not through el().
    const badges = body.querySelector('.badges')!
    const signed = signedOk(w, note)
    const sigBadge = el(`<span class="badge${signed ? ' good' : ''}">${icons.shield}<span></span></span>`)
    sigBadge.querySelector('span')!.textContent = signed ? `signed by ${note.mintHost}` : 'no verified signature'
    badges.append(sigBadge)
    if (note.state === 'sent') {
      badges.append(
        el(`<span class="badge wait">${icons.send}<span>handed over - whoever holds it can spend it</span></span>`)
      )
    }
    const [kvMint, kvOrigin] = body.querySelectorAll('.kv b')
    kvMint!.textContent = note.mintHost
    kvOrigin!.textContent = note.origin
    body.querySelector('.kv code')!.textContent = `${note.id.slice(0, 16)}…`
    view.append(body)

    if (note.state === 'sent') {
      const reclaim = el(`<button class="btn btn-gold">${icons.undo}<span>Take it back</span></button>`)
      reclaim.addEventListener('click', () =>
        busy(reclaim as HTMLButtonElement, async () => {
          try {
            const result = await w.reclaim(note)
            result.warnings.forEach(warning => toast(warning, 'err'))
            toast(`Reclaimed ${sats(result.note.amountMsat)} sat - the old copy is dead.`, 'ok')
            viewHome()
          } catch (err) {
            toast('Could not reclaim - it may already have been taken. You can mark it as taken below.', 'err')
            throw err
          }
        })
      )
      const taken = el(`<button class="btn btn-ghost">${icons.check}<span>They took it - remove from this list</span></button>`)
      taken.addEventListener('click', () =>
        busy(taken as HTMLButtonElement, async () => {
          await w.markTaken(note)
          viewHome()
        })
      )
      body.append(reclaim, coveredQr(toBech32Lnurl(url)), taken)
    } else {
      body.append(coveredQr(toBech32Lnurl(url)))
      const rotate = el(`<button class="btn btn-ghost">${icons.refresh}<span>Rotate the secret</span></button>`)
      rotate.addEventListener('click', () =>
        busy(rotate as HTMLButtonElement, async () => {
          const rotated = await w.rotateLive(note)
          toast(`Rotated - everything anyone ever saw of the old secret is now worthless.`, 'ok')
          viewNote(rotated)
        })
      )
      body.append(rotate)
    }

    const copyUrl = el(`<button class="btn">${icons.copy}<span>Copy note URL</span></button>`)
    copyUrl.addEventListener('click', () => void copyText(url, 'Note URL', true))
    const copyLnurl = el(`<button class="btn btn-ghost">${icons.copy}<span>Copy LNURL</span></button>`)
    copyLnurl.addEventListener('click', () => void copyText(toBech32Lnurl(url), 'LNURL', true))
    body.append(copyUrl, copyLnurl)
    const share = shareButton(url)
    if (share) body.append(share)
    return view
  })
}

// ---------- history ----------

type HistoryEvent = {at: number; icon: string; text: string; kind: 'in' | 'out' | 'info'}

const historyEvents = (w: Wallet): HistoryEvent[] => {
  const events: HistoryEvent[] = []
  for (const note of w.data.notes) {
    if (note.origin === 'mint') {
      events.push({at: note.createdAt, icon: icons.mint, text: `Minted ${sats(note.amountMsat)} sat at ${note.mintHost}.`, kind: 'in'})
    }
    if (note.origin === 'receive') {
      events.push({at: note.createdAt, icon: icons.receive, text: `Received ${sats(note.amountMsat)} sat (${note.mintHost}).`, kind: 'in'})
    }
    if (note.origin === 'recovered') {
      events.push({at: note.createdAt, icon: icons.undo, text: `${sats(note.amountMsat)} sat came back after a failed melt.`, kind: 'in'})
    }
    if (note.state === 'sent') {
      events.push({at: note.updatedAt, icon: icons.send, text: `Prepared a ${sats(note.amountMsat)} sat note to hand over.`, kind: 'out'})
    }
  }
  for (const pending of w.data.pendingMints) {
    if (pending.state === 'awaiting') {
      events.push({at: pending.createdAt, icon: icons.mint, text: `A ${sats(pending.grossMsat)} sat mint invoice at ${pending.mintHost} awaits payment.`, kind: 'info'})
    }
    if (pending.state === 'expired') {
      events.push({at: pending.updatedAt, icon: icons.x, text: `A mint invoice at ${pending.mintHost} expired unpaid.`, kind: 'info'})
    }
  }
  for (const melt of w.data.melts) {
    if (melt.state === 'settled') {
      events.push({at: melt.updatedAt, icon: icons.melt, text: `Melted ${sats(melt.amountMsat)} sat to ${melt.target}.`, kind: 'out'})
    }
    if (melt.state === 'returned') {
      events.push({at: melt.updatedAt, icon: icons.undo, text: `A melt of ${sats(melt.amountMsat)} sat failed - the sats came back.`, kind: 'info'})
    }
    if (melt.state === 'in-flight') {
      events.push({at: melt.updatedAt, icon: icons.melt, text: `Melting ${sats(melt.amountMsat)} sat to ${melt.target} - in flight.`, kind: 'info'})
    }
  }
  return events.sort((a, b) => b.at - a.at).slice(0, 100)
}

const viewHistory = (): void => {
  const w = wallet!
  show(() => {
    const view = el('<div class="view"></div>')
    view.append(topBar('History', viewHome))
    const events = historyEvents(w)
    if (events.length === 0) {
      view.append(el(`<div class="empty">${icons.history}<br/>Nothing yet - it all starts with a first note.</div>`))
      return view
    }
    const stack = el('<div class="stack"></div>')
    for (const event of events) {
      const row = el(`<div class="hist-row ${event.kind}">
        <div class="coin">${event.icon}</div>
        <div class="who"><b></b><small></small></div>
      </div>`)
      row.querySelector('b')!.textContent = event.text
      row.querySelector('small')!.textContent = when(event.at)
      stack.append(row)
    }
    view.append(stack)
    return view
  })
}

// ---------- receive ----------

const viewReceive = (prefill?: string): void => {
  const w = wallet!
  show(() => {
    const view = el(`<div class="view"></div>`)
    view.append(topBar('Receive a note', viewHome))
    const body = el(`<div class="stack">
      <div class="field">
        <label>Paste the note you were given</label>
        <textarea data-input placeholder="lnurlw://… or LNURL1…" autocomplete="off" spellcheck="false"></textarea>
      </div>
      <button class="btn btn-ghost" data-paste>${icons.paste}<span>Paste from clipboard</span></button>
      <button class="btn btn-gold" data-receive>${icons.receive}<span>Receive</span></button>
      <p class="warn">Receiving rotates the note to a fresh secret straight away, so whoever sent it can no longer spend it.</p>
    </div>`)
    view.append(body)
    const input = body.querySelector('textarea')!
    if (prefill) input.value = prefill
    body.querySelector('[data-paste]')!.addEventListener('click', async () => {
      input.value = await navigator.clipboard.readText().catch(() => input.value)
    })
    const scan = scanButton(value => {
      input.value = value.replace(/^lightning:/i, '')
    })
    if (scan) body.insertBefore(scan, body.querySelector('[data-receive]'))
    const receiveButton = body.querySelector('[data-receive]') as HTMLButtonElement
    receiveButton.addEventListener('click', () =>
      busy(receiveButton, async () => {
        const result = await w.receive(input.value.trim())
        result.warnings.forEach(warning => toast(warning, 'err'))
        burst(body)
        toast(`Received ${sats(result.note.amountMsat)} sat`, 'ok')
        setTimeout(viewHome, 650)
      })
    )
    return view
  })
}

// ---------- send ----------

const viewSend = (): void => {
  const w = wallet!
  show(() => {
    const view = el(`<div class="view"></div>`)
    view.append(topBar('Send', viewHome))
    const amount = amountField({presets: [500, 1000, 5000], maxMsat: w.balanceMsat()})
    const body = el('<div class="stack"></div>')
    body.append(amount.node)
    body.append(
      el(`<button class="btn btn-gold" data-cut>${icons.send}<span>Cut a note</span></button>`),
      el(`<p class="warn">notecase splits or merges your notes to the exact amount, then hands you a fresh bearer note to share.</p>`)
    )
    view.append(body)
    const cut = body.querySelector('[data-cut]') as HTMLButtonElement
    cut.addEventListener('click', () =>
      busy(cut, async () => {
        const note = await w.send(amount.msat())
        const url = w.noteUrlFor(note)
        show(() => {
          const done = el('<div class="view"></div>')
          done.append(topBar('Your note', viewHome))
          const inner = el(`<div class="stack center">
            <div class="hero burst-host" style="padding:6px 0 0"><div class="amount">${sats(note.amountMsat)}<span class="unit">sat</span></div></div>
            <p class="warn">Whoever sees this note owns it. Show the QR or share the text - once, to one person. Until they take it, you can reclaim it from the home screen.</p>
          </div>`)
          inner.insertBefore(coveredQr(toBech32Lnurl(url)), inner.querySelector('p'))
          const copyUrl = el(`<button class="btn">${icons.copy}<span>Copy note URL</span></button>`)
          copyUrl.addEventListener('click', () => void copyText(url, 'Note URL', true))
          const copyLnurl = el(`<button class="btn btn-ghost">${icons.copy}<span>Copy LNURL</span></button>`)
          copyLnurl.addEventListener('click', () => void copyText(toBech32Lnurl(url), 'LNURL', true))
          inner.append(copyUrl, copyLnurl)
          const share = shareButton(url)
          if (share) inner.append(share)
          done.append(inner)
          setTimeout(() => burst(inner.querySelector('.hero')!), 350)
          return done
        })
      })
    )
    return view
  })
}

// ---------- minting ----------

const mintPicker = (w: Wallet): HTMLElement => {
  const field = el(`<div class="field"><label>Mint</label><select data-mint></select></div>`)
  const select = field.querySelector('select') as HTMLSelectElement
  for (const mint of w.data.mints) {
    // mint hosts are persisted strings: build options, never interpolate
    const option = document.createElement('option')
    option.textContent = mint.host
    option.selected = mint.host === w.data.settings.defaultMintHost
    select.append(option)
  }
  return field
}

const viewMint = (): void => {
  const w = wallet!
  if (w.data.mints.length === 0) {
    viewMints()
    toast('Add a mint first - one tap on a suggestion does it.')
    return
  }
  show(() => {
    const view = el(`<div class="view"></div>`)
    view.append(topBar('Mint notes', viewHome))
    const amount = amountField({presets: [500, 1000, 5000, 21000]})
    const form = el('<div class="stack"></div>')
    form.append(mintPicker(w), amount.node)
    form.append(
      el(`<p class="warn" data-feenote>&nbsp;</p>`),
      el(`<button class="btn btn-gold" data-mintgo>${icons.mint}<span>${w.data.settings.nwcUri ? 'Mint - pay with connected wallet' : 'Create the invoice'}</span></button>`),
      el(`<p class="warn">You type what the note should hold; any mint fee is added to the invoice, shown before you pay.</p>`)
    )
    view.append(form)

    const feeNote = form.querySelector('[data-feenote]') as HTMLElement
    const input = amount.node.querySelector('[data-amount]') as HTMLInputElement
    const select = form.querySelector('[data-mint]') as HTMLSelectElement
    const paintFee = () => {
      const entry = w.data.mints.find(mint => mint.host === select.value)
      const fee = entry?.mintFee
      const net = Number(input.value) * 1000
      if (!fee) {
        feeNote.textContent = 'No known mint fee here.'
        return
      }
      if (!Number.isSafeInteger(net) || net <= 0) {
        feeNote.textContent = `Mint fee: ${fee.baseFeeMsat > 0 ? `${sats(fee.baseFeeMsat)} sat flat` : ''}${fee.baseFeeMsat > 0 && fee.feePpm > 0 ? ' + ' : ''}${fee.feePpm > 0 ? `${fee.feePpm / 10_000}%` : ''}, charged once, now.`
        return
      }
      const gross = grossUp(net, fee)
      feeNote.textContent = `You'll pay about ${sats(gross)} sat for a ${sats(net)} sat note - confirmed on the invoice.`
    }
    input.addEventListener('input', paintFee)
    select.addEventListener('change', paintFee)
    paintFee()

    const go = form.querySelector('[data-mintgo]') as HTMLButtonElement
    go.addEventListener('click', () =>
      busy(go, async () => {
        const net = amount.msat()
        const host = select.value
        const entry = w.data.mints.find(mint => mint.host === host)
        const gross = entry?.mintFee ? grossUp(net, entry.mintFee) : net
        const {pending, fee} = await w.startMint(gross, host)
        if (fee) toast(`The invoice is ${sats(pending.grossMsat)} sat - the note will hold ${sats(pending.expectedNetMsat)} sat.`)
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

// The minimal gross for a wanted net under a mint fee: what the engine's
// cached advertisement prices; startMint re-fetches and the invoice view
// shows the authoritative figures.
const grossUp = (netMsat: number, fee: {baseFeeMsat: number; feePpm: number}): number => {
  const gross = Math.ceil((netMsat + fee.baseFeeMsat) / (1 - fee.feePpm / 1_000_000))
  return gross
}

const viewMintInvoice = (pending: PendingMint): void => {
  const w = wallet!
  const epoch = viewEpoch + 1
  show(() => {
    const view = el('<div class="view"></div>')
    view.append(topBar('Pay to mint', viewHome))
    const body = el(`<div class="stack center">
      <p class="pulse" style="color:var(--ink-dim)">Waiting for the payment…</p>
      <p class="warn">Pay this invoice from any Lightning wallet - the note (${sats(pending.expectedNetMsat)} sat) is claimed automatically when it settles.</p>
    </div>`)
    // the invoice string comes from the mint: assign href as a property,
    // never through HTML where a quote would break out of the attribute
    const qrLink = el('<a style="display:block"></a>') as HTMLAnchorElement
    qrLink.href = `lightning:${pending.pr}`
    qrLink.append(qrCard(pending.pr.toUpperCase()))
    body.prepend(qrLink)
    const copy = el(`<button class="btn">${icons.copy}<span>Copy invoice</span></button>`)
    copy.addEventListener('click', () => void copyText(pending.pr, 'Invoice'))
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

// ---------- melting ----------

const viewMelt = (prefillPr?: string): void => {
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
        const stack = el(`<div class="stack">
          <div class="field"><label>BOLT-11 invoice</label><textarea data-pr placeholder="lnbc…" spellcheck="false"></textarea></div>
        </div>`)
        if (prefillPr) (stack.querySelector('[data-pr]') as HTMLTextAreaElement).value = prefillPr
        const scan = scanButton(value => {
          ;(stack.querySelector('[data-pr]') as HTMLTextAreaElement).value = value.replace(/^lightning:/i, '')
        })
        if (scan) stack.append(scan)
        pane.replaceChildren(stack)
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
          pr = (pane.querySelector('[data-pr]') as HTMLTextAreaElement).value.trim().replace(/^lightning:/i, '')
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

// ---------- mints ----------

const viewMints = (prefillAdd?: string): void => {
  const w = wallet!
  show(() => {
    const view = el('<div class="view"></div>')
    view.append(topBar('Mints', viewHome))
    const body = el('<div class="stack"></div>')
    view.append(body)

    const balances = w.balanceByMint()
    for (const entry of w.data.mints) {
      const isDefault = entry.host === w.data.settings.defaultMintHost
      const pin = w.data.pubkeyPins[entry.host]
      const fee = entry.mintFee
      const card = el(`<div class="card">
        <div class="kv" style="align-items:center">
          <b style="font-size:16.5px"></b>
          <span class="row" style="gap:8px">
            <button class="btn-icon" data-star aria-label="Make default" style="color:${isDefault ? 'var(--gold)' : 'var(--ink-dim)'}">${icons.star}</button>
            <button class="btn-icon" data-remove aria-label="Remove">${icons.trash}</button>
          </span>
        </div>
        <div class="kv"><span>holding</span><b>${sats(balances.get(entry.host) ?? 0)} sat</b></div>
        <div class="kv"><span>mint fee</span><b>${
          fee
            ? `${fee.baseFeeMsat > 0 ? `${sats(fee.baseFeeMsat)} sat flat` : ''}${fee.baseFeeMsat > 0 && fee.feePpm > 0 ? ' + ' : ''}${fee.feePpm > 0 ? `${fee.feePpm / 10_000}%` : ''}`
            : 'none advertised'
        }</b></div>
        <div class="kv"><span>key pinned</span>${pin ? '<code></code>' : '<b>not yet - first receive pins it</b>'}</div>
        ${isDefault ? `<div class="kv"><span>default</span><b>new mints and sends start here</b></div>` : ''}
      </div>`)
      // host and pin are persisted strings: text, never markup
      card.querySelector('.kv b')!.textContent = entry.host
      if (pin) card.querySelector('.kv code')!.textContent = `${pin.slice(0, 20)}…`
      card.querySelector('[data-star]')!.addEventListener('click', async () => {
        await w.setDefaultMint(entry.host)
        viewMints()
      })
      const remove = card.querySelector('[data-remove]') as HTMLButtonElement
      remove.addEventListener('click', () =>
        busy(remove, async () => {
          await w.removeMint(entry.host)
          toast(`Removed ${entry.host} - its key stays pinned in case it returns.`, 'ok')
          viewMints()
        })
      )
      body.append(card)
    }

    const add = el(`<div class="card">
      <div class="section-title" style="margin:0">Add a mint</div>
      <div class="row">
        <input data-newmint placeholder="mint@mint.example" autocomplete="off" style="flex:2" />
        <button class="btn" style="flex:1">${icons.plus}<span>Add</span></button>
      </div>
      <div class="presets" data-suggest></div>
    </div>`)
    const addInput = add.querySelector('[data-newmint]') as HTMLInputElement
    if (prefillAdd) addInput.value = prefillAdd
    const suggest = add.querySelector('[data-suggest]') as HTMLElement
    for (const suggestion of SUGGESTED_MINTS) {
      const host = suggestion.split('@')[1]!
      if (w.data.mints.some(mint => mint.host === host)) continue
      const chip = el(`<button>${host}</button>`)
      chip.addEventListener('click', () => {
        addInput.value = suggestion
      })
      suggest.append(chip)
    }
    if (!suggest.childElementCount) suggest.remove()
    const addButton = add.querySelector('button.btn') as HTMLButtonElement
    addButton.addEventListener('click', () =>
      busy(addButton, async () => {
        const entry = await w.addMint(addInput.value.trim())
        toast(`Added ${entry.host}`, 'ok')
        viewMints()
      })
    )
    body.append(add)
    return view
  })
}

// ---------- settings ----------

const viewSettings = (): void => {
  const w = wallet!
  const s = store!
  show(() => {
    const view = el('<div class="view"></div>')
    view.append(topBar('Settings', viewHome))
    const body = el('<div class="stack"></div>')

    // mints
    const mints = el(`<button class="btn">${icons.mint}<span>Mints (${w.data.mints.length})</span></button>`)
    mints.addEventListener('click', () => viewMints())
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
      // A live spending capability: hidden like a passphrase, with a
      // deliberate reveal toggle rather than a permanently visible input.
      const row = el(`<div class="stack">
        <div class="row" style="align-items:center">
          <input data-nwc type="password" placeholder="nostr+walletconnect://…" autocomplete="off" data-1p-ignore data-lpignore="true" />
          <button class="btn-icon" data-reveal aria-label="Show the connection string" style="flex:none">${icons.eye}</button>
        </div>
        <button class="btn">${icons.bolt}<span>Connect</span></button>
      </div>`)
      const nwcInput = row.querySelector('[data-nwc]') as HTMLInputElement
      const reveal = row.querySelector('[data-reveal]') as HTMLButtonElement
      reveal.addEventListener('click', () => {
        const showing = nwcInput.type === 'text'
        nwcInput.type = showing ? 'password' : 'text'
        reveal.innerHTML = showing ? icons.eye : icons.eyeOff
        reveal.setAttribute('aria-label', showing ? 'Show the connection string' : 'Hide the connection string')
      })
      const connect = row.querySelector('button.btn') as HTMLButtonElement
      connect.addEventListener('click', () =>
        busy(connect, async () => {
          const uri = nwcInput.value.trim()
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

    // backup
    const backup = el(`<div class="card"><div class="section-title" style="margin:0">Backup</div>
      <p class="warn" style="text-align:left">A backup is sealed under its own passphrase - not the PIN - and restores on any device from the welcome screen.</p>
    </div>`)
    const exportButton = el(`<button class="btn">${icons.download}<span>Download a backup</span></button>`)
    exportButton.addEventListener('click', () => viewExportBackup())
    backup.append(exportButton)
    body.append(backup)

    // security
    const security = el(`<div class="card"><div class="section-title" style="margin:0">Security</div></div>`)
    const bioArea = el('<div class="stack"></div>')

    // A tap on Enable mints a WebAuthn credential, and the result is a
    // discriminated union: each variant gets its own honest answer, and
    // once a credential exists the button becomes a status line so another
    // tap can never mint a duplicate.
    const paintBio = (): void => {
      bioArea.replaceChildren()
      if (biometricEnabled()) {
        const status = el(`<div class="kv"><span>biometric unlock</span><b></b></div>`)
        status.querySelector('b')!.textContent = 'enabled - the PIN still works as a backup'
        bioArea.append(status)
        return
      }
      const bio = el(`<button class="btn btn-ghost">${icons.face}<span>Enable biometric unlock</span></button>`)
      bio.addEventListener('click', () =>
        busy(bio as HTMLButtonElement, async () => reportEnable(await enableBiometric(s.storeKey)))
      )
      bioArea.append(bio)
    }

    const reportEnable = (result: SetupBiometricResult): void => {
      if (result.ok) {
        toast(
          result.prfSupported
            ? `Biometric unlock enabled - your PIN still works as a backup.`
            : `Biometric unlock is on, but only the weaker device-bound kind: it keeps out casual access, not someone who copies this browser's stored wallet data. Your PIN still works as a backup.`,
          'ok'
        )
        paintBio()
        return
      }
      if (result.reason === 'prf-unsupported') {
        offerFallback()
        return
      }
      // A cancelled prompt is the user backing out - restore quietly.
      if (result.reason === 'cancelled') {
        paintBio()
        return
      }
      toast(
        result.reason === 'no-provider'
          ? `This device has no biometric authenticator.`
          : `Biometric setup failed - try again.`,
        'err'
      )
    }

    // No PRF on this device: the weaker wrap is written only after an
    // explicit second tap that spells out what it does and does not stop.
    const offerFallback = (): void => {
      bioArea.replaceChildren()
      const warn = el('<p class="warn" style="text-align:left"></p>')
      warn.textContent =
        `This device can't do hardware-backed biometric unlock. It can still ask for your fingerprint or face, ` +
        `but the protection is weaker: casual access is stopped, someone who copies this browser's stored wallet ` +
        `data is not. Download a passphrase backup first, then decide.`
      const use = el(`<button class="btn btn-ghost danger-text">${icons.face}<span>Use the weaker fallback</span></button>`)
      use.addEventListener('click', () =>
        busy(use as HTMLButtonElement, async () =>
          reportEnable(await enableBiometric(s.storeKey, {allowDeviceFallback: true}))
        )
      )
      const keep = el(`<button class="btn">Keep PIN only</button>`)
      keep.addEventListener('click', paintBio)
      bioArea.append(warn, use, keep)
    }

    const lock = el(`<button class="btn">${icons.lock}<span>Lock now</span></button>`)
    lock.addEventListener('click', () => {
      store = null
      wallet = null
      void viewLocked()
    })
    security.append(bioArea, lock)
    paintBio()
    body.append(security)

    // danger
    const danger = el(`<div class="card"><div class="section-title" style="margin:0">Danger</div></div>`)
    const forget = el(`<button class="btn btn-ghost danger-text">${icons.trash}<span>Forget this wallet</span></button>`)
    forget.addEventListener('click', () => viewForget())
    danger.append(forget)
    body.append(danger)

    view.append(body)
    return view
  })
}

const viewExportBackup = (): void => {
  const w = wallet!
  show(() => {
    const view = el('<div class="view"></div>')
    view.append(topBar('Download a backup', viewSettings))
    const body = el(`<div class="stack">
      <div class="field">
        <label>Backup passphrase - at least 10 characters</label>
        <input data-pass type="password" autocomplete="off" data-1p-ignore data-lpignore="true" placeholder="not your PIN - something long" />
      </div>
      <div class="field">
        <label>Once more</label>
        <input data-pass2 type="password" autocomplete="off" data-1p-ignore data-lpignore="true" />
      </div>
      <button class="btn btn-gold" data-go>${icons.download}<span>Seal and download</span></button>
      <p class="warn">The file holds every note. Anyone with the file AND the passphrase holds your money; without the passphrase the file is useless. There is no recovery for a forgotten passphrase.</p>
    </div>`)
    view.append(body)
    const go = body.querySelector('[data-go]') as HTMLButtonElement
    go.addEventListener('click', () =>
      busy(go, async () => {
        const pass = (body.querySelector('[data-pass]') as HTMLInputElement).value
        const pass2 = (body.querySelector('[data-pass2]') as HTMLInputElement).value
        if (pass !== pass2) throw new WalletUsageError('The passphrases do not match.')
        const file = await exportBackup(w.data, pass)
        const blob = new Blob([file], {type: 'application/json'})
        const link = document.createElement('a')
        link.href = URL.createObjectURL(blob)
        link.download = `notecase-backup-${new Date().toISOString().slice(0, 10)}.json`
        link.click()
        URL.revokeObjectURL(link.href)
        toast('Backup downloaded - store it and its passphrase apart.', 'ok')
        viewSettings()
      })
    )
    return view
  })
}

const viewForget = (): void => {
  show(() =>
    pinPad({
      title: 'Forget this wallet?',
      subtitle: 'Enter your PIN to erase the wallet from this device. Notes NOT in a backup are gone forever.',
      onComplete: async pin => {
        const opened = await unlockWithPin(pin).catch(() => null)
        if (!opened) return 'retry'
        await forgetBrowserWallet()
        store = null
        wallet = null
        toast('Forgotten. This device holds nothing now.', 'ok')
        viewWelcome()
        return 'ok'
      }
    })
  )
}

// ---------- PWA update prompt ----------
// registerType 'prompt' + no runtime caching: a build never swaps out
// mid-melt, and no protocol call is ever served stale. Tests alias the
// virtual module to a stub (vitest.config.ts).

const update = registerSW({
  onNeedRefresh() {
    const node = el(
      `<div class="toast ok" style="pointer-events:auto;display:flex;gap:12px;align-items:center">A new version is ready<button class="btn" style="min-height:40px;width:auto;padding:0 14px">Reload</button></div>`
    )
    node.querySelector('button')!.addEventListener('click', () => void update(true))
    document.getElementById('toasts')!.append(node)
  }
})

// ---------- boot ----------

readClaimHash()
if (walletExists()) void viewLocked()
else if (pendingClaim) {
  // A claim link on a fresh device: set up first, the note is kept for after.
  viewWelcome()
  toast('A note is waiting - set up the wallet to receive it.', 'ok')
} else {
  viewWelcome()
}
