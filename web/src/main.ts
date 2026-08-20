import '@fontsource/cinzel/400.css'
import '@fontsource/cinzel/700.css'
import '@fontsource/spectral/400.css'
import '@fontsource/spectral/400-italic.css'
import '@fontsource/spectral/500-italic.css'
import '@fontsource/spectral/600.css'
import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/ibm-plex-mono/500.css'
import '@fontsource/ibm-plex-mono/600.css'
import './style.css'
import {registerSW} from 'virtual:pwa-register'
import {animate, stagger, svg as animeSvg, utils} from 'animejs'
import {renderSVG} from 'uqr'
import type {SetupBiometricResult} from 'keystore-kit'
import {
  buildNoteUrl,
  hashK1,
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
import {rosette} from './guilloche.ts'
import {banknote} from './banknote.ts'

// notecase web - the same Wallet engine the CLI drives, set like the
// banknotes it holds. Nothing here touches protocol logic: every rule
// lives in src/wallet.ts and is shared with the CLI and tests. The design
// language is the moneyer mint's silver series - a note minted there
// looks the same held here, down to the scratch foil over its secret.

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

const esc = (value: string): string => value.replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`)

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

const countTo = (node: Element, msat: number): void => {
  const counter = {value: 0}
  animate(counter, {
    value: msat / 1000,
    duration: 1000,
    ease: 'outExpo',
    onUpdate: () => (node.textContent = sats(Math.round(counter.value) * 1000))
  })
}

// The lathe turns: engine-turned rings draw themselves on.
const drawOn = (host: Element, duration = 1600): void => {
  const paths = host.querySelectorAll('path')
  if (!paths.length) return
  try {
    const drawables = animeSvg.createDrawable(paths)
    animate(drawables, {draw: ['0 0', '0 1'], duration, delay: stagger(90), ease: 'inOutQuad'})
  } catch {
    // an environment without real SVG geometry (tests) just shows it drawn
  }
}

const letterSettle = (node: HTMLElement): void => {
  const text = node.textContent ?? ''
  node.textContent = ''
  const letters = [...text].map(char => {
    const span = el(`<b style="display:inline-block">${char === ' ' ? '&nbsp;' : esc(char)}</b>`)
    node.append(span)
    return span
  })
  animate(letters, {
    opacity: [0, 1],
    y: [14, 0],
    delay: stagger(55, {start: 120}),
    duration: 500,
    ease: 'outCubic'
  })
}

const show = (build: () => HTMLElement): void => {
  viewEpoch += 1
  app.replaceChildren(build())
  const view = app.firstElementChild as HTMLElement
  // strip the transform once the entry settles: a transformed ancestor
  // becomes the containing block for position:fixed, which would pin the
  // scan FAB to the view's corner instead of the screen's
  animate(view, {
    opacity: [0, 1],
    y: [10, 0],
    duration: 320,
    ease: 'outCubic',
    onComplete: () => view.style.removeProperty('transform')
  })
  const items = view.querySelectorAll('.tile, .step, .note-row, .hist-row, .kv')
  if (items.length) {
    animate(items, {opacity: [0, 1], y: [14, 0], delay: stagger(35), duration: 360, ease: 'outCubic'})
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
    <button class="btn-icon" data-back data-hint="Back" aria-label="Back">${icons.back}</button>
    <div class="brand"></div>
    <span class="spacer"></span>
  </div>`)
  bar.querySelector('.brand')!.textContent = title
  bar.querySelector('[data-back]')!.addEventListener('click', onBack)
  return bar
}

const qrCard = (text: string): HTMLElement => {
  const card = el('<div class="qr" role="img" aria-label="QR code"></div>')
  card.innerHTML = renderSVG(text, {border: 1})
  return card
}

// ---------- the reveal: scratch silver ----------
// A bearer secret hides under actual scratch silver: an opaque painted
// foil the holder rubs away with a finger, flakes falling, until enough is
// gone and the rest dissolves into sparks and the glint. A secret that
// must be scratched for can never flash from a careless tap - and it is a
// small ceremony of ownership. Keyboard: Enter reveals at once.

