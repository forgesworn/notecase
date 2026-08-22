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
import {Wallet, BadSignatureError, WalletUsageError, InsufficientFundsError, PinMismatchError} from '../../src/wallet.ts'
import type {CheckReport, OfflineHandover} from '../../src/wallet.ts'
import {exportBackup, importBackup} from '../../src/backup.ts'
import {payWithNwc, invoiceFromNwc, nwcStatus} from '../../src/nwc.ts'
import {npubOf, poolTransport, type NostrTransport} from '../../src/nostr.ts'
import type {NoteRecord, PendingMint} from '../../src/types.ts'
import {
  biometricAvailable,
  biometricEnabled,
  createBrowserWallet,
  freshWalletData,
  enableBiometric,
  forgetBrowserWallet,
  unlockWithBiometric,
  unlockWithPin,
  walletExists,
  type BrowserStore
} from './browser-store.ts'
import {nfcAvailable, scanAvailable, scanNfc, scanQr, writeNfc} from './scanner.ts'
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

// The fragment is scrubbed the instant it is read, so the claim must
// survive a reload some other way or the note is gone: a locked wallet, a
// first-run setup, or the service worker's own "new version - Reload"
// prompt all interrupt the hand-off, and a reload would otherwise take the
// only copy of a live secret with it. sessionStorage is the right depth -
// it survives reload and navigation within this tab, and dies when the tab
// does, so a bearer secret never outlives the visit that carried it.
const CLAIM_KEY = 'notecase:pending-claim'

let claimMemory: string | null = null
// The offer is made once per page load; the claim itself stays until it is
// actually received, so backing out of Receive does not destroy the note.
let claimOffered = false

const rememberClaim = (url: string | null): void => {
  claimMemory = url
  try {
    if (url) sessionStorage.setItem(CLAIM_KEY, url)
    else sessionStorage.removeItem(CLAIM_KEY)
  } catch {
    // private mode or storage disabled: the in-memory copy still works for
    // an uninterrupted hand-off, which is the common case
  }
}

const takeClaim = (): string | null => {
  if (claimMemory) return claimMemory
  try {
    return sessionStorage.getItem(CLAIM_KEY)
  } catch {
    return null
  }
}

const readClaimHash = (): void => {
  const match = location.hash.match(/^#\/claim\?(.+)$/)
  if (!match) return
  const params = new URLSearchParams(match[1]!)
  const u = params.get('u')
  const k1 = params.get('k1')
  const amount = Number(params.get('a'))
  // `u` arrives schemeless - lnurl-vault writes "?u=mint.example/w" into the
  // QR, spending no QR capacity on a scheme it can imply. buildNoteUrl wants
  // a withdrawLink, and new URL('mint.example/w') throws, so handing it the
  // raw param meant every scan from a vault landed in the catch below and
  // silently claimed nothing.
  //
  // lnurlw:// rather than https:// because LUD-17 is what decides the scheme,
  // and it does not always choose https: an .onion or a localhost endpoint
  // resolves to http, and forcing https there breaks a mint that works.
  const withdrawLink = u && /^[a-z]+:\/\//i.test(u) ? u : u && `lnurlw://${u}`
  try {
    if (withdrawLink && k1)
      rememberClaim(buildNoteUrl(withdrawLink, k1, Number.isSafeInteger(amount) && amount > 0 ? amount : undefined))
    else if (withdrawLink) rememberClaim(resolveNoteInput(withdrawLink))
  } catch {
    rememberClaim(null)
  }
  history.replaceState(null, '', location.pathname + location.search)
}

// ---------- the share target ----------
// "Share to notecase" from any app lands on /share?text=… The payload can
// be a live note URL, so it gets the same handling the claim fragment
// gets: stashed in sessionStorage, scrubbed out of the address bar at
// once, and never accepted on its own - it goes to the screen that asks.

const SHARE_KEY = 'notecase:pending-share'

// Where the service worker leaves a POSTed share for the page to collect.
// Must match share-handler.js, which is a separate file precisely because
// it has to be importable into the generated worker.
const SHARE_CACHE = 'notecase-pending-share'
const SHARE_STASH = '/__notecase_pending_share__'

// Android puts a shared URL in `text` about as often as in `url`, and some
// apps share a sentence with the link inside it. Take the first thing that
// looks like something this wallet understands.
//
// The worker stashes the raw fields without understanding any of this, so
// the POST path and the GET fallback both end up here rather than keeping
// two ideas of which field holds the money.
export const shareTargetPick = (fields: Array<string | null>): string | null => {
  for (const field of fields.filter((value): value is string => Boolean(value))) {
    const whole = field.trim()
    if (!whole) continue
    const candidates = [whole, ...whole.split(/\s+/)]
    for (const candidate of candidates) {
      const value = candidate.replace(/^lightning:/i, '').trim()
      if (!value) continue
      if (resolveNoteInput(value) || isBolt11Invoice(value) || resolveMintInput(value)) return value
    }
  }
  return null
}

export const shareTargetInput = (search: string): string | null => {
  const params = new URLSearchParams(search)
  return shareTargetPick([params.get('url'), params.get('text'), params.get('title')])
}

let shareMemory: string | null = null
let shareOffered = false

const rememberShare = (value: string | null): void => {
  shareMemory = value
  try {
    if (value) sessionStorage.setItem(SHARE_KEY, value)
    else sessionStorage.removeItem(SHARE_KEY)
  } catch {
    // private mode: the in-memory copy still serves this visit
  }
}

const takeShare = (): string | null => {
  if (shareMemory) return shareMemory
  try {
    return sessionStorage.getItem(SHARE_KEY)
  } catch {
    return null
  }
}

// The GET fallback. Kept because a share can still arrive this way: the
// worker may not be controlling the page yet on the very first install, and
// losing somebody's note to a purist refusal would be the worse bug. The
// address bar is scrubbed at once, exactly as it always was.
const readShareTarget = (): void => {
  if (!location.pathname.startsWith('/share')) return
  rememberShare(shareTargetInput(location.search))
  history.replaceState(null, '', '/')
}

// The POST path. The worker has already redirected us to a clean root and
// left the fields in a cache, so there is nothing in the URL to scrub - the
// secret was never in one. Cleared as it is read: a share is collected once.
export const collectPostedShare = async (): Promise<string | null> => {
  if (typeof caches === 'undefined') return null
  try {
    const cache = await caches.open(SHARE_CACHE)
    const stashed = await cache.match(SHARE_STASH)
    if (!stashed) return null
    await cache.delete(SHARE_STASH)
    const payload = (await stashed.json()) as {title?: string; text?: string; url?: string}
    return shareTargetPick([payload.url ?? null, payload.text ?? null, payload.title ?? null])
  } catch {
    return null
  }
}

// ---------- offline mode ----------
// Asked for, never guessed at. The kit's `offline` option is a promise
// that no call goes out, and a promise cannot be made from a connectivity
// reading that is wrong as often as it is right. So it is a switch, and it
// stays where the holder left it.

const OFFLINE_KEY = 'notecase:offline'

let offlineMode = (() => {
  try {
    return localStorage.getItem(OFFLINE_KEY) === '1'
  } catch {
    return false
  }
})()

const setOfflineMode = (on: boolean): void => {
  offlineMode = on
  try {
    localStorage.setItem(OFFLINE_KEY, on ? '1' : '0')
  } catch {
    // private mode: the switch still works for this visit
  }
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

// What to send someone who may have no wallet that speaks LUD-25: the note
// is an ordinary LNURL-withdraw, so any Lightning wallet cashes it out, and
// the claim link keeps it as a note in this wallet instead.
const redeemMessage = (note: {amountMsat: number; mintHost: string}, url: string): string => {
  const parsed = new URL(url)
  const claim = new URLSearchParams({
    u: `${parsed.host}${parsed.pathname}`,
    k1: parsed.searchParams.get('k1') ?? '',
    a: String(note.amountMsat)
  })
  return [
    `Here's ${sats(note.amountMsat)} sat for you, as a Lightning bearer note.`,
    '',
    `To cash it into any Lightning wallet (Wallet of Satoshi, Phoenix, Zeus…): scan or paste this, it's an LNURL withdraw:`,
    toBech32Lnurl(url).toUpperCase(),
    '',
    `Or keep it as a note: ${location.origin}/#/claim?${claim.toString()}`,
    '',
    'Whoever has this can spend it, so use it once and don\'t forward it.'
  ].join('\n')
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

// Reading a tag: the same shape as the camera button, and it renders only
// where Web NFC exists at all, which is Chrome on Android.
const tapButton = (onRead: (value: string) => void): HTMLElement | null => {
  if (!nfcAvailable()) return null
  const button = el(`<button class="btn btn-ghost">${icons.tag}<span>Tap a tag</span></button>`)
  button.addEventListener('click', async () => {
    const value = await scanNfc()
    if (value) onRead(value)
    else if (value === null) toast('Nothing readable on that tag.', '')
  })
  return button
}

// Writing one: a note URL in a single URI record, which is all a tag needs
// to be a coin. The warning is the clipboard's, because a tag is worse -
// it can be read by anybody who taps it.
const writeTagButton = (url: string): HTMLElement | null => {
  if (!nfcAvailable()) return null
  const button = el(`<button class="btn btn-ghost">${icons.tag}<span>Write to a tag</span></button>`)
  button.addEventListener('click', async () => {
    const written = await writeNfc(url)
    if (written) {
      toast(
        'Written. That tag is now the money: anyone who taps it owns the sats, so hand it to exactly one person.',
        'ok'
      )
    }
  })
  return button
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
        <button class="btn btn-ghost" data-words>${icons.check}<span>Restore from your words</span></button>
        <button class="btn btn-ghost" data-restore>${icons.upload}<span>Restore a backup file</span></button>
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
    view.querySelector('[data-words]')!.addEventListener('click', viewWordsRestore)

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
              const fresh = freshWalletData()
              store = await createBrowserWallet(first, fresh.data)
              wallet = new Wallet(store.data, store.save, WALLET_OPTS)
              viewWords(fresh.mnemonic, () => {
                viewHome()
                toast('Wallet created. Mint or receive your first note.', 'ok')
              })
              return 'ok'
            }
          })
        )
        return 'ok'
      }
    })
  )

