import jsQR from 'jsqr'

// Camera QR scanning: native BarcodeDetector where the platform has one,
// jsQR on a canvas everywhere else (Firefox, older Safari). The camera is
// only requested when the scanner is deliberately opened, and every track
// is stopped the moment it closes - a wallet holds secrets, not a webcam.

type Detector = {detect(source: CanvasImageSource): Promise<Array<{rawValue: string}>>}

declare global {
  // Present on Chromium and recent Safari; feature-detected below.
  var BarcodeDetector:
    | {
        new (options?: {formats: string[]}): Detector
        getSupportedFormats(): Promise<string[]>
      }
    | undefined
}

export const scanAvailable = (): boolean =>
  typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia)

const nativeDetector = async (): Promise<Detector | null> => {
  try {
    if (!globalThis.BarcodeDetector) return null
    const formats = await globalThis.BarcodeDetector.getSupportedFormats()
    if (!formats.includes('qr_code')) return null
    return new globalThis.BarcodeDetector({formats: ['qr_code']})
  } catch {
    return null
  }
}

// Opens a full-screen scanner; resolves with the decoded text, or null if
// the user closes it. The overlay owns its own DOM and cleanup.
export const scanQr = (): Promise<string | null> =>
  new Promise(resolve => {
    const overlay = document.createElement('div')
    overlay.className = 'scanner'
    overlay.innerHTML = `
      <video playsinline muted autoplay></video>
      <div class="scanner-frame" aria-hidden="true"></div>
      <p>Point at a note, an invoice or a Lightning address</p>
      <button class="btn scanner-close">Cancel</button>`
    document.body.append(overlay)

    const video = overlay.querySelector('video')!
    let stream: MediaStream | null = null
    let stopped = false

    const finish = (value: string | null): void => {
      if (stopped) return
      stopped = true
      stream?.getTracks().forEach(track => track.stop())
      overlay.remove()
      resolve(value)
    }
    overlay.querySelector('.scanner-close')!.addEventListener('click', () => finish(null))

    void (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: {facingMode: 'environment'},
          audio: false
        })
      } catch {
        overlay.querySelector('p')!.textContent = 'The camera was refused - paste instead.'
        setTimeout(() => finish(null), 1600)
        return
      }
      video.srcObject = stream
      await video.play().catch(() => {})

      const detector = await nativeDetector()
      const canvas = document.createElement('canvas')
      const ctx = canvas.getContext('2d', {willReadFrequently: true})

      const tick = async (): Promise<void> => {
        if (stopped) return
        if (video.readyState >= 2 && video.videoWidth > 0) {
          try {
            if (detector) {
              const codes = await detector.detect(video)
              const value = codes[0]?.rawValue?.trim()
              if (value) return finish(value)
            } else if (ctx) {
              canvas.width = video.videoWidth
              canvas.height = video.videoHeight
              ctx.drawImage(video, 0, 0)
              const image = ctx.getImageData(0, 0, canvas.width, canvas.height)
              const code = jsQR(image.data, image.width, image.height)
              if (code?.data.trim()) return finish(code.data.trim())
            }
          } catch {
            // a bad frame is just skipped
          }
        }
        setTimeout(() => void tick(), 180)
      }
      void tick()
    })()
  })

// ---------- NFC ----------
// A note URL in an NDEF URI record is a physical coin: tap it and the sats
// are in your hand. The convention is deliberately the plainest one there
// is, a single URI record holding the note URL with its signature, so any
// other wallet can read a tag this one writes and the other way round.
//
// Web NFC is Chrome on Android and nowhere else, so every entry point is
// feature-detected and simply does not appear elsewhere.

type NdefRecord = {recordType: string; mediaType?: string; encoding?: string; data?: DataView}
type NdefMessage = {records: NdefRecord[]}
type NdefWriteRecord = {recordType: string; data: string}

declare global {
  var NDEFReader:
    | {
        new (): {
          scan(options?: {signal?: AbortSignal}): Promise<void>
          write(message: {records: NdefWriteRecord[]}, options?: {signal?: AbortSignal}): Promise<void>
          onreading: ((event: {message: NdefMessage}) => void) | null
          onreadingerror: (() => void) | null
        }
      }
    | undefined
}

export const nfcAvailable = (): boolean => typeof globalThis.NDEFReader !== 'undefined'

// The first URL or text record of a tag, as plain text.
const firstPayload = (message: NdefMessage): string | null => {
  for (const record of message.records) {
    if (record.recordType !== 'url' && record.recordType !== 'text') continue
    if (!record.data) continue
    const value = new TextDecoder(record.encoding ?? 'utf-8').decode(record.data).trim()
    if (value) return value
  }
  return null
}

// A full-screen prompt while the phone waits for a tag. Resolves with what
// was read, or null if it was cancelled or the tag held nothing useful.
const tagPrompt = (
  message: string,
  work: (signal: AbortSignal, done: (value: string | null) => void) => Promise<void>
): Promise<string | null> =>
  new Promise(resolve => {
    const overlay = document.createElement('div')
    overlay.className = 'scanner'
    overlay.innerHTML = `
      <div class="scanner-frame" aria-hidden="true"></div>
      <p></p>
      <button class="btn scanner-close">Cancel</button>`
    overlay.querySelector('p')!.textContent = message
    document.body.append(overlay)
    const controller = new AbortController()
    let settled = false
    const finish = (value: string | null): void => {
      if (settled) return
      settled = true
      controller.abort()
      overlay.remove()
      resolve(value)
    }
    overlay.querySelector('.scanner-close')!.addEventListener('click', () => finish(null))
    void work(controller.signal, finish).catch(() => {
      overlay.querySelector('p')!.textContent = 'This phone would not start NFC - use the QR instead.'
      setTimeout(() => finish(null), 1600)
    })
  })

// Reads a tag. Same callback shape as the camera scanner, so both feed the
// one classifier.
export const scanNfc = (): Promise<string | null> =>
  tagPrompt('Hold the tag against the back of your phone', async (signal, done) => {
    const reader = new globalThis.NDEFReader!()
    reader.onreadingerror = () => done(null)
    reader.onreading = event => done(firstPayload(event.message))
    await reader.scan({signal})
  })

// Writes one URI record. Resolves true once a tag took it.
export const writeNfc = (url: string): Promise<boolean> =>
  tagPrompt('Hold a blank tag against the back of your phone', async (signal, done) => {
    const writer = new globalThis.NDEFReader!()
    await writer.write({records: [{recordType: 'url', data: url}]}, {signal})
    done('written')
  }).then(result => result === 'written')