const paintFoil = (canvas: HTMLCanvasElement): void => {
  const w = canvas.clientWidth
  const h = canvas.clientHeight
  if (!w || !h) return
  const dpr = Math.min(window.devicePixelRatio || 1, 3)
  canvas.width = Math.round(w * dpr)
  canvas.height = Math.round(h * dpr)
  const ctx = canvas.getContext('2d', {willReadFrequently: true})
  if (!ctx) return
  ctx.scale(dpr, dpr)

  // the metal: a diagonal silver gradient
  const metal = ctx.createLinearGradient(0, 0, w, h)
  for (const [stop, colour] of [
    [0, '#cfd4db'],
    [0.22, '#eef1f5'],
    [0.42, '#a7b0bc'],
    [0.58, '#dfe3e9'],
    [0.78, '#98a1ad'],
    [1, '#d5dae1']
  ] as Array<[number, string]>) {
    metal.addColorStop(stop, colour)
  }
  ctx.fillStyle = metal
  ctx.fillRect(0, 0, w, h)

  // brushed grain
  for (let i = 0; i < 900; i++) {
    const light = Math.random() > 0.5
    ctx.fillStyle = light ? `rgba(255,255,255,${Math.random() * 0.1})` : `rgba(40,46,54,${Math.random() * 0.07})`
    ctx.fillRect(Math.random() * w, Math.random() * h, 2 + Math.random() * 10, 1)
  }
  // a sheen band
  ctx.fillStyle = 'rgba(255,255,255,0.14)'
  ctx.beginPath()
  ctx.moveTo(w * 0.15, 0)
  ctx.lineTo(w * 0.38, 0)
  ctx.lineTo(w * 0.12, h)
  ctx.lineTo(-w * 0.1, h)
  ctx.closePath()
  ctx.fill()

  // embossed instruction
  const size = Math.max(11, w * 0.055)
  ctx.textAlign = 'center'
  ctx.font = `600 ${size}px 'IBM Plex Mono', monospace`
  ctx.fillStyle = 'rgba(255,255,255,0.55)'
  ctx.fillText('SCRATCH TO REVEAL', w / 2, h / 2 + 1)
  ctx.fillStyle = 'rgba(44,50,58,0.72)'
  ctx.fillText('SCRATCH TO REVEAL', w / 2, h / 2)
  ctx.font = `500 ${Math.max(8.5, w * 0.032)}px 'IBM Plex Mono', monospace`
  ctx.fillStyle = 'rgba(44,50,58,0.6)'
  ctx.fillText('THE CODE BENEATH IS THE MONEY', w / 2, h / 2 + size * 1.5)

  // hairline frame
  ctx.strokeStyle = 'rgba(44,50,58,0.4)'
  ctx.lineWidth = 1
  ctx.strokeRect(3.5, 3.5, w - 7, h - 7)

  // the CSS gradient only covered the pre-paint frame; from here the
  // bitmap is the foil, and scratching must open onto the code beneath
  canvas.style.background = 'none'
}

// A silver flake spins off the scrub point.
const flake = (host: HTMLElement, x: number, y: number): void => {
  const bit = el('<i class="foil-flake" aria-hidden="true"></i>')
  bit.style.left = `${x}px`
  bit.style.top = `${y}px`
  host.append(bit)
  animate(bit, {
    x: utils.random(-22, 22),
    y: utils.random(18, 60),
    rotate: `${utils.random(-200, 200)}deg`,
    opacity: [1, 0],
    duration: utils.random(400, 750),
    ease: 'inQuad',
    onComplete: () => bit.remove()
  })
}