// The twelve words, once, with a gate. Not a screen to hurry past: it is
// the only thing that gets the money back if this device goes in a river.
const viewWords = (mnemonic: string, done: () => void): void => {
  show(() => {
    const view = el('<div class="view"></div>')
    const body = el(`<div class="stack">
      <div class="rubric">Your recovery words</div>
      <div class="hint">${icons.info}<span><b>Write these twelve words on paper, in this order.</b> They are the only way back to your notes if this device is lost or wiped. Anyone who reads them owns everything this wallet will ever hold, so do not photograph them and do not type them into anything else.</span></div>
      <div class="mono" data-words></div>
      <button class="btn btn-ghost" data-copy>${icons.copy}<span>Copy them</span></button>
      <label class="row" style="border:none;gap:12px;align-items:center;cursor:pointer">
        <input type="checkbox" data-gate style="width:22px;height:22px;flex:none" />
        <span>I have written them down somewhere safe.</span>
      </label>
      <button class="btn btn-silver" data-done disabled>${icons.check}<span>Done</span></button>
    </div>`)
    // the words are a secret out of the store: text, never markup
    body.querySelector('[data-words]')!.textContent = mnemonic
      .split(' ')
      .map((word, index) => `${index + 1}. ${word}`)
      .join('    ')
    body.querySelector('[data-copy]')!.addEventListener('click', () => void copyText(mnemonic, 'Your recovery words', true))
    const gate = body.querySelector('[data-gate]') as HTMLInputElement
    const finish = body.querySelector('[data-done]') as HTMLButtonElement
    gate.addEventListener('change', () => {
      finish.disabled = !gate.checked
    })
    finish.addEventListener('click', () => done())
    view.append(body)
    return view
  })
}

