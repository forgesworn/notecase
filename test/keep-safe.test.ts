// @vitest-environment happy-dom
import {beforeAll, describe, expect, it} from 'vitest'

// The same first-run walk as web.test.ts, but in a browser that HAS a
// storage manager and refuses to persist - which is the case the step after
// the recovery words exists for. web.test.ts's DOM has no storage manager
// and no install prompt, so it goes straight to home and proves the quiet
// path; this file proves the loud one.

const persistCalls: string[] = []

const until = async (predicate: () => boolean, what: string, timeoutMs = 10_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, 40))
  }
}

const type = (digit: string) => {
  const buttons = [...document.querySelectorAll<HTMLButtonElement>('.pad button')]
  const key = buttons.find(candidate => candidate.textContent?.trim() === digit)
  if (!key) throw new Error(`no pad key ${digit}`)
  key.click()
}

const onHome = () => document.querySelectorAll('.tile').length === 4

beforeAll(async () => {
  Object.defineProperty(navigator, 'storage', {
    configurable: true,
    value: {
      persisted: async () => {
        persistCalls.push('persisted')
        return false
      },
      persist: async () => {
        persistCalls.push('persist')
        return false
      }
    }
  })
  document.body.innerHTML = '<div id="app"></div><div id="toasts"></div>'
  await import('../web/src/main.ts')
  await until(() => document.querySelector('[data-create]') !== null, 'the welcome screen')
})

describe('keeping the wallet safe from the browser', () => {
  it('stops after the recovery words to say the browser may bin this wallet', async () => {
    document.querySelector<HTMLButtonElement>('[data-create]')!.click()
    await until(() => document.querySelector('.pinwrap') !== null, 'the setup screen')
    for (const digit of '210987') type(digit)
    await until(
      () => document.querySelector('.pinwrap h1')?.textContent?.includes('Once more') ?? false,
      'the confirm screen'
    )
    for (const digit of '210987') type(digit)
    await until(() => document.querySelector('[data-gate]') !== null, 'the recovery words')
    const gate = document.querySelector<HTMLInputElement>('[data-gate]')!
    gate.checked = true
    gate.dispatchEvent(new Event('change'))
    document.querySelector<HTMLButtonElement>('[data-done]')!.click()

    await until(() => document.querySelector('[data-keepsafe]') !== null, 'the keep-safe step')
    expect(onHome()).toBe(false)
    expect(document.body.textContent).toContain('clear this wallet away')
  })

  it('asks the browser to keep the wallet, and says so plainly when it will not', async () => {
    persistCalls.length = 0
    document.querySelector<HTMLButtonElement>('[data-keepsafe-persist]')!.click()
    await until(() => persistCalls.includes('persist'), 'the persistence request')
    await until(
      () => document.querySelector('[data-keepsafe-state]')?.textContent?.includes('refused') ?? false,
      'the refusal reported'
    )
  })

  it('lets the step be skipped, and lands on home', async () => {
    document.querySelector<HTMLButtonElement>('[data-keepsafe-skip]')!.click()
    await until(onHome, 'the home screen')
  })

  it('reports the storage state in settings, where it can be fixed later', async () => {
    document.querySelector<HTMLButtonElement>('[data-settings]')!.click()
    await until(
      () => document.querySelector('[data-storagecard]')?.textContent?.includes('refused') ?? false,
      'the storage card in settings'
    )
    // and the lever it can still pull, since the grant was refused
    expect(document.querySelector('[data-storagefix]')).not.toBeNull()
  })
})