// The last of the foil dissolves: sparks, the glint, the seal, the serial.
const finale = (root: HTMLElement, canvas: HTMLCanvasElement): void => {
  if (navigator.vibrate) navigator.vibrate([12, 30, 20])
  animate(canvas, {
    opacity: [1, 0],
    scale: [1, 1.05],
    duration: 380,
    ease: 'outCubic',
    onComplete: () => canvas.remove()
  })
  const qr = root.querySelector('.covered .qr') as HTMLElement | null
  if (qr) animate(qr, {scale: [0.985, 1.02, 1], duration: 480, ease: 'outBack(1.6)'})
  const panel = root.querySelector('.nb-panel') as HTMLElement | null
  burst(panel ?? root)
  const seal = root.querySelector('.nb-seal') as HTMLElement | null
  if (seal) {
    animate(seal, {scale: [1.9, 1], opacity: [0, 0.8], rotate: ['-6deg', '8deg'], duration: 520, delay: 260, ease: 'outBack(2)'})
  }
  const serial = root.querySelector('.nb-serial') as HTMLElement | null
  if (serial) animate(serial, {opacity: [0, 1], y: [4, 0], duration: 420, delay: 380, ease: 'outCubic'})
  setTimeout(() => {
    root.classList.add('glint')
    setTimeout(() => root.classList.remove('glint'), 1500)
  }, 320)
}

const wireCover = (root: HTMLElement): void => {
  const canvas = root.querySelector('canvas.scratch-foil') as HTMLCanvasElement | null
  if (!canvas) return
  const covered = canvas.parentElement as HTMLElement
  let revealed = false
  let painted = false
  let strokes = 0
  let lastX = 0
  let lastY = 0
  let scrubbing = false

  // paint once the layout has given the canvas its real size
  if ('ResizeObserver' in window) {
    const observer = new ResizeObserver(() => {
      if (!painted && canvas.clientWidth > 0) {
        painted = true
        paintFoil(canvas)
        observer.disconnect()
      }
    })
    observer.observe(canvas)
  } else {
    paintFoil(canvas)
  }

  const reveal = (): void => {
    if (revealed) return
    revealed = true
    finale(root, canvas)
  }

  const clearedEnough = (): boolean => {
    const ctx = canvas.getContext('2d', {willReadFrequently: true})
    if (!ctx || !canvas.width) return false
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data
    let clear = 0
    let total = 0
    // sample every 23rd pixel - plenty for a fraction
    for (let i = 3; i < data.length; i += 4 * 23) {
      total++
      if (data[i]! < 40) clear++
    }
    return total > 0 && clear / total > 0.45
  }

  const scrub = (x: number, y: number): void => {
    const ctx = canvas.getContext('2d', {willReadFrequently: true})
    if (!ctx) return
    const dpr = canvas.width / canvas.clientWidth
    const radius = Math.max(16, canvas.clientWidth * 0.09)
    ctx.save()
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.globalCompositeOperation = 'destination-out'
    ctx.lineWidth = radius
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.beginPath()
    ctx.moveTo(lastX, lastY)
    ctx.lineTo(x, y)
    ctx.stroke()
    ctx.restore()
    strokes++
    if (strokes % 4 === 0) flake(covered, x, y)
    if (navigator.vibrate && strokes % 7 === 0) navigator.vibrate(4)
    if (strokes % 10 === 0 && clearedEnough()) reveal()
  }

  const local = (event: PointerEvent): {x: number; y: number} => {
    const rect = canvas.getBoundingClientRect()
    return {x: event.clientX - rect.left, y: event.clientY - rect.top}
  }

  canvas.addEventListener('pointerdown', event => {
    if (revealed) return
    event.preventDefault()
    canvas.setPointerCapture(event.pointerId)
    scrubbing = true
    const {x, y} = local(event)
    lastX = x
    lastY = y
    scrub(x, y)
  })
  canvas.addEventListener('pointermove', event => {
    if (!scrubbing || revealed) return
    const {x, y} = local(event)
    scrub(x, y)
    lastX = x
    lastY = y
  })
  for (const eventName of ['pointerup', 'pointercancel'] as const) {
    canvas.addEventListener(eventName, () => {
      scrubbing = false
      if (!revealed && clearedEnough()) reveal()
    })
  }
  // keyboard: reveal at once - nobody scratches with a spacebar
  canvas.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      reveal()
    }
  })
}

// The note itself, printed: the engraved plate, the denomination in words,
// the serial from the note id, and the bearer QR under scratch silver.
const notePrint = (note: {id: string; amountMsat: number; mintHost: string}, qrText: string): HTMLElement => {
  const print = banknote({
    sats: Math.round(note.amountMsat / 1000),
    serialHex: note.id,
    host: note.mintHost.toUpperCase(),
    variant: {kind: 'live', qrText}
  })
  wireCover(print)
  return print
}

