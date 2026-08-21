// @vitest-environment happy-dom
import {beforeAll, describe, expect, it} from 'vitest'

// Boots the real web UI in a DOM and walks the first-run flow: create a
// PIN, land on home, open Receive, lock, unlock. Not a pixel test - it
// proves the view wiring, the browser store and keystore-kit's PIN
// ceremony all run outside Node-specific code paths.
//
// The PIN ceremony's key stretching takes real time that varies with
// machine load, so every assertion POLLS for its state rather than
// sleeping a fixed beat.

const type = (digit: string) => {
  const buttons = [...document.querySelectorAll<HTMLButtonElement>('.pad button')]
  const button = buttons.find(candidate => candidate.textContent?.trim() === digit)
  if (!button) throw new Error(`no pad key ${digit}`)
  button.click()
}

const until = async (predicate: () => boolean, what: string, timeoutMs = 10_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, 40))
  }
}

const onHome = () => document.querySelectorAll('.tile').length === 4

const button = (label: string): HTMLButtonElement | undefined =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find(candidate =>
    candidate.textContent?.includes(label)
  )

// Web NFC is Chrome on Android only, so the tests bring their own reader.
// A tap hands back one URI record; a write records what it was given.
const TAG_NOTE = 'lnurlw://mint.example/w?k1=' + 'ab'.repeat(32) + '&amount=21000'

class FakeNDEFReader {
  static written: {records: Array<{recordType: string; data: string}>} | null = null
  onreading: ((event: {message: {records: unknown[]}}) => void) | null = null
  onreadingerror: (() => void) | null = null
  async scan(): Promise<void> {
    setTimeout(() => {
      this.onreading?.({
        message: {records: [{recordType: 'url', data: new DataView(new TextEncoder().encode(TAG_NOTE).buffer)}]}
      })
    }, 10)
  }
  async write(message: {records: Array<{recordType: string; data: string}>}): Promise<void> {
    FakeNDEFReader.written = message
  }
}

beforeAll(async () => {
  document.body.innerHTML = '<div id="app"></div><div id="toasts"></div>'
  await import('../web/src/main.ts')
  await until(() => document.querySelector('[data-create]') !== null, 'the welcome screen')
})

