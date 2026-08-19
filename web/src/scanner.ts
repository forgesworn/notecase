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
