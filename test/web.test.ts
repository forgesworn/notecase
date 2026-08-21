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