// Coming back from twelve words on a new device. The wallet is rebuilt
// empty: the notes are at the mints, and asking them is the next step.
const viewWordsRestore = (): void =>
  show(() => {
    const view = el('<div class="view"></div>')
    view.append(topBar('Restore from your words', viewWelcome))
    const body = el(`<div class="stack">
      <div class="hint">${icons.info}<span><b>Twelve words, in order.</b> They rebuild the secrets this wallet makes; the notes themselves are still at your mints, so the next step is to add each mint and ask it what is still yours.</span></div>
      <div class="field">
        <label>Your recovery words</label>
        <textarea data-words rows="3" placeholder="word one word two …" autocomplete="off" spellcheck="false"></textarea>
      </div>
      <button class="btn btn-silver" data-go>${icons.check}<span>Restore</span></button>
      <p class="warn">If someone else has these words, they can take everything this wallet holds. Never type words somebody sent you.</p>
    </div>`)
    view.append(body)
    const go = body.querySelector('[data-go]') as HTMLButtonElement
    go.addEventListener('click', () =>
      busy(go, async () => {
        const words = (body.querySelector('[data-words]') as HTMLTextAreaElement).value
        const fresh = freshWalletData(words)
        show(() =>
          pinPad({
            title: 'Choose a PIN',
            subtitle: 'A fresh PIN for this device. Your words stay what they are.',
            onComplete: async pin => {
              store = await createBrowserWallet(pin, fresh.data)
              wallet = new Wallet(store.data, store.save, WALLET_OPTS)
              viewHome()
              toast('Restored. Add the mints you used, then ask them what is still yours.', 'ok')
              return 'ok'
            }
          })
        )
      })
    )
    return view
  })

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
  if (!note.signature) return false
  const keys = [w.data.pubkeyPins[note.mintHost], ...w.pubkeyHistoryFor(note.mintHost)]
  // a key the mint has since retired still proves where the note came from
  return keys.some(key => Boolean(key) && verifyNoteSignature(note.k1, note.amountMsat, note.signature!, key!))
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
        <button class="btn-icon" data-offline data-hint="${offlineMode ? 'Offline mode is on - tap to talk to mints again' : 'Offline mode: hand notes over with nothing on the wire'}" aria-label="Offline mode" aria-pressed="${offlineMode}" style="color:${offlineMode ? 'var(--warn)' : 'var(--dim)'}">${icons.offline}</button>
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

    const address = w.lightningAddress()
    if (address) {
      const chip = el(`<button class="chip" data-address style="margin-top:6px"><span></span><b>copy</b></button>`)
      chip.querySelector('span')!.textContent = address
      chip.addEventListener('click', () => void copyText(address, 'Your lightning address'))
      sub.append(chip)
    }

    const unrotated = w.unrotatedMsat()
    if (unrotated > 0) {
      sub.append(el(`<span class="fineline" style="margin-top:6px">of which ${sats(unrotated)} sat taken offline, not rotated yet</span>`))
    }
    if (offlineMode) {
      view.querySelector('.hero')!.append(
        el(`<span class="badge wait" style="margin-top:14px">${icons.offline}<span>offline mode - no mint is called</span></span>`)
      )
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
    view.querySelector('[data-offline]')!.addEventListener('click', () => {
      setOfflineMode(!offlineMode)
      toast(
        offlineMode
          ? 'Offline mode on. Notes are handed over and taken on the mint signature alone, with nothing sent to a mint.'
          : 'Offline mode off. Notes are rotated at the mint again.',
        'ok'
      )
      viewHome()
    })
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

  // Offered once per load, but NOT consumed here: the claim survives until
  // the receive actually lands, so backing out, locking, or reloading
  // cannot strand the note.
  const claim = takeClaim()
  if (claim && !claimOffered) {
    claimOffered = true
    viewReceive(claim)
    toast('A note arrived - check it and receive.', 'ok')
    return
  }

  // What a mint wants its holders to know today. Shown once, and again
  // only when the text actually changes - a notice that reappears on every
  // visit is a notice people learn to dismiss without reading. It is the
  // operator's own words, so it goes in as text and is labelled as theirs.
  for (const notice of w.unreadMotds()) {
    const banner = el(`<div class="hint" style="margin-bottom:14px">${icons.info}<span><b></b> <i></i> <em class="fineline"></em></span></div>`)
    banner.querySelector('b')!.textContent = `${notice.name ?? notice.host} says:`
    banner.querySelector('i')!.textContent = notice.motd
    banner.querySelector('em')!.textContent = ' (the mint\'s own words)'
    // The view is already mounted by this point, so the banner goes into
    // the live document rather than the builder's local tree.
    document.querySelector('[data-lists]')?.prepend(banner)
    void w.markMotdSeen(notice.host)
  }

  // Something shared into the wallet from another app. Routed by what it
  // is, never accepted on its own.
  const shared = takeShare()
  if (shared && !shareOffered) {
    shareOffered = true
    rememberShare(null)
    classifyScan(shared)
    toast('Shared into notecase - check it before you take it.', 'ok')
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
    if (note.sentTo) ledger.append(el(`<div class="kv"><span>sealed to</span><b>${esc(shortNpub(note.sentTo))}</b></div>`))
    if (note.receivedFrom) ledger.append(el(`<div class="kv"><span>from</span><b>${esc(shortNpub(note.receivedFrom))}</b></div>`))
    if (note.zap) {
      const zapper = el('<div class="kv"><span>zap from</span><b></b></div>')
      zapper.querySelector('b')!.textContent = shortNpub(note.zap.senderPubkey)
      ledger.append(zapper)
      if (note.zap.content) {
        // a stranger's words: text, never markup
        const said = el('<div class="kv"><span>they wrote</span><b></b></div>')
        said.querySelector('b')!.textContent = note.zap.content
        ledger.append(said)
      }
    }
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
      events.push(
        note.zap
          ? {
              at: note.createdAt,
              icon: icons.bolt,
              // who and what they wrote, off the payer's own signed request
              text: `Zap of ${sats(note.amountMsat)} sat from ${shortNpub(note.zap.senderPubkey)}${note.zap.content ? `: ${note.zap.content}` : ''}`,
              kind: 'in'
            }
          : {at: note.createdAt, icon: icons.receive, text: `Received ${sats(note.amountMsat)} sat (${note.mintHost}).`, kind: 'in'}
      )
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
      <div class="hint">${icons.info}<span>${
        offlineMode
          ? '<b>Taking a note with no connection?</b> Paste or scan it here. It is checked against the signature of the mint that made it, using the key this wallet already has, so nothing needs to be sent anywhere. The person who gave it to you still knows its secret until you are back online and reconcile.'
          : '<b>Someone handed you a note?</b> Paste or scan it here. Receiving locks it to this wallet under a fresh secret - the sender can no longer spend it.'
      }</span></div>
      <div class="field">
        <label>The note you were given</label>
        <textarea data-input placeholder="lnurlw://… or LNURL1…" autocomplete="off" spellcheck="false"></textarea>
      </div>
      <button class="btn btn-ghost" data-paste>${icons.paste}<span>Paste from clipboard</span></button>
      <button class="btn btn-silver" data-receive>${icons.receive}<span>${offlineMode ? 'Take it offline' : 'Receive'}</span></button>
      ${
        offlineMode
          ? ''
          : `<div class="rubric">Or over Nostr</div>
      <div class="hint">${icons.info}<span><b>Sent to your npub?</b> Notes sealed to this wallet's key wait on your inbox relays. Checking opens them and locks each one to this wallet at once.</span></div>
      <button class="btn" data-inbox>${icons.refresh}<span>Check my inbox</span></button>`
      }
    </div>`)
    view.append(body)
    const input = body.querySelector('textarea')!
    if (prefill) input.value = prefill
    const inbox = body.querySelector('[data-inbox]') as HTMLButtonElement | null
    inbox?.addEventListener('click', () =>
      busy(inbox, async () => {
        const result = await withRelays(t => w.receiveFromNostr(t))
        for (const r of result.received) r.warnings.forEach(warning => toast(warning, 'err'))
        for (const sk of result.skipped) toast(`Skipped one: ${sk.reason}`, 'err')
        if (result.received.length) {
          burst(body)
          const total = result.received.reduce((sum, r) => sum + r.note.amountMsat, 0)
          toast(`Received ${sats(total)} sat from ${result.received.length === 1 ? 'one note' : `${result.received.length} notes`}`, 'ok')
          setTimeout(viewHome, 650)
        } else if (!result.skipped.length) {
          toast('Nothing waiting', '')
        }
      })
    )
    body.querySelector('[data-paste]')!.addEventListener('click', async () => {
      input.value = await navigator.clipboard.readText().catch(() => input.value)
    })
    const fill = (value: string): void => {
      input.value = value.replace(/^lightning:/i, '')
    }
    const scan = scanButton(fill)
    if (scan) body.insertBefore(scan, body.querySelector('[data-receive]'))
    const tap = tapButton(fill)
    if (tap) body.insertBefore(tap, body.querySelector('[data-receive]'))
    const receiveButton = body.querySelector('[data-receive]') as HTMLButtonElement
    // Where a refused note explains itself. Sits directly above the button
    // that was pressed, so the answer is where the eye already is.
    const refusal = el('<div class="stack" data-refusal style="gap:14px"></div>')
    body.insertBefore(refusal, receiveButton)

    const take = async (acceptBadSignature: boolean): Promise<void> => {
      try {
        const result = offlineMode
          ? await w.receiveOffline(input.value.trim())
          : await w.receive(input.value.trim(), {acceptBadSignature})
        result.warnings.forEach(warning => toast(warning, 'err'))
        // Safely in the store and rotated: only now is it safe to forget
        // the incoming claim.
        rememberClaim(null)
        refusal.replaceChildren()
        burst(body)
        toast(`Received ${sats(result.note.amountMsat)} sat`, 'ok')
        setTimeout(viewHome, 650)
      } catch (err) {
        if (!(err instanceof BadSignatureError)) throw err
        showRefusal(err.message)
      }
    }

    // A failed signature is a refusal, not a warning: the card says what
    // went wrong in plain words and the way past it takes two deliberate
    // taps, because the only honest reason to override is that you already
    // know something the wallet does not.
    const showRefusal = (reason: string): void => {
      refusal.replaceChildren()
      const card = el(`<div class="card" style="border-color:var(--bad)">
        <h3 style="color:var(--bad)">Not received</h3>
        <p class="warn" style="text-align:left;padding-top:12px"><strong>This note failed its check.</strong> <span data-reason></span></p>
        <p class="warn" style="text-align:left">Every note is signed by the mint that made it. This signature does not match the key that mint has always used here, so either the note was altered on the way to you, or it did not come from that mint. Ask whoever gave it to you for another one.</p>
      </div>`)
      // the reason names a host and comes off the wire: text, never markup
      card.querySelector('[data-reason]')!.textContent = `${reason}.`
      if (offlineMode) {
        // Offline the signature is the ONLY thing that can be checked.
        // There is nothing to fall back on, so there is nothing to offer.
        card.append(
          el(`<p class="warn" style="text-align:left">With no connection there is nothing else to check this against, so it cannot be taken. Ask for another note, or take this one once you are back online.</p>`)
        )
        refusal.append(card)
        return
      }
      const accept = el(`<button class="btn btn-ghost danger-text"><span>Take it anyway</span></button>`)
      const label = accept.querySelector('span')!
      let armed = false
      accept.addEventListener('click', () => {
        if (!armed) {
          armed = true
          label.textContent = 'Tap again to take a note that failed its check'
          return
        }
        void busy(accept as HTMLButtonElement, () => take(true))
      })
      card.append(accept)
      refusal.append(card)
    }

    receiveButton.addEventListener('click', () => busy(receiveButton, () => take(false)))
    return view
  })
}

// One relay pool per action: opened for the call, closed after, so a
// backgrounded tab holds no sockets.
const withRelays = async <T>(work: (transport: NostrTransport) => Promise<T>): Promise<T> => {
  const transport = poolTransport()
  try {
    return await work(transport)
  } finally {
    transport.close()
  }
}

const shortNpub = (hex: string): string => {
  const npub = npubOf(hex)
  return `${npub.slice(0, 12)}…${npub.slice(-6)}`
}

// A handover made with nothing on the wire. Several notes may be needed,
// since offline nothing can be cut to size - and they are shown one page
// at a time, because two bearer secrets on one screen is one too many.
const handedOver = (handed: OfflineHandover): void => {
  let page = 0
  const draw = (): void => {
    show(() => {
      const note = handed.notes[page]!
      const url = handed.urls[page]!
      const view = el('<div class="view"></div>')
      view.append(topBar(handed.notes.length === 1 ? 'Hand this over' : `Note ${page + 1} of ${handed.notes.length}`, viewHome))
      const inner = el('<div class="stack center"></div>')
      const print = notePrint(note, toBech32Lnurl(url).toUpperCase())
      inner.append(print)
      if (handed.notes.length > 1) {
        inner.append(
          el(`<p class="warn">These ${handed.notes.length} notes are worth ${sats(handed.totalMsat)} sat together. Hand over every one of them.</p>`)
        )
      }
      if (handed.overpayMsat > 0) {
        inner.append(
          el(`<p class="warn"><strong>This is ${sats(handed.overpayMsat)} sat more than you asked for.</strong> Offline, nothing can be cut to size.</p>`)
        )
      }
      inner.append(
        el(`<p class="warn"><strong>Whoever sees this note owns it.</strong> Scratch the silver and show the QR. Nothing was sent to the mint, so until they take it you can reclaim it from the home screen.</p>`)
      )
      const copyUrl = el(`<button class="btn">${icons.copy}<span>Copy note URL</span></button>`)
      copyUrl.addEventListener('click', () => void copyText(url, 'Note URL', true))
      inner.append(copyUrl)
      const share = shareButton(url)
      if (share) inner.append(share)
      const tag = writeTagButton(url)
      if (tag) inner.append(tag)
      if (handed.notes.length > 1) {
        const pager = el('<div class="row" style="gap:12px;border:none"></div>')
        const back = el(`<button class="btn btn-ghost" style="flex:1">Previous</button>`)
        const next = el(`<button class="btn btn-ghost" style="flex:1">Next note</button>`)
        back.addEventListener('click', () => {
          page = (page - 1 + handed.notes.length) % handed.notes.length
          draw()
        })
        next.addEventListener('click', () => {
          page = (page + 1) % handed.notes.length
          draw()
        })
        pager.append(back, next)
        inner.append(pager)
      }
      view.append(inner)
      strikeIn(print, note.amountMsat, inner)
      return view
    })
  }
  draw()
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
      el(`<div class="hint">${icons.info}<span>${
        offlineMode
          ? '<b>Paying with no connection?</b> Nothing can be cut to size without the mint, so notecase finds notes you already hold that add up to the amount. Keep a few small ones in the cash drawer and this almost always works.'
          : '<b>Handing money to someone?</b> Type the amount and notecase cuts a fresh note for exactly that. You can take it back any time until they receive it.'
      }</span></div>`)
    )
    body.append(el('<div class="rubric">To be handed over</div>'))
    body.append(amount.node)
    const to = el(`<div class="field">
      <label>To an npub or NIP-05 <span class="fineline">optional · seals the note to their key and leaves it on their inbox relays</span></label>
      <input data-npub type="text" placeholder="npub1… or name@domain" autocomplete="off" spellcheck="false" />
    </div>`)
    if (!offlineMode) body.append(to)
    const offer = el('<div class="stack" data-offer style="gap:14px"></div>')
    body.append(offer)
    body.append(
      el(`<button class="btn btn-silver" data-cut>${icons.send}<span>${offlineMode ? 'Find notes to hand over' : 'Cut a note'}</span></button>`)
    )
    view.append(body)
    const npubInput = to.querySelector('[data-npub]') as HTMLInputElement
    const cut = body.querySelector('[data-cut]') as HTMLButtonElement
    cut.addEventListener('click', () =>
      busy(cut, async () => {
        if (offlineMode) {
          offer.replaceChildren()
          const selection = w.planOfflineSend(amount.msat())
          if (selection.overpayMsat > 0) {
            // Nothing can be split offline, so the only honest options are
            // to hand over more than was asked for, or not to.
            const card = el(`<div class="card">
              <h3>Nothing here makes that exactly</h3>
              <p class="warn" style="text-align:left;padding-top:12px">Without a mint a note cannot be cut down. The closest these notes come is <b data-total></b>, which is <b data-over></b> more than you asked for.</p>
            </div>`)
            card.querySelector('[data-total]')!.textContent = `${sats(selection.totalMsat)} sat`
            card.querySelector('[data-over]')!.textContent = `${sats(selection.overpayMsat)} sat`
            const anyway = el(`<button class="btn btn-ghost">${icons.send}<span>Hand over ${sats(selection.totalMsat)} sat</span></button>`)
            anyway.addEventListener('click', () =>
              busy(anyway as HTMLButtonElement, async () =>
                handedOver(await w.sendOffline(amount.msat(), undefined, {acceptOverpay: true}))
              )
            )
            card.append(anyway)
            offer.append(card)
            return
          }
          handedOver(await w.sendOffline(amount.msat()))
          return
        }
        const recipient = npubInput.value.trim()
        if (recipient) {
          const sent = await withRelays(t => w.sendToNostr(t, amount.msat(), recipient))
          show(() => {
            const done = el('<div class="view"></div>')
            done.append(topBar('Sent over Nostr', viewHome))
            const inner = el('<div class="stack center"></div>')
            inner.append(
              el(`<div class="card"><h3>${sats(sent.note.amountMsat)} sat</h3><div class="kv"><span>to</span><b>${esc(shortNpub(sent.recipientHex))}</b></div>
                <div class="kv"><span>on</span><b>${sent.relays.length ? esc(sent.relays.join(', ')) : 'no relay took it'}</b></div></div>`)
            )
            if (!sent.inboxKnown) {
              inner.append(el(`<p class="warn">They publish no inbox relays, so the note went to yours. Tell them to look there, or take it back and hand it over another way.</p>`))
            }
            if (!sent.relays.length) {
              inner.append(el(`<p class="warn"><strong>Nothing was delivered.</strong> The note is still yours: take it back from the home screen.</p>`))
            } else {
              inner.append(el(`<p class="warn">The secret never left your wallet in the clear. Until they open it, you can take it back from the home screen.</p>`))
            }
            done.append(inner)
            burst(inner)
            return done
          })
          return
        }
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
          // For someone who has never heard of a mint: the note as text they
          // can paste into any Lightning wallet, and a link that keeps it as a
          // note here, with one line on what to do.
          const message = redeemMessage(note, url)
          const copyMessage = el(`<button class="btn btn-ghost">${icons.copy}<span>Copy a message for them</span></button>`)
          copyMessage.addEventListener('click', () => void copyText(message, 'Message', true))
          inner.append(copyMessage)
          const share = shareButton(message)
          if (share) inner.append(share)
          const tag = writeTagButton(url)
          if (tag) inner.append(tag)
          done.append(inner)
          strikeIn(print, note.amountMsat, inner)
          return done
        })
      })
    )
    return view
  })
}

// ---------- hardware signer ----------

// A heartwood signer as a note locker: notes zapped or sent to its npub
// land there, and this is where they come off it. Every gated step is a
// hold on the device, so each one says so before it starts.
const viewSigner = (): void => {
  const w = wallet!
  show(() => {
    const view = el('<div class="view"></div>')
    view.append(topBar('Hardware signer', viewSettings))
    const body = el('<div class="stack"></div>')
    view.append(body)
    const link = w.heartwoodLink()

    if (!link) {
      body.append(
        el(`<div class="hint">${icons.info}<span><b>A heartwood signer holds notes behind a button.</b> Pair it here and you can bring those notes into this wallet, trust a mint so zaps land without a hold, and publish where senders should leave them.</span></div>`)
      )
      const field = el(`<div class="field">
        <label>Bunker URI <span class="fineline">from the device's pairing screen or Sapwood</span></label>
        <input data-uri type="text" placeholder="bunker://…?relay=…&secret=…" autocomplete="off" spellcheck="false" />
      </div>`)
      body.append(field)
      const uriInput = field.querySelector('[data-uri]') as HTMLInputElement
      const scan = scanButton(value => {
        uriInput.value = value
      })
      if (scan) body.append(scan)
      const pair = el(`<button class="btn btn-silver">${icons.shield}<span>Pair</span></button>`) as HTMLButtonElement
      pair.addEventListener('click', () =>
        busy(pair, async () => {
          const uri = uriInput.value.trim()
          if (!uri) throw new WalletUsageError('Paste the bunker URI first.')
          await withRelays(t => w.linkHeartwood(t, uri))
          toast('Paired with the signer.', 'ok')
          viewSigner()
        })
      )
      body.append(pair)
      return view
    }

    body.append(
      el(`<div class="card"><h3>Paired</h3>
        <div class="kv"><span>device</span><b>${esc(shortNpub(link.devicePubkey))}</b></div>
        <div class="kv"><span>relays</span><b>${esc(link.relays.join(', '))}</b></div></div>`)
    )

    // ---- notes on the device ----
    const notesCard = el(`<div class="card"><h3>Notes on the device</h3><div data-list><p class="fineline">Loading…</p></div></div>`)
    body.append(notesCard)
    const list = notesCard.querySelector('[data-list]') as HTMLElement
    const progress = el('<div class="stack" data-progress></div>')
    const collect = el(`<button class="btn btn-silver">${icons.receive}<span>Collect into this wallet</span></button>`) as HTMLButtonElement
    const refresh = el(`<button class="btn btn-ghost">${icons.refresh}<span>Refresh</span></button>`) as HTMLButtonElement
    notesCard.append(progress, collect, refresh)
    const paintNotes = async () => {
      list.innerHTML = '<p class="fineline">Asking the device…</p>'
      try {
        const notes = await withRelays(t => w.heartwoodNotes(t))
        const waiting = notes.filter(n => n.state === 'confirmed' && n.from)
        list.innerHTML = ''
        if (!notes.length) list.append(el('<p class="fineline">The device holds no notes.</p>'))
        for (const n of notes) {
          const who = n.from ? `from ${shortNpub(n.from)}` : n.sent_to ? `sent to ${shortNpub(n.sent_to)}` : ''
          list.append(
            el(`<div class="kv"><span>${esc(n.state)}</span><b>${sats(n.amount_msat)} sat · ${esc(n.host)}${who ? ` · ${esc(who)}` : ''}</b></div>`)
          )
        }
        collect.disabled = !waiting.length
        ;(collect.querySelector('span') as HTMLElement).textContent = waiting.length
          ? `Collect ${waiting.length} note${waiting.length === 1 ? '' : 's'} (${sats(waiting.reduce((a, n) => a + n.amount_msat, 0))} sat)`
          : 'Nothing to collect'
      } catch (err) {
        list.innerHTML = ''
        list.append(el(`<p class="warn">${esc((err as Error).message)}</p>`))
      }
    }
    refresh.addEventListener('click', () => void paintNotes())
    collect.addEventListener('click', () =>
      busy(collect, async () => {
        progress.innerHTML = ''
        progress.append(el(`<p class="warn"><strong>Watch the device.</strong> Each note needs two holds: one to release it, one to mark it spent once this wallet has it.</p>`))
        const result = await withRelays(t =>
          w.collectFromHeartwood(t, step => progress.append(el(`<p class="fineline">${esc(step)}</p>`)))
        )
        for (const r of result.collected) progress.append(el(`<p class="fineline">${icons.check} Collected ${sats(r.note.amountMsat)} sat at ${esc(r.note.mintHost)}.</p>`))
        for (const f of result.failed) progress.append(el(`<p class="warn">${esc(f.id)}: ${esc(f.reason)}</p>`))
        if (result.collected.length) {
          toast(`Collected ${result.collected.length} note${result.collected.length === 1 ? '' : 's'}.`, 'ok')
          burst(progress)
        }
        await paintNotes()
      })
    )
    void paintNotes()

    // ---- trusted senders ----
    const trustCard = el(`<div class="card"><h3>Trusted senders</h3>
      <p class="warn" style="text-align:left;padding-top:12px">A note from a trusted key is stored on the device without a hold. Trust a mint's zap key here (it is the <code>nostrPubkey</code> on its zap payRequest) and zaps to your address land on the signer by themselves.</p>
      <div data-trusted></div>
      <div class="field"><label>Sender <span class="fineline">npub, hex or NIP-05</span></label><input data-sender type="text" placeholder="npub1…" autocomplete="off" spellcheck="false" /></div></div>`)
    body.append(trustCard)
    const trustedList = trustCard.querySelector('[data-trusted]') as HTMLElement
    const senderInput = trustCard.querySelector('[data-sender]') as HTMLInputElement
    const trustButton = el(`<button class="btn">${icons.shield}<span>Trust (one hold)</span></button>`) as HTMLButtonElement
    trustCard.append(trustButton)
    const paintTrusted = async () => {
      try {
        const trusted = await withRelays(t => w.heartwoodTrusted(t))
        trustedList.innerHTML = ''
        if (!trusted.length) trustedList.append(el('<p class="fineline">No trusted senders: every note needs a hold.</p>'))
        for (const pk of trusted) {
          const row = el(`<div class="kv"><span>trusted</span><b>${esc(shortNpub(pk))}</b></div>`)
          const drop = el(`<button class="btn btn-ghost">${icons.x}<span>Untrust</span></button>`) as HTMLButtonElement
          drop.addEventListener('click', () =>
            busy(drop, async () => {
              await withRelays(t => w.heartwoodTrust(t, pk, true))
              await paintTrusted()
            })
          )
          row.append(drop)
          trustedList.append(row)
        }
      } catch (err) {
        trustedList.innerHTML = ''
        trustedList.append(el(`<p class="warn">${esc((err as Error).message)}</p>`))
      }
    }
    trustButton.addEventListener('click', () =>
      busy(trustButton, async () => {
        const sender = senderInput.value.trim()
        if (!sender) throw new WalletUsageError('Name the sender first.')
        toast('Hold the device button to trust this sender.')
        const result = await withRelays(t => w.heartwoodTrust(t, sender))
        toast(result.changed ? `${shortNpub(result.pubkeyHex)} is now trusted.` : 'Already trusted.', 'ok')
        senderInput.value = ''
        await paintTrusted()
      })
    )
    void paintTrusted()

    // ---- pair another device ----
    const pairCard = el(`<div class="card"><h3>Pair another device</h3>
      <p class="warn" style="text-align:left;padding-top:12px">This wallet is bound to the signer, so it can ask for a slot for another one: your phone, say. One hold on the device; the code is shown once and is one-time.</p>
      <div class="field"><label>Name it</label><input data-label type="text" placeholder="phone" autocomplete="off" spellcheck="false" /></div>
      <div data-pair-out></div></div>`)
    body.append(pairCard)
    const pairLabel = pairCard.querySelector('[data-label]') as HTMLInputElement
    const pairOut = pairCard.querySelector('[data-pair-out]') as HTMLElement
    const mint = el(`<button class="btn">${icons.qr}<span>Mint a pairing code (one hold)</span></button>`) as HTMLButtonElement
    pairCard.append(mint)
    mint.addEventListener('click', () =>
      busy(mint, async () => {
        toast('Hold the device button to mint the slot.')
        const minted = await withRelays(t => w.heartwoodPairWallet(t, pairLabel.value.trim() || 'another wallet'))
        pairOut.innerHTML = ''
        pairOut.append(qrCard(minted.uri))
        const copy = el(`<button class="btn btn-ghost">${icons.copy}<span>Copy bunker URI</span></button>`)
        copy.addEventListener('click', () => void copyText(minted.uri, 'Bunker URI', true))
        pairOut.append(
          copy,
          el(`<p class="warn">Scan or paste into the other wallet's <b>Pair a signer</b> now. It works once; if it is lost, mint another and this slot stays empty.</p>`)
        )
      })
    )

    // ---- inbox and unlink ----
    const more = el(`<div class="card"><h3>Where senders find it</h3>
      <p class="warn" style="text-align:left;padding-top:12px">The device's inbox list (kind 10050) names the relays above, signed by the device. Without it nobody who resolves its npub knows where to leave a note.</p></div>`)
    const publish = el(`<button class="btn">${icons.upload}<span>Publish inbox (one hold)</span></button>`) as HTMLButtonElement
    publish.addEventListener('click', () =>
      busy(publish, async () => {
        toast('Hold the device button to sign its inbox list.')
        const result = await withRelays(t => w.publishHeartwoodInbox(t))
        toast(result.ok.length ? `Inbox list on ${result.ok.length} relay(s)` : 'No relay took the inbox list', result.ok.length ? 'ok' : 'err')
      })
    )
    const unlink = el(`<button class="btn btn-ghost">${icons.x}<span>Unpair</span></button>`) as HTMLButtonElement
    unlink.addEventListener('click', () =>
      busy(unlink, async () => {
        await w.unlinkHeartwood()
        toast('Unpaired. Notes on the device stay on the device.')
        viewSigner()
      })
    )
    more.append(publish, unlink)
    body.append(more)
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
    // A move is a melt at one mint paying a mint invoice at another, so it
    // needs two mints on the list and something at one of them to melt.
    const balances = w.balanceByMint()
    const canMove = w.data.mints.length >= 2 && [...balances.values()].some(msat => msat > 0)
    const body = el(`<div class="stack">
      <div class="hint">${icons.info}<span><b>Turning a note back into Lightning?</b> Paste an invoice to pay, send to a Lightning Address${hasNwc ? ', or cash straight into your connected wallet' : ''}${canMove ? ', or move sats to another of your mints' : ''} - the mint burns the note and pays it out.</span></div>
      <div class="seg" role="tablist">
        <button class="on" data-tab="invoice">Invoice</button>
        <button data-tab="address">Address</button>
        ${hasNwc ? '<button data-tab="nwc">My wallet</button>' : ''}
        ${canMove ? '<button data-tab="move">Move</button>' : ''}
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
      } else if (tab === 'move') {
        const stack = el(`<div class="stack">
          <p class="warn">Move sats from one of your mints to another. The source mint burns a note to pay the destination's invoice, and the new note lands here once it settles. Both mints take their usual fee.</p>
          <div class="field"><label>From</label><select data-from></select></div>
          <div class="field"><label>To</label><select data-to></select></div>
          <div class="amount-input"><input data-amount inputmode="numeric" placeholder="0" /><span class="unit">sat</span></div>
          <p class="warn" data-movenote>&nbsp;</p>
        </div>`)
        const from = stack.querySelector('[data-from]') as HTMLSelectElement
        const to = stack.querySelector('[data-to]') as HTMLSelectElement
        // mint hosts are persisted strings: build options, never interpolate
        for (const mint of w.data.mints) {
          const held = balances.get(mint.host) ?? 0
          const source = document.createElement('option')
          source.value = mint.host
          source.textContent = `${mint.host} (${sats(held)} sat)`
          source.disabled = held <= 0
          from.append(source)
          const dest = document.createElement('option')
          dest.value = mint.host
          dest.textContent = mint.host
          to.append(dest)
        }
        const richest = [...balances.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
        if (richest) from.value = richest
        const other = w.data.mints.find(mint => mint.host !== from.value)
        if (other) to.value = other.host
        const note = stack.querySelector('[data-movenote]') as HTMLElement
        const paintMove = () => {
          const entry = w.data.mints.find(mint => mint.host === to.value)
          const amount = Number((stack.querySelector('[data-amount]') as HTMLInputElement).value)
          if (from.value === to.value) {
            note.textContent = 'Pick two different mints.'
            return
          }
          if (!entry?.mintFee || !Number.isSafeInteger(amount) || amount <= 0) {
            note.textContent = entry?.mintFee ? '\u00a0' : `No known mint fee at ${to.value}.`
            return
          }
          const net = amount * 1000 - entry.mintFee.baseFeeMsat - Math.ceil((amount * 1000 * entry.mintFee.feePpm) / 1_000_000)
          note.textContent = `${to.value} withholds its fee: about ${sats(Math.max(net, 0))} sat lands for ${amount} sat sent, plus ${from.value}'s melt fee.`
        }
        from.addEventListener('change', paintMove)
        to.addEventListener('change', paintMove)
        stack.querySelector('[data-amount]')!.addEventListener('input', paintMove)
        paintMove()
        pane.replaceChildren(stack)
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
        if (tab === 'move') {
          const amount = Number((pane.querySelector('[data-amount]') as HTMLInputElement).value)
          if (!Number.isSafeInteger(amount) || amount <= 0) throw new WalletUsageError('Give an amount in whole sats.')
          const from = (pane.querySelector('[data-from]') as HTMLSelectElement).value
          const to = (pane.querySelector('[data-to]') as HTMLSelectElement).value
          toast(`Moving ${amount} sat from ${from} to ${to}…`)
          const moved = await w.transfer(amount * 1000, from, to, {timeoutMs: 120_000, intervalMs: 1_800})
          if (moved.ambiguous) {
            toast('The melt may be in flight - the home screen settles what happened at both ends.', 'ok')
          } else if (!moved.result) {
            toast(`Melted at ${from}, but ${to} has not settled yet - the home screen claims it once it does.`, 'ok')
          } else {
            moved.result.warnings.forEach(warning => toast(warning, 'err'))
            toast(`Moved ${sats(moved.melt.amountMsat)} sat from ${from} to ${to} - ${sats(moved.result.note.amountMsat)} sat landed.`, 'ok')
          }
          viewHome()
          return
        }
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

