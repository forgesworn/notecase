// Saying "hold the button" once is not enough.
//
// A card on the device is a physical thing, often in another room, and its
// window closes on its own after about half a minute. Printed once, into a
// terminal nobody is looking at, it is missed, and the command reports a
// timeout that reads like a fault (heartwood-esp32#81). The bench scripts
// have always chimed until the card was answered; this is the same for the
// wallet.
//
// It says the ask again every few seconds, with the terminal bell, and stops
// the moment the step changes or the call returns. The bell only rings on a
// terminal: piped output stays clean.

export type HoldNagger = {
  // Show a progress step. One that asks for a hold starts the reminder; any
  // other step, and `stop`, ends it.
  step(text: string): void
  stop(): void
}

export type HoldNaggerOptions = {
  log?: (line: string) => void
  bell?: () => void
  everyMs?: number
  now?: () => number
}

const asksForAHold = (text: string): boolean => /\bhold\b/i.test(text)

const BELL = ''

export const holdNagger = (options: HoldNaggerOptions = {}): HoldNagger => {
  const log = options.log ?? ((line: string) => console.log(line))
  const bell =
    options.bell ??
    (() => {
      if (process.stdout.isTTY) process.stdout.write(BELL)
    })
  const everyMs = options.everyMs ?? 8_000
  const now = options.now ?? (() => Date.now())

  let timer: ReturnType<typeof setInterval> | null = null

  const stop = (): void => {
    if (timer) clearInterval(timer)
    timer = null
  }

  return {
    step(text: string): void {
      stop()
      log(`  ${text}`)
      if (!asksForAHold(text)) return
      bell()
      const started = now()
      timer = setInterval(() => {
        const seconds = Math.round((now() - started) / 1000)
        log(`  still waiting (${seconds}s): ${text}`)
        bell()
      }, everyMs)
      // Never hold the process open on its own account.
      timer.unref?.()
    },
    stop
  }
}