// The strike: the note lands and the corners count up.
const strikeIn = (print: HTMLElement, amountMsat: number, host: HTMLElement): void => {
  animate(print, {scale: [0.96, 1], y: [10, 0], duration: 600, ease: 'outBack(1.4)'})
  const counterEl = print.querySelector('[data-value]')
  if (counterEl && amountMsat < 1_000_000_000_000) {
    setTimeout(() => {
      countTo(counterEl, amountMsat)
      burst(host)
    }, 250)
  } else {
    setTimeout(() => burst(host), 300)
  }
}

const shareButton = (text: string): HTMLElement | null => {
  if (!navigator.share) return null
  const button = el(`<button class="btn btn-ghost">${icons.share}<span>Share</span></button>`)
  button.addEventListener('click', async () => {
    await navigator.share({text}).catch(() => {})
  })
  return button
}

// An amount entry with big engraved digits, presets and an optional Max.
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
      animate(input, {scale: [1.06, 1], duration: 260, ease: 'outCubic'})
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
      <div class="mark" data-rosette>${rosette(120)}</div>
      <h1></h1>
      <p></p>
    </div>
    <div class="dots">${'<i></i>'.repeat(6)}</div>
    <div class="pad"></div>
  </div>`)
  view.querySelector('h1')!.textContent = options.title
  view.querySelector('p')!.textContent = options.subtitle
  drawOn(view.querySelector('[data-rosette]')!)
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
      <header class="masthead">
        <h1 class="wordmark" data-wordmark>NOTECASE</h1>
        <div class="tagline">A case for Lightning bearer notes</div>
      </header>
      <div class="hero">
        <span class="medallion"><span class="mark" data-rosette>${rosette(150)}</span></span>
        <p class="promise">A bearer note is a 32-byte secret that <em>is</em> the money - <em>this case holds yours</em>, and makes sure no crash, timeout or lying mint can part you from one.</p>
        <div class="fineline">No account · sealed on this device · any LNURLcash mint</div>
      </div>
      <div class="stack">
        <button class="btn btn-silver" data-create>${icons.plus}<span>Create a wallet</span></button>
        <button class="btn btn-ghost" data-restore>${icons.upload}<span>Restore a backup</span></button>
      </div>
      <div class="rubric">What it holds</div>
      <div data-specimen></div>
      <p class="warn">Notes like this one - minted at any LNURLcash mint, split, merged, handed over or melted back onto Lightning. Received notes are rotated to a fresh secret at once, so the sender can never double-spend them.</p>
      <div class="rubric">How it works</div>
      <div class="steps">
        <div class="step"><span class="n">I</span><b>Mint or receive</b><p>Pay a Lightning invoice at a mint, or take a note from a friend - it is re-secured the moment it arrives.</p></div>
        <div class="step"><span class="n">II</span><b>Hold the secret</b><p>Notes live sealed on this device behind your PIN. Backups are sealed again under their own passphrase.</p></div>
        <div class="step"><span class="n">III</span><b>Spend anywhere</b><p>Hand a note to anyone, or melt it back onto Lightning. Uncertain outcomes are reconciled, never guessed.</p></div>
      </div>
      <footer>
        <div class="microprint">${Array(8).fill('NOTECASE · MONEY AS A SECRET YOU HOLD · LNURLCASH · NOT LEGAL TENDER · ').join('')}</div>
      </footer>
    </div>`)
    view.querySelector('[data-create]')!.addEventListener('click', viewSetup)
    view.querySelector('[data-restore]')!.addEventListener('click', viewRestore)

    const specimen = banknote({
      sats: 21,
      serialHex: 'b0171f0000000000000000000000000000000000000000000000000000000011fd',
      host: 'MONEYER.DEV',
      variant: {kind: 'specimen'}
    })
    view.querySelector('[data-specimen]')!.append(specimen)

    letterSettle(view.querySelector('[data-wordmark]') as HTMLElement)
    drawOn(view.querySelector('[data-rosette]')!)
    const overstamps = [...specimen.querySelectorAll('.nb-overstamp')] as HTMLElement[]
    if (overstamps.length && 'IntersectionObserver' in window) {
      overstamps.forEach(stamp => (stamp.style.opacity = '0'))
      const seen = new IntersectionObserver(
        entries => {
          if (entries.some(entry => entry.isIntersecting)) {
            seen.disconnect()
            for (const stamp of overstamps) {
              stamp.style.removeProperty('opacity')
              animate(stamp, {scale: [2.4, 1], opacity: [0, 0.3], rotate: ['-4deg', '-14deg'], duration: 520, ease: 'outBack(2)'})
            }
          }
        },
        {threshold: 0.4}
      )
      seen.observe(specimen)
    }
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
      <button class="btn btn-silver" data-go>${icons.check}<span>Restore</span></button>
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
    <div class="amt"><span></span><span class="unit">sat</span></div>
    <span class="chev">${icons.chevron}</span>
  </button>`)
  row.querySelector('b')!.textContent =
    note.state === 'sent' ? 'handed over' : note.origin === 'change' ? 'change' : note.origin
  row.querySelector('small')!.textContent = `${note.mintHost}${signedOk(w, note) ? ' · signed' : ''}`
  row.querySelector('.amt span')!.textContent = sats(note.amountMsat)
  row.addEventListener('click', () => viewNote(note))
  return row
}

const viewHome = (): void => {
  const w = wallet!
  show(() => {
    const view = el(`<div class="view">
      <div class="top">
        <div class="brand">${icons.logo}<span>NOTECASE</span></div>
        <span class="spacer"></span>
        <button class="btn-icon" data-history data-hint="Everything that has happened" aria-label="History">${icons.history}</button>
        <button class="btn-icon" data-settings data-hint="Mints, backup, security" aria-label="Settings">${icons.settings}</button>
      </div>
      <div class="hero burst-host">
        <div class="amount"><span data-balance>0</span><span class="unit">sat</span></div>
        <div class="mint-chips" data-sub></div>
      </div>
      <div class="actions">
        <button class="tile in" data-go="receive"><span class="roundel">${icons.receive}</span><b>Receive</b><small>Take a note you've been given</small></button>
        <button class="tile out" data-go="send"><span class="roundel">${icons.send}</span><b>Send</b><small>Cut a note to hand to someone</small></button>
        <button class="tile" data-go="mint"><span class="roundel">${icons.mint}</span><b>Mint</b><small>Pay Lightning, get a note</small></button>
        <button class="tile hot" data-go="melt"><span class="roundel">${icons.melt}</span><b>Melt</b><small>Turn a note back into Lightning</small></button>
      </div>
      <div data-lists class="stack"></div>
    </div>`)

    const balance = w.balanceMsat()
    const balanceEl = view.querySelector('[data-balance]')!
    countTo(balanceEl, balance)
    balanceEl.textContent = '0'

    const sub = view.querySelector('[data-sub]') as HTMLElement
    const mints = w.balanceByMint()
    if (mints.size === 0) {
      sub.append(el('<span class="fineline" style="margin-top:6px">nothing minted yet</span>'))
    } else {
      for (const [host, msat] of mints) {
        const chip = el(`<button class="chip"><span></span><b>${sats(msat)}</b></button>`)
        chip.querySelector('span')!.textContent = host
        chip.addEventListener('click', () => viewMints())
        sub.append(chip)
      }
    }

    if (w.needsReconcile()) {
      const chip = el(
        `<button class="badge wait" style="margin-top:14px">${icons.refresh}<span>unresolved outcomes - tap to reconcile</span></button>`
      )
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
      // First run: not an empty shrug but a ladder - each rung is the
      // actual button that does it, and a done rung stays crossed off.
      const hasMint = w.data.mints.length > 0
      lists.append(el('<div class="rubric">Start here</div>'))
      const guide = el('<div class="steps"></div>')
      const stepMint = el(`<button class="step${hasMint ? ' done' : ''}">
        <span class="n">${hasMint ? '✓' : 'I'}</span><b>Add a mint</b>
        <p>${hasMint ? 'Done - your mint is ready below.' : 'A mint strikes and redeems notes. moneyer.dev is one tap away.'}</p>
        <span class="go">${hasMint ? 'Manage mints' : 'Add one now'} ${icons.chevron}</span>
      </button>`)
      stepMint.addEventListener('click', () => viewMints())
      const stepNote = el(`<button class="step">
        <span class="n">${hasMint ? 'I' : 'II'}</span><b>Get a first note</b>
        <p>Mint one by paying a Lightning invoice, or receive one a friend hands you.</p>
        <span class="go">Mint a note ${icons.chevron}</span>
      </button>`)
      stepNote.addEventListener('click', () => viewMint())
      guide.append(
        stepMint,
        stepNote,
        el(`<div class="step">
          <span class="n">${hasMint ? 'II' : 'III'}</span><b>Spend it anywhere</b>
          <p>Hand a note to anyone, split it to the exact amount, or melt it back onto Lightning.</p>
        </div>`)
      )
      lists.append(guide)
    }
    if (live.length) {
      lists.append(el('<div class="rubric">The notes</div>'))
      const stack = el('<div class="stack-tight"></div>')
      live.forEach(note => stack.append(noteRow(w, note)))
      lists.append(stack)
    }
    if (sent.length) {
      lists.append(el('<div class="rubric">Handed over · reclaimable until taken</div>'))
      const stack = el('<div class="stack-tight"></div>')
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
      const fab = el(`<button class="fab" data-hint="Scan anything - note, invoice or mint" aria-label="Scan a QR">${icons.scan}</button>`)
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
    const body = el('<div class="stack center"></div>')

    const print = notePrint(note, toBech32Lnurl(url).toUpperCase())
    body.append(print)

    const badges = el('<div class="badges"></div>')
    const signed = signedOk(w, note)
    const sigBadge = el(`<span class="badge${signed ? ' good' : ''}">${icons.shield}<span></span></span>`)
    sigBadge.querySelector('span')!.textContent = signed ? `signed by ${note.mintHost}` : 'no verified signature'
    badges.append(sigBadge)
    if (note.state === 'sent') {
      badges.append(
        el(`<span class="badge wait">${icons.hourglass}<span>handed over - whoever holds it can spend it</span></span>`)
      )
    }
    body.append(badges)

    // mintHost, origin and id are persisted strings - a crafted backup must
    // never become markup, so they go in as text, not through el().
    const ledger = el(`<div class="card" style="text-align:left">
      <div class="kv"><span>mint</span><b></b></div>
      <div class="kv"><span>came from</span><b></b></div>
      <div class="kv"><span>created</span><b>${when(note.createdAt)}</b></div>
      <div class="kv"><span>note id</span><code></code></div>
    </div>`)
    const [kvMint, kvOrigin] = ledger.querySelectorAll('.kv b')
    kvMint!.textContent = note.mintHost
    kvOrigin!.textContent = note.origin
    ledger.querySelector('.kv code')!.textContent = `${note.id.slice(0, 16)}…`
    body.append(ledger)
    view.append(body)

    if (note.state === 'sent') {
      const reclaim = el(`<button class="btn btn-silver">${icons.undo}<span>Take it back</span></button>`)
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
      body.append(reclaim, taken)
    } else {
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

    strikeIn(print, note.amountMsat, body)
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
    const stack = el('<div class="stack-tight"></div>')
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
      <div class="hint">${icons.info}<span><b>Someone handed you a note?</b> Paste or scan it here. Receiving locks it to this wallet under a fresh secret - the sender can no longer spend it.</span></div>
      <div class="field">
        <label>The note you were given</label>
        <textarea data-input placeholder="lnurlw://… or LNURL1…" autocomplete="off" spellcheck="false"></textarea>
      </div>
      <button class="btn btn-ghost" data-paste>${icons.paste}<span>Paste from clipboard</span></button>
      <button class="btn btn-silver" data-receive>${icons.receive}<span>Receive</span></button>
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
    body.append(
      el(`<div class="hint">${icons.info}<span><b>Handing money to someone?</b> Type the amount and notecase cuts a fresh note for exactly that. You can take it back any time until they receive it.</span></div>`)
    )
    body.append(el('<div class="rubric">To be handed over</div>'))
    body.append(amount.node)
    body.append(el(`<button class="btn btn-silver" data-cut>${icons.send}<span>Cut a note</span></button>`))
    view.append(body)
    const cut = body.querySelector('[data-cut]') as HTMLButtonElement
    cut.addEventListener('click', () =>
      busy(cut, async () => {
        const note = await w.send(amount.msat())
        const url = w.noteUrlFor(note)
        show(() => {
          const done = el('<div class="view"></div>')
          done.append(topBar('Your note', viewHome))
          const inner = el('<div class="stack center"></div>')
          const print = notePrint(note, toBech32Lnurl(url).toUpperCase())
          inner.append(
            print,
            el(`<p class="warn"><strong>Whoever sees this note owns it.</strong> Scratch the silver and show the QR, or share the text - once, to one person. Until they take it, you can reclaim it from the home screen.</p>`)
          )
          const copyUrl = el(`<button class="btn">${icons.copy}<span>Copy note URL</span></button>`)
          copyUrl.addEventListener('click', () => void copyText(url, 'Note URL', true))
          const copyLnurl = el(`<button class="btn btn-ghost">${icons.copy}<span>Copy LNURL</span></button>`)
          copyLnurl.addEventListener('click', () => void copyText(toBech32Lnurl(url), 'LNURL', true))
          inner.append(copyUrl, copyLnurl)
          const share = shareButton(url)
          if (share) inner.append(share)
          done.append(inner)
          strikeIn(print, note.amountMsat, inner)
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
    form.append(
      el(`<div class="hint">${icons.info}<span><b>Turning Lightning into a note?</b> Type what the note should hold - any mint fee is added to the invoice and shown before you pay anything.</span></div>`)
    )
    form.append(el('<div class="rubric">To be struck</div>'))
    form.append(mintPicker(w), amount.node)
    form.append(
      el(`<p class="warn" data-feenote>&nbsp;</p>`),
      el(`<button class="btn btn-silver" data-mintgo>${icons.mint}<span>${w.data.settings.nwcUri ? 'Mint - pay with connected wallet' : 'Create the invoice'}</span></button>`)
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
      <div class="rubric">The invoice</div>
      <div class="amount"><span>${sats(pending.grossMsat)}</span><span class="unit">sat</span></div>
      <p class="warn">Pay from any Lightning wallet - tap the QR to open one on this device. The note (${sats(pending.expectedNetMsat)} sat) is claimed automatically when it settles.</p>
      <p class="pulse" style="color:var(--dim);font-family:var(--mono);font-size:12px;letter-spacing:0.2em;text-transform:uppercase">Waiting for the payment…</p>
    </div>`)
    // the invoice string comes from the mint: assign href as a property,
    // never through HTML where a quote would break out of the attribute
    const qrLink = el('<a style="display:block"></a>') as HTMLAnchorElement
    qrLink.href = `lightning:${pending.pr}`
    qrLink.append(qrCard(pending.pr.toUpperCase()))
    body.insertBefore(qrLink, body.querySelector('p'))
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
      <div class="hint">${icons.info}<span><b>Turning a note back into Lightning?</b> Paste an invoice to pay, send to a Lightning Address${hasNwc ? ', or cash straight into your connected wallet' : ''} - the mint burns the note and pays it out.</span></div>
      <div class="seg" role="tablist">
        <button class="on" data-tab="invoice">Invoice</button>
        <button data-tab="address">Address</button>
        ${hasNwc ? '<button data-tab="nwc">My wallet</button>' : ''}
      </div>
      <div data-pane></div>
      <button class="btn btn-silver" data-meltgo>${icons.melt}<span>Melt</span></button>
      <p class="warn">OK means in flight - the home screen confirms settlement, and a failed melt returns the sats.</p>
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
            <p class="warn">Cash a note straight into your connected NWC wallet.</p>
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
    const body = el('<div class="stack" style="gap:26px"></div>')
    view.append(body)
    body.append(
      el(`<div class="hint">${icons.info}<span><b>A mint strikes and redeems notes.</b> Add one by its address below - its signing key is pinned on first contact, so every note it signs can be checked forever.</span></div>`)
    )

    const balances = w.balanceByMint()
    for (const entry of w.data.mints) {
      const isDefault = entry.host === w.data.settings.defaultMintHost
      const pin = w.data.pubkeyPins[entry.host]
      const fee = entry.mintFee
      const card = el(`<div class="card">
        <div class="kv" style="align-items:center">
          <b style="font-family:var(--display);letter-spacing:0.06em"></b>
          <span class="row" style="gap:8px;flex:none">
            <button class="btn-icon" data-star data-hint="${isDefault ? 'This is the default mint' : 'Make this the default'}" aria-label="Make default" style="color:${isDefault ? 'var(--silver)' : 'var(--dim)'}">${icons.star}</button>
            <button class="btn-icon" data-remove data-hint="Remove this mint" aria-label="Remove">${icons.trash}</button>
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
      <h3>Add a mint</h3>
      <div class="row" style="border:none;padding-top:14px">
        <input data-newmint placeholder="mint@mint.example" autocomplete="off" style="flex:2" />
        <button class="btn" style="flex:1">${icons.plus}<span>Add</span></button>
      </div>
      <div class="presets" data-suggest style="margin-top:12px"></div>
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
    const body = el('<div class="stack" style="gap:26px"></div>')

    // mints
    const mints = el(`<button class="btn">${icons.mint}<span>Mints (${w.data.mints.length})</span></button>`)
    mints.addEventListener('click', () => viewMints())
    body.append(mints)

    // nwc
    const nwc = el(`<div class="card"><h3>Lightning wallet (NWC)</h3></div>`)
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
      const row = el(`<div class="stack" style="padding-top:14px">
        <div class="row" style="align-items:center">
          <input data-nwc type="password" placeholder="nostr+walletconnect://…" autocomplete="off" data-1p-ignore data-lpignore="true" />
          <button class="btn-icon" data-reveal data-hint="Show what you typed" aria-label="Show the connection string" style="flex:none">${icons.eye}</button>
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
    const backup = el(`<div class="card"><h3>Backup</h3>
      <p class="warn" style="text-align:left;padding-top:12px">A backup is sealed under its own passphrase - not the PIN - and restores on any device from the welcome screen.</p>
    </div>`)
    const exportButton = el(`<button class="btn">${icons.download}<span>Download a backup</span></button>`)
    exportButton.addEventListener('click', () => viewExportBackup())
    backup.append(exportButton)
    body.append(backup)

    // security
    const security = el(`<div class="card"><h3>Security</h3></div>`)
    const bioArea = el('<div class="stack" style="padding-top:12px"></div>')

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
    const danger = el(`<div class="card"><h3>Danger</h3></div>`)
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
      <button class="btn btn-silver" data-go>${icons.download}<span>Seal and download</span></button>
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

// ---------- the proofing press ----------
// #/proof prints the live note with a constant secret and an absurd
// denomination - never money, always available, so the print can be
// checked on any screen without paying anyone.

const viewProof = (): void => {
  const amountMsat = 600_000_000_000_000
  const k1 = '11'.repeat(32)
  const url = buildNoteUrl('lnurlw://moneyer.dev/w', k1, amountMsat)
  show(() => {
    const view = el('<div class="view"></div>')
    view.append(
      topBar('The proofing press', () => {
        location.hash = ''
        location.reload()
      })
    )
    const body = el('<div class="stack center"></div>')
    const print = notePrint({id: hashK1(k1), amountMsat, mintHost: 'moneyer.dev'}, toBech32Lnurl(url).toUpperCase())
    body.append(
      print,
      el(`<p class="warn">A proof print: the secret is a constant, the denomination absurd - this is never money. Scratch it anyway.</p>`)
    )
    view.append(body)
    strikeIn(print, amountMsat, body)
    return view
  })
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
if (location.hash === '#/proof') {
  viewProof()
} else if (walletExists()) {
  void viewLocked()
} else if (pendingClaim) {
  // A claim link on a fresh device: set up first, the note is kept for after.
  viewWelcome()
  toast('A note is waiting - set up the wallet to receive it.', 'ok')
} else {
  viewWelcome()
}
