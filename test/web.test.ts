// @vitest-environment happy-dom
import {beforeAll, describe, expect, it} from 'vitest'

// Boots the real web UI in a DOM and walks the first-run flow: create a
// PIN, land on home, open Receive. Not a pixel test - it proves the view
// wiring, the browser store and keystore-kit's PIN ceremony all run
// outside Node-specific code paths.

const type = (digit: string) => {
  const buttons = [...document.querySelectorAll<HTMLButtonElement>('.pad button')]
  const button = buttons.find(candidate => candidate.textContent?.trim() === digit)
  if (!button) throw new Error(`no pad key ${digit}`)
  button.click()
}

const settle = () => new Promise(resolve => setTimeout(resolve, 120))

beforeAll(async () => {
  document.body.innerHTML = '<div id="app"></div><div id="toasts"></div>'
  await import('../web/src/main.ts')
  await settle()
})

describe('the web wallet', () => {
  it('walks first run: PIN, confirm, home', async () => {
    expect(document.querySelector('.pinwrap h1')?.textContent).toContain('Welcome')
    for (const digit of '210987') type(digit)
    await settle()
    expect(document.querySelector('.pinwrap h1')?.textContent).toContain('Once more')
    for (const digit of '210987') type(digit)
    await settle()
    await settle()
    expect(document.querySelector('[data-balance]')).not.toBeNull()
    expect(document.querySelectorAll('.tile')).toHaveLength(4)
  })

  it('opens Receive and comes back', async () => {
    document.querySelector<HTMLButtonElement>('[data-go="receive"]')!.click()
    await settle()
    expect(document.querySelector('textarea')).not.toBeNull()
    document.querySelector<HTMLButtonElement>('[data-back]')!.click()
    await settle()
    expect(document.querySelectorAll('.tile')).toHaveLength(4)
  })

  it('locks and unlocks with the PIN', async () => {
    document.querySelector<HTMLButtonElement>('[data-settings]')!.click()
    await settle()
    const lock = [...document.querySelectorAll<HTMLButtonElement>('button')].find(button =>
      button.textContent?.includes('Lock now')
    )
    lock!.click()
    await settle()
    expect(document.querySelector('.pinwrap')).not.toBeNull()
    for (const digit of '210987') type(digit)
    await settle()
    await settle()
    expect(document.querySelectorAll('.tile')).toHaveLength(4)
  })
})