// ---------- the cash drawer ----------
// A wallet holding one large note cannot pay a small amount with no
// connection: cutting a note needs the mint. So the drawer keeps small
// notes on purpose, the way a till keeps change. Every cut costs the
// mint's flat fee, so the cost is always shown before anything is cut.

const cashDrawer = (w: Wallet, host: string): HTMLElement => {
  const {ladder, copies} = w.ladderFor(host)
  const card = el(`<div class="card">
    <h3>Cash drawer</h3>
    <p class="warn" style="text-align:left;padding-top:12px">Notes you keep small on purpose, so you can pay without a connection. Nothing can be cut to size offline, so what is in here is what you can spend.</p>
    <div class="field" style="padding-top:14px">
      <label>Denominations in sats <span class="fineline">separated by commas</span></label>
      <input data-ladder type="text" inputmode="numeric" autocomplete="off" spellcheck="false" />
    </div>
    <div class="field">
      <label>How many of each</label>
      <input data-copies type="text" inputmode="numeric" autocomplete="off" spellcheck="false" />
    </div>
    <div data-plan class="stack" style="gap:12px;padding-top:14px"></div>
  </div>`)
  const ladderInput = card.querySelector('[data-ladder]') as HTMLInputElement
  const copiesInput = card.querySelector('[data-copies]') as HTMLInputElement
  ladderInput.value = ladder.join(', ')
  copiesInput.value = String(copies)
  const planArea = card.querySelector('[data-plan]') as HTMLElement

  const paintPlan = (): void => {
    planArea.replaceChildren()
    const plan = w.ladderPlan(host)
    const held = w.liveNotes().filter(note => note.mintHost === host).length
    const line = el('<div class="kv"><span>notes held here</span><b></b></div>')
    line.querySelector('b')!.textContent = String(held)
    planArea.append(line)
    if (!plan.cut.length) {
      planArea.append(
        el(
          `<p class="warn" style="text-align:left">${
            plan.short.length
              ? 'Nothing here is big enough to cut the rest of the drawer. Mint or receive a larger note first.'
              : 'The drawer is full.'
          }</p>`
        )
      )
      return
    }
    const cost = el('<p class="warn" style="text-align:left"></p>')
    cost.textContent = `Cutting ${plan.cut.length} note${plan.cut.length === 1 ? '' : 's'} costs ${sats(plan.feeMsat)} sat in split fees${plan.short.length ? `, and ${plan.short.length} more cannot be cut from what is here` : ''}.`
    planArea.append(cost)
    const prepare = el(`<button class="btn">${icons.drawer}<span>Cut them for ${sats(plan.feeMsat)} sat</span></button>`)
    prepare.addEventListener('click', () =>
      busy(prepare as HTMLButtonElement, async () => {
        const done = await w.prepareOffline(host)
        toast(
          done.made.length
            ? `Cut ${done.made.length} note${done.made.length === 1 ? '' : 's'} for ${sats(done.feeMsat)} sat`
            : 'Nothing needed cutting',
          'ok'
        )
        viewMints()
      })
    )
    planArea.append(prepare)
  }

  const save = el(`<button class="btn btn-ghost">${icons.check}<span>Save the drawer</span></button>`)
  save.addEventListener('click', () =>
    busy(save as HTMLButtonElement, async () => {
      const denominations = ladderInput.value
        .split(/[\s,]+/)
        .filter(Boolean)
        .map(Number)
      if (denominations.some(value => !Number.isSafeInteger(value) || value <= 0)) {
        throw new WalletUsageError('Give the denominations in whole sats, like 100, 500, 1000.')
      }
      const wanted = Number(copiesInput.value)
      await w.setLadder(host, denominations, wanted)
      toast('Cash drawer saved', 'ok')
      paintPlan()
    })
  )
  card.append(save)
  paintPlan()
  return card
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
        ${
          entry.keyRotatedAt
            ? `<div class="kv"><span>signing key</span><b>rotated on ${when(entry.keyRotatedAt)} · ${w.pubkeyHistoryFor(entry.host).length} old key(s) kept so older notes still verify</b></div>`
            : ''
        }
        ${isDefault ? `<div class="kv"><span>default</span><b>new mints and sends start here</b></div>` : ''}
      </div>`)
      // host and pin are persisted strings: text, never markup
      card.querySelector('.kv b')!.textContent = entry.info?.name
        ? `${entry.info.name}`
        : entry.host

      // Everything the mint says about itself. All of it is the operator's
      // own words arriving over the wire, so every one of these is set as
      // TEXT and never as markup, and the block says whose claim it is.
      const info = entry.info
      if (info && Object.keys(info).length > 0) {
        const about = el('<div class="stack" style="gap:8px;margin-top:10px"></div>')
        if (info.name) {
          const row = el('<div class="kv"><span>host</span><b></b></div>')
          row.querySelector('b')!.textContent = entry.host
          about.append(row)
        }
        if (info.description) {
          const row = el('<p class="fineline" style="margin:0"></p>')
          row.textContent = info.description
          about.append(row)
        }
        for (const [label, value] of [
          ['nostr', info.contact?.nostr],
          ['email', info.contact?.email],
          ['contact', info.contact?.url]
        ] as const) {
          if (!value) continue
          const chip = el(`<button class="chip"><span></span><b>copy</b></button>`)
          chip.querySelector('span')!.textContent = `${label}: ${value}`
          chip.addEventListener('click', () => void copyText(value, label))
          about.append(chip)
        }
        if (info.tosUrl) {
          // Rendered as text and opened deliberately, never as an <a href>
          // built from a string the mint chose.
          const chip = el(`<button class="chip"><span></span><b>open</b></button>`)
          chip.querySelector('span')!.textContent = 'terms'
          chip.addEventListener('click', () => {
            if (/^https:\/\//i.test(info.tosUrl!)) window.open(info.tosUrl!, '_blank', 'noopener,noreferrer')
            else toast('That terms link is not https - not opening it.', 'err')
          })
          about.append(chip)
        }
        if (info.version) {
          const row = el('<div class="kv"><span>version</span><b></b></div>')
          row.querySelector('b')!.textContent = info.version
          about.append(row)
        }
        about.append(
          el('<span class="fineline">what this mint says about itself, not something notecase has checked</span>')
        )
        card.append(about)
      }
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
      body.append(cashDrawer(w, entry.host))
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

// ---------- checking notes against their mints ----------

// A note can go quiet without the wallet hearing: the other copy of a
// bearer note spent first, a melt whose answer never arrived. This asks
// every mint about every note it issued here, shows what it found, and
// writes nothing down until asked twice.

const viewCheck = (): void => {
  const w = wallet!
  show(() => {
    const view = el('<div class="view"></div>')
    view.append(topBar('Check your notes', viewSettings))
    const body = el(`<div class="stack">
      <div class="hint">${icons.info}<span><b>Is every note still money?</b> This asks each mint whether the notes you hold from it are still good, and tells you what it found. Nothing changes until you say so.</span></div>
      <div class="hint">${icons.shield}<span><b>It costs you no privacy.</b> The mint made these notes for this wallet and sees each one the moment it is spent. Asking after them tells it nothing it does not already know.</span></div>
      <button class="btn btn-silver" data-run>${icons.check}<span>Check now</span></button>
      <div data-report class="stack"></div>
    </div>`)
    view.append(body)
    const report = body.querySelector('[data-report]') as HTMLElement

    const noteLine = (note: NoteRecord): HTMLElement => {
      const row = el('<div class="kv"><span></span><b></b></div>')
      row.querySelector('span')!.textContent = `${note.id.slice(0, 8)} at ${note.mintHost}`
      row.querySelector('b')!.textContent = `${sats(note.amountMsat)} sat`
      return row
    }

    const paint = (found: CheckReport, applied: boolean): void => {
      report.replaceChildren()
      const changes =
        found.spent.length +
        found.unknown.length +
        found.pending.length +
        found.valueChanged.length +
        found.staleSignature.length

      const summary = el(`<div class="card">
        <h3>${applied ? 'Written down' : 'What the mints said'}</h3>
        <div class="kv"><span>notes asked about</span><b></b></div>
      </div>`)
      summary.querySelector('.kv b')!.textContent = String(found.checked)
      report.append(summary)

      if (found.spent.length) {
        const card = el(`<div class="card"><h3>Already spent</h3>
          <p class="warn" style="text-align:left;padding-top:12px">Someone redeemed these at the mint. ${applied ? 'They are now in your history.' : 'Applying moves them to your history.'}</p></div>`)
        found.spent.forEach(note => card.append(noteLine(note)))
        report.append(card)
      }
      if (found.unknown.length) {
        const card = el(`<div class="card"><h3>The mint has never heard of these</h3>
          <p class="warn" style="text-align:left;padding-top:12px">Not spent, not known. ${applied ? 'Filed as spent, with the reason kept.' : 'Applying files them as spent and keeps the reason.'}</p></div>`)
        found.unknown.forEach(note => card.append(noteLine(note)))
        report.append(card)
      }
      if (found.pending.length) {
        const card = el(`<div class="card"><h3>Locked by something in flight</h3>
          <p class="warn" style="text-align:left;padding-top:12px">The mint is still holding these for an operation that has not finished. ${applied ? 'Parked for the next reconcile.' : 'Applying parks them for the next reconcile.'}</p></div>`)
        found.pending.forEach(note => card.append(noteLine(note)))
        report.append(card)
      }
      if (found.valueChanged.length) {
        const card = el(`<div class="card"><h3>Worth a different amount</h3>
          <p class="warn" style="text-align:left;padding-top:12px">The mint is the authority on what a note holds. ${applied ? 'The wallet now agrees with it.' : 'Applying makes the wallet agree with it.'}</p></div>`)
        for (const changed of found.valueChanged) {
          const row = el('<div class="kv"><span></span><b></b></div>')
          row.querySelector('span')!.textContent = `${changed.note.id.slice(0, 8)} at ${changed.note.mintHost}`
          row.querySelector('b')!.textContent = `${sats(changed.note.amountMsat)} -> ${sats(changed.amountMsat)} sat`
          card.append(row)
        }
        report.append(card)
      }
      if (found.staleSignature.length) {
        const card = el(`<div class="card"><h3>Signed with an old key</h3>
          <p class="warn" style="text-align:left;padding-top:12px">This mint has rotated its signing key since these were made. They are still good, and re-signing them under the current key costs nothing.</p></div>`)
        found.staleSignature.forEach(note => card.append(noteLine(note)))
        const resign = el(`<button class="btn btn-ghost">${icons.shield}<span>Re-sign them</span></button>`)
        resign.addEventListener('click', () =>
          busy(resign as HTMLButtonElement, async () => {
            let done = 0
            for (const note of found.staleSignature) {
              await w.rotateLive(note)
              done += 1
            }
            toast(`Re-signed ${done} note${done === 1 ? '' : 's'} under the current key.`, 'ok')
            paint(await w.checkNotes(), applied)
          })
        )
        card.append(resign)
        report.append(card)
      }
      if (found.unreachable.length) {
        const card = el(`<div class="card"><h3>Did not answer</h3>
          <p class="warn" style="text-align:left;padding-top:12px">These mints were not reachable, so their notes were left exactly as they are. Try again later.</p></div>`)
        found.unreachable.forEach(host => {
          const row = el('<div class="kv"><span>mint</span><b></b></div>')
          row.querySelector('b')!.textContent = host
          card.append(row)
        })
        report.append(card)
      }
      if (changes === 0) {
        report.append(
          el(`<p class="warn">${found.unreachable.length ? 'Nothing to report from the mints that answered.' : 'Every note is where you left it.'}</p>`)
        )
        return
      }
      if (applied) return
      // A stale signature is not something Apply writes down: it has its
      // own button, on its own card.
      const applyable =
        found.spent.length + found.unknown.length + found.pending.length + found.valueChanged.length
      if (applyable === 0) return

      const apply = el(`<button class="btn btn-silver">${icons.check}<span>Apply what the mints said</span></button>`)
      apply.addEventListener('click', () =>
        busy(apply as HTMLButtonElement, async () => {
          // Asked again rather than replayed: the answer that gets written
          // down should be the one the mint gave a moment ago, not one
          // from before you read the screen.
          const applied = await w.checkNotes({apply: true})
          paint(applied, true)
          toast('Your wallet now agrees with the mints.', 'ok')
        })
      )
      report.append(apply)
    }

    const run = body.querySelector('[data-run]') as HTMLButtonElement
    run.addEventListener('click', () =>
      busy(run, async () => {
        if (!w.liveNotes().length) {
          toast('There are no notes to check yet.', '')
          return
        }
        paint(await w.checkNotes(), false)
      })
    )
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

    // check every note against its mint
    const check = el(`<button class="btn">${icons.check}<span>Check your notes</span></button>`)
    check.addEventListener('click', () => viewCheck())
    body.append(check)

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

    // hardware signer
    const signer = el(`<div class="card"><h3>Hardware signer</h3>
      <p class="warn" style="text-align:left;padding-top:12px">${w.heartwoodLink() ? `Paired with ${esc(shortNpub(w.heartwoodLink()!.devicePubkey))}. Notes zapped or sent to it come off here.` : 'Pair a heartwood signer to collect the notes it holds, trust a mint for hands-free zaps, and publish its inbox.'}</p></div>`)
    const openSigner = el(`<button class="btn">${icons.shield}<span>${w.heartwoodLink() ? 'Open signer' : 'Pair a signer'}</span></button>`)
    openSigner.addEventListener('click', viewSigner)
    signer.append(openSigner)
    body.append(signer)

    // nostr
    const nostr = el(`<div class="card"><h3>Nostr</h3>
      <p class="warn" style="text-align:left;padding-top:12px">Notes can be sent to an npub and arrive sealed to this wallet's own key. Publish your inbox relays so senders know where to leave them.</p>
    </div>`)
    const identity = w.nostrIdentity()
    if (identity) {
      const row = el(`<div class="kv"><span>npub</span><b style="font-family:var(--mono);font-size:.85rem">${esc(shortNpub(identity.pubkey))}</b></div>`)
      nostr.append(row)
      const copyNpub = el(`<button class="btn btn-ghost">${icons.copy}<span>Copy npub</span></button>`)
      copyNpub.addEventListener('click', () => void copyText(identity.npub, 'npub'))
      nostr.append(copyNpub)
    }
    const relayField = el(`<div class="field" style="padding-top:12px">
      <label>Inbox relays <span class="fineline">one per line</span></label>
      <textarea data-relays spellcheck="false" rows="3">${esc(w.nostrRelays().join('\n'))}</textarea>
    </div>`)
    nostr.append(relayField)
    const publish = el(`<button class="btn">${icons.upload}<span>${identity ? 'Save and publish inbox' : 'Create identity and publish inbox'}</span></button>`)
    publish.addEventListener('click', () =>
      busy(publish as HTMLButtonElement, async () => {
        const relays = (relayField.querySelector('textarea') as HTMLTextAreaElement).value
          .split(/\s+/)
          .filter(r => /^wss?:\/\//.test(r))
        if (!relays.length) throw new WalletUsageError('Give at least one wss:// relay.')
        await w.setNostrRelays(relays)
        const published = await withRelays(t => w.publishInbox(t))
        toast(published.ok.length ? `Inbox list on ${published.ok.length} relay(s)` : 'No relay took the inbox list', published.ok.length ? 'ok' : 'err')
        viewSettings()
      })
    )
    nostr.append(publish)
    body.append(nostr)

    // lightning address
    const address = el(`<div class="card"><h3>Lightning address</h3>
      <p class="warn" style="text-align:left;padding-top:12px">An address anyone can pay from any Lightning wallet. What arrives is a note sealed to this wallet's Nostr key, so it is yours seconds after it is paid, and the mint holds it for no longer than that.</p>
    </div>`)
    const claimed = w.lightningAddress()
    if (claimed) {
      const row = el(`<div class="kv"><span>yours</span><b></b></div>`)
      row.querySelector('b')!.textContent = claimed
      address.append(row)
      const copyAddress = el(`<button class="btn btn-ghost">${icons.copy}<span>Copy address</span></button>`)
      copyAddress.addEventListener('click', () => void copyText(claimed, 'Your lightning address'))
      address.append(copyAddress)
    } else {
      const form = el(`<div class="stack" style="padding-top:14px">
        <div class="field">
          <label>The name you want <span class="fineline">letters, numbers, dot, dash or underscore</span></label>
          <input data-name type="text" placeholder="yourname" autocomplete="off" spellcheck="false" />
        </div>
        <div class="field" data-mintfield>
          <label>At which mint</label>
          <select data-mintpick></select>
        </div>
        <div data-price class="stack" style="gap:12px"></div>
        <button class="btn" data-price-check>${icons.bolt}<span>What does it cost?</span></button>
      </div>`)
      const picker = form.querySelector('[data-mintpick]') as HTMLSelectElement
      for (const mint of w.data.mints) {
        const option = document.createElement('option')
        option.value = mint.host
        option.textContent = mint.host
        if (mint.host === w.data.settings.defaultMintHost) option.selected = true
        picker.append(option)
      }
      if (!w.data.mints.length) {
        form.querySelector('[data-mintfield]')!.remove()
        form.querySelector('[data-price-check]')!.replaceWith(
          el('<p class="warn" style="text-align:left">Add a mint first, then come back.</p>')
        )
      }
      const priceArea = form.querySelector('[data-price]') as HTMLElement
      const ask = form.querySelector('[data-price-check]') as HTMLButtonElement | null
      ask?.addEventListener('click', () =>
        busy(ask, async () => {
          priceArea.replaceChildren()
          const wanted = (form.querySelector('[data-name]') as HTMLInputElement).value.trim()
          if (!wanted) throw new WalletUsageError('Pick a name first.')
          const host = picker.value
          const price = await w.namePriceMsat(host)
          if (price === null) {
            priceArea.append(el(`<p class="warn" style="text-align:left">That mint is not handing out addresses.</p>`))
            return
          }
          const cost = el('<p class="warn" style="text-align:left"></p>')
          cost.textContent =
            price > 0
              ? `${wanted}@${host} costs ${sats(price)} sat, paid with one of that mint's own notes out of your balance.`
              : `${wanted}@${host} is free at that mint.`
          const confirm = el(`<button class="btn btn-silver">${icons.check}<span>${price > 0 ? `Claim it for ${sats(price)} sat` : 'Claim it'}</span></button>`)
          confirm.addEventListener('click', () =>
            busy(confirm as HTMLButtonElement, async () => {
              const got = await w.registerName({name: wanted, mintHost: host})
              toast(`${got.address} is yours. Anyone can pay you at it now.`, 'ok')
              viewSettings()
            })
          )
          priceArea.append(cost, confirm)
        })
      )
      address.append(form)
    }
    body.append(address)

    // recovery words
    const seed = el(`<div class="card"><h3>Recovery words</h3>
      <p class="warn" style="text-align:left;padding-top:12px">Twelve words that rebuild every secret this wallet makes. With them and the names of your mints, the notes come back on any device - even one that has never seen this wallet.</p>
    </div>`)
    if (w.hasSeed() && w.data.mnemonic) {
      const showWords = el(`<button class="btn btn-ghost">${icons.eye}<span>Show my words</span></button>`)
      showWords.addEventListener('click', () =>
        show(() =>
          pinPad({
            title: 'Your PIN, again',
            subtitle: 'The words are the whole wallet, so they are worth asking twice for.',
            onComplete: async pin => {
              const opened = await unlockWithPin(pin).catch(() => null)
              if (!opened) return 'retry'
              viewWords(opened.data.mnemonic ?? '', viewSettings)
              return 'ok'
            }
          })
        )
      )
      seed.append(showWords)
      const restore = el(`<button class="btn btn-ghost">${icons.refresh}<span>Ask my mints what is still mine</span></button>`)
      restore.addEventListener('click', () =>
        busy(restore as HTMLButtonElement, async () => {
          if (!w.data.mints.length) throw new WalletUsageError('Add a mint first, then ask it.')
          const results = await w.restoreAll()
          const found = results.reduce((sum, result) => sum + result.found.length, 0)
          for (const result of results) if (result.error) toast(`${result.host}: ${result.error}`, 'err')
          toast(
            found
              ? `Found ${found} note${found === 1 ? '' : 's'} - balance is now ${sats(w.balanceMsat())} sat.`
              : 'Your mints hold nothing else of yours.',
            found ? 'ok' : ''
          )
          viewSettings()
        })
      )
      seed.append(restore)
    } else {
      seed.append(
        el(`<p class="warn" style="text-align:left">This wallet was made before recovery words existed, so its notes live only on this device. Download a backup and keep it somewhere safe.</p>`)
      )
    }
    const legacy = w.legacyNotes()
    if (legacy.length && w.hasSeed()) {
      const uncovered = el('<p class="warn" style="text-align:left"></p>')
      uncovered.textContent = `${legacy.length} note${legacy.length === 1 ? '' : 's'} here came from somewhere else and your words cannot find ${legacy.length === 1 ? 'it' : 'them'} again. Moving ${legacy.length === 1 ? 'it' : 'them'} onto your words costs nothing.`
      const adopt = el(`<button class="btn">${icons.check}<span>Move them onto my words</span></button>`)
      adopt.addEventListener('click', () =>
        busy(adopt as HTMLButtonElement, async () => {
          const result = await w.adoptLegacyNotes()
          for (const failure of result.failed) toast(`One could not be moved: ${failure.reason}`, 'err')
          toast(`${result.adopted.length} note(s) are on your words now.`, 'ok')
          viewSettings()
        })
      )
      seed.append(uncovered, adopt)
    }
    body.append(seed)

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
    // Never interrupt a hand-off. An unreceived claim is a live secret that
    // only this tab holds; a reload offered mid-claim is how a note gets
    // lost, so the update waits until there is nothing in flight.
    if (takeClaim()) return
    const node = el(
      `<div class="toast ok" style="pointer-events:auto;display:flex;gap:12px;align-items:center">A new version is ready<button class="btn" style="min-height:40px;width:auto;padding:0 14px">Reload</button></div>`
    )
    node.querySelector('button')!.addEventListener('click', () => void update(true))
    document.getElementById('toasts')!.append(node)
  }
})

// ---------- boot ----------

readClaimHash()
readShareTarget()

// Collecting a POSTed share is a cache read, so it is awaited before any
// screen is chosen rather than landing behind one. That makes the two share
// paths indistinguishable from here on: by the time anything renders, the
// payload is in memory exactly as a GET share would have been, and it still
// waits behind the PIN like everything else.
void (async () => {
  const posted = await collectPostedShare()
  if (posted) rememberShare(posted)

  if (location.hash === '#/proof') {
    viewProof()
  } else if (walletExists()) {
    void viewLocked()
  } else if (takeClaim()) {
    // A claim link on a fresh device: set up first, the note is kept for
    // after - and now survives the reloads that setup tends to involve.
    viewWelcome()
    toast('A note is waiting - set up the wallet to receive it.', 'ok')
  } else {
    viewWelcome()
  }
})()