describe('the web wallet', () => {
  it('walks first run: welcome, PIN, confirm, home', async () => {
    expect(document.body.textContent).toContain('Restore a backup')
    document.querySelector<HTMLButtonElement>('[data-create]')!.click()
    await until(() => document.querySelector('.pinwrap') !== null, 'the setup screen')
    expect(document.querySelector('.pinwrap h1')?.textContent).toContain('Choose a PIN')
    for (const digit of '210987') type(digit)
    await until(
      () => document.querySelector('.pinwrap h1')?.textContent?.includes('Once more') ?? false,
      'the confirm screen'
    )
    for (const digit of '210987') type(digit)
    await until(onHome, 'the home screen')
    expect(document.querySelector('[data-balance]')).not.toBeNull()
  })

  it('opens Receive and comes back', async () => {
    document.querySelector<HTMLButtonElement>('[data-go="receive"]')!.click()
    await until(() => document.querySelector('textarea') !== null, 'the receive screen')
    document.querySelector<HTMLButtonElement>('[data-back]')!.click()
    await until(onHome, 'the home screen')
  })

  it('opens Melt: a wallet with no mints gets no Move tab', async () => {
    document.querySelector<HTMLButtonElement>('[data-go="melt"]')!.click()
    await until(() => document.querySelector('[data-meltgo]') !== null, 'the melt screen')
    const tabs = [...document.querySelectorAll<HTMLButtonElement>('[data-tab]')].map(b => b.dataset.tab)
    expect(tabs).toContain('invoice')
    expect(tabs).toContain('address')
    expect(tabs).not.toContain('move')
    document.querySelector<HTMLButtonElement>('[data-back]')!.click()
    await until(onHome, 'the home screen')
  })

  it('opens the signer pairing screen from settings and comes back', async () => {
    document.querySelector<HTMLButtonElement>('[data-settings]')!.click()
    await until(
      () => [...document.querySelectorAll('button')].some(button => button.textContent?.includes('Pair a signer')),
      'the settings screen'
    )
    ;[...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.includes('Pair a signer'))!.click()
    await until(() => document.querySelector('[data-uri]') !== null, 'the pairing screen')
    expect(document.body.textContent).toContain('Bunker URI')
    document.querySelector<HTMLButtonElement>('[data-back]')!.click()
    await until(
      () => [...document.querySelectorAll('button')].some(button => button.textContent?.includes('Lock now')),
      'settings again'
    )
    document.querySelector<HTMLButtonElement>('[data-back]')!.click()
    await until(onHome, 'home')
  })

  it('turns offline mode on from the header and says so', async () => {
    document.querySelector<HTMLButtonElement>('[data-offline]')!.click()
    await until(
      () => document.body.textContent?.includes('offline mode - no mint is called') ?? false,
      'the offline badge'
    )
    document.querySelector<HTMLButtonElement>('[data-go="receive"]')!.click()
    await until(() => document.querySelector('textarea') !== null, 'the receive screen')
    // no relay round trip is offered while offline
    expect(document.querySelector('[data-inbox]')).toBeNull()
    expect(document.body.textContent).toContain('Taking a note with no connection')
    document.querySelector<HTMLButtonElement>('[data-back]')!.click()
    await until(onHome, 'the home screen')
    document.querySelector<HTMLButtonElement>('[data-offline]')!.click()
    await until(
      () => !(document.body.textContent?.includes('offline mode - no mint is called') ?? false),
      'the badge to go'
    )
  })

  it('opens the check screen from settings and comes back', async () => {
    document.querySelector<HTMLButtonElement>('[data-settings]')!.click()
    await until(
      () => [...document.querySelectorAll('button')].some(button => button.textContent?.includes('Check your notes')),
      'the settings screen'
    )
    ;[...document.querySelectorAll<HTMLButtonElement>('button')]
      .find(b => b.textContent?.includes('Check your notes'))!
      .click()
    await until(() => document.querySelector('[data-run]') !== null, 'the check screen')
    expect(document.body.textContent).toContain('It costs you no privacy')
    document.querySelector<HTMLButtonElement>('[data-run]')!.click()
    await until(
      () => [...document.querySelectorAll('.toast')].some(t => t.textContent?.includes('no notes to check')),
      'the empty-case answer'
    )
    document.querySelector<HTMLButtonElement>('[data-back]')!.click()
    await until(
      () => [...document.querySelectorAll('button')].some(button => button.textContent?.includes('Lock now')),
      'settings again'
    )
    document.querySelector<HTMLButtonElement>('[data-back]')!.click()
    await until(onHome, 'home')
  })

  it('reads a note off a tag into the receive screen', async () => {
    ;(globalThis as {NDEFReader?: unknown}).NDEFReader = FakeNDEFReader
    try {
      document.querySelector<HTMLButtonElement>('[data-go="receive"]')!.click()
      await until(() => document.querySelector('textarea') !== null, 'the receive screen')
      const tap = button('Tap a tag')
      expect(tap).toBeDefined()
      tap!.click()
      await until(() => document.body.textContent?.includes('Hold the tag') ?? false, 'the tag prompt')
      await until(
        () => document.querySelector('textarea')!.value === TAG_NOTE,
        'the note off the tag'
      )
      expect(document.querySelector('.scanner')).toBeNull()
      document.querySelector<HTMLButtonElement>('[data-back]')!.click()
      await until(onHome, 'the home screen')
    } finally {
      delete (globalThis as {NDEFReader?: unknown}).NDEFReader
    }
  })

  it('shows no tag controls on a browser without Web NFC', async () => {
    document.querySelector<HTMLButtonElement>('[data-go="receive"]')!.click()
    await until(() => document.querySelector('textarea') !== null, 'the receive screen')
    expect(button('Tap a tag')).toBeUndefined()
    document.querySelector<HTMLButtonElement>('[data-back]')!.click()
    await until(onHome, 'the home screen')
  })

  it('writes a note to a tag as a single URI record', async () => {
    ;(globalThis as {NDEFReader?: unknown}).NDEFReader = FakeNDEFReader
    try {
      const {writeNfc} = await import('../web/src/scanner.ts')
      const written = await writeNfc(TAG_NOTE)
      expect(written).toBe(true)
      // the convention other wallets read: one URI record, the note URL
      expect(FakeNDEFReader.written).toEqual({records: [{recordType: 'url', data: TAG_NOTE}]})
    } finally {
      delete (globalThis as {NDEFReader?: unknown}).NDEFReader
    }
  })

  it('picks a note, an invoice or a mint out of what was shared in', async () => {
    const {shareTargetInput} = await import('../web/src/main.ts')
    expect(shareTargetInput(`?text=${encodeURIComponent(TAG_NOTE)}`)).toBe(TAG_NOTE)
    expect(shareTargetInput(`?url=${encodeURIComponent(TAG_NOTE)}`)).toBe(TAG_NOTE)
    // a sentence with the link inside it, which is how apps really share
    expect(shareTargetInput(`?text=${encodeURIComponent(`here you go ${TAG_NOTE} enjoy`)}`)).toBe(TAG_NOTE)
    expect(shareTargetInput(`?text=${encodeURIComponent(`lightning:${TAG_NOTE}`)}`)).toBe(TAG_NOTE)
    expect(shareTargetInput('?text=' + encodeURIComponent('mint@mint.example'))).toBe('mint@mint.example')
    expect(shareTargetInput('?text=just%20a%20message')).toBeNull()
    expect(shareTargetInput('')).toBeNull()
  })

  it('locks and unlocks with the PIN', async () => {
    document.querySelector<HTMLButtonElement>('[data-settings]')!.click()
    await until(
      () => [...document.querySelectorAll('button')].some(button => button.textContent?.includes('Lock now')),
      'the settings screen'
    )
    const lock = [...document.querySelectorAll<HTMLButtonElement>('button')].find(button =>
      button.textContent?.includes('Lock now')
    )
    lock!.click()
    await until(() => document.querySelector('.pinwrap') !== null, 'the lock screen')
    for (const digit of '210987') type(digit)
    await until(onHome, 'the unlocked home screen')
  })
})
