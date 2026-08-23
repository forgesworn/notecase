// @vitest-environment happy-dom
import {beforeAll, describe, expect, it, vi} from 'vitest'
import {Wallet, WalletUsageError} from '../src/wallet.ts'

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
    // the twelve words, once, behind a gate you have to tick
    await until(() => document.querySelector('[data-gate]') !== null, 'the recovery words')
    expect(document.body.textContent).toContain('Write these twelve words on paper')
    expect(document.querySelector('[data-words]')!.textContent!.split(/\s+/).length).toBe(24)
    const done = document.querySelector<HTMLButtonElement>('[data-done]')!
    expect(done.disabled).toBe(true)
    const gate = document.querySelector<HTMLInputElement>('[data-gate]')!
    gate.checked = true
    gate.dispatchEvent(new Event('change'))
    expect(done.disabled).toBe(false)
    done.click()
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

  it('offers a note picker on Send, and calls it a hand-over while offline', async () => {
    const summary = () => document.querySelector('details summary')?.textContent
    document.querySelector<HTMLButtonElement>('[data-go="send"]')!.click()
    await until(() => document.querySelector('[data-cut]') !== null, 'the send screen')
    expect(summary()).toBe('Choose which notes to spend')
    document.querySelector<HTMLButtonElement>('[data-back]')!.click()
    await until(onHome, 'the home screen')

    document.querySelector<HTMLButtonElement>('[data-offline]')!.click()
    await until(
      () => document.body.textContent?.includes('offline mode - no mint is called') ?? false,
      'the offline badge'
    )
    document.querySelector<HTMLButtonElement>('[data-go="send"]')!.click()
    await until(() => document.querySelector('[data-cut]') !== null, 'the send screen offline')
    // Offline the tick is not a preference. Nothing can be cut to size with
    // no mint in the loop, so the notes chosen are what changes hands, and
    // the wording has to say so before anything does.
    expect(summary()).toBe('Choose which notes to hand over')
    document.querySelector<HTMLButtonElement>('[data-back]')!.click()
    await until(onHome, 'the home screen')
    document.querySelector<HTMLButtonElement>('[data-offline]')!.click()
    await until(
      () => !(document.body.textContent?.includes('offline mode - no mint is called') ?? false),
      'the badge to go'
    )
  })

  // The picker's whole point is that the ticks reach the engine. What the
  // engine then does with them is covered against a real mint in
  // pick-notes.test.ts; what is only reachable here is the wiring, so the
  // engine is stubbed out at the call and the arguments are the assertion.
  it('hands the ticked notes to the engine, on both send paths', async () => {
    const fake = (id: string, amountMsat: number) => ({
      id,
      k1: id,
      amountMsat,
      baseUrl: 'https://mint.example/w',
      callback: 'https://mint.example/w/cb',
      mintHost: 'mint.example',
      state: 'live' as const,
      origin: 'mint' as const,
      createdAt: 1,
      updatedAt: 1
    })
    const notes = [fake('aa'.repeat(32), 21_000), fake('bb'.repeat(32), 40_000)]
    const live = vi.spyOn(Wallet.prototype, 'liveNotes').mockReturnValue(notes)
    // Both refuse, so nothing renders past the click and the toast is the
    // end of it - the call itself is what is being read.
    const cut = vi.spyOn(Wallet.prototype, 'send').mockRejectedValue(new WalletUsageError('stopped'))
    const offline = vi.spyOn(Wallet.prototype, 'sendOffline').mockRejectedValue(new WalletUsageError('stopped'))
    // The offline screen asks what the hand-over would cost before it
    // commits to one, so that has to answer for the stubbed notes too.
    const plan = vi.spyOn(Wallet.prototype, 'planOfflineSend').mockReturnValue({
      mintHost: 'mint.example',
      notes: [notes[1]!],
      totalMsat: 40_000,
      overpayMsat: 0,
      capped: false
    })

    const tickTheSecond = () => {
      const boxes = [...document.querySelectorAll<HTMLInputElement>('details input[type="checkbox"]')]
      expect(boxes).toHaveLength(2)
      // largest first, so this is the 40k note - not the one a wallet
      // picking for itself would reach for to make 5 sat
      boxes[0]!.click()
      const amount = document.querySelector<HTMLInputElement>('[data-amount]')!
      amount.value = '5'
      amount.dispatchEvent(new Event('input'))
      document.querySelector<HTMLButtonElement>('[data-cut]')!.click()
    }

    document.querySelector<HTMLButtonElement>('[data-go="send"]')!.click()
    await until(() => document.querySelector('[data-cut]') !== null, 'the send screen')
    tickTheSecond()
    await until(() => cut.mock.calls.length > 0, 'the cut')
    expect(cut.mock.calls[0]).toEqual([5_000, undefined, ['bb'.repeat(32)]])

    // Same screen, same ticks, and a recipient typed in: the note sealed to
    // their key comes out of the chosen one too.
    const nostr = vi
      .spyOn(Wallet.prototype, 'sendToNostr')
      .mockRejectedValue(new WalletUsageError('stopped'))
    const to = document.querySelector<HTMLInputElement>('[data-npub]')!
    to.value = 'them@wallet.example'
    // the button is disabled while the first attempt is in flight, and a
    // click on a disabled button is silently nothing
    await until(() => !document.querySelector<HTMLButtonElement>('[data-cut]')!.disabled, 'the button back')
    document.querySelector<HTMLButtonElement>('[data-cut]')!.click()
    await until(() => nostr.mock.calls.length > 0, 'the wrap')
    expect(nostr.mock.calls[0]!.slice(1)).toEqual([
      5_000,
      'them@wallet.example',
      undefined,
      {noteIds: ['bb'.repeat(32)]}
    ])
    nostr.mockRestore()

    document.querySelector<HTMLButtonElement>('[data-back]')!.click()
    await until(onHome, 'the home screen')

    document.querySelector<HTMLButtonElement>('[data-offline]')!.click()
    await until(
      () => document.body.textContent?.includes('offline mode - no mint is called') ?? false,
      'the offline badge'
    )
    document.querySelector<HTMLButtonElement>('[data-go="send"]')!.click()
    await until(() => document.querySelector('[data-cut]') !== null, 'the send screen offline')
    tickTheSecond()
    await until(() => offline.mock.calls.length > 0, 'the hand-over')
    expect(offline.mock.calls[0]).toEqual([5_000, undefined, {noteIds: ['bb'.repeat(32)]}])
    // and what it costs is worked out from the same notes, so the overpay
    // the payer is shown is the one they would actually be making
    expect(plan.mock.calls[0]).toEqual([5_000, undefined, ['bb'.repeat(32)]])

    document.querySelector<HTMLButtonElement>('[data-back]')!.click()
    await until(onHome, 'the home screen')
    document.querySelector<HTMLButtonElement>('[data-offline]')!.click()
    await until(
      () => !(document.body.textContent?.includes('offline mode - no mint is called') ?? false),
      'the badge to go'
    )
    live.mockRestore()
    cut.mockRestore()
    offline.mockRestore()
    plan.mockRestore()
  })

  it('says plainly that this browser cannot reach a vault over USB', async () => {
    // happy-dom has no Web Serial, which is the same position Safari and
    // Firefox are in. A button that cannot work must not be offered, and
    // the reason has to be on screen - otherwise someone plugs a vault in
    // and concludes it is broken.
    document.querySelector<HTMLButtonElement>('[data-settings]')!.click()
    await until(() => button('Lock now') !== undefined, 'the settings screen')
    expect(document.body.textContent).toContain('Hardware vault')
    expect(document.body.textContent).toContain('needs Web Serial')
    expect(button('Open vault')).toBeUndefined()
    document.querySelector<HTMLButtonElement>('[data-back]')!.click()
    await until(onHome, 'home')
  })

  it('grants, shows and revokes a connection from the wallet you carry', async () => {
    // A capability issued on one machine has to be revocable from the
    // device in your pocket, or it is a bad capability.
    document.querySelector<HTMLButtonElement>('[data-settings]')!.click()
    await until(() => button('Lock now') !== undefined, 'the settings screen')
    button('Connected apps')!.click()
    await until(() => button('Grant a connection') !== undefined, 'the connections screen')
    expect(document.body.textContent).toContain('None yet')

    const tick = (selector: string, on: boolean) => {
      const box = document.querySelector<HTMLInputElement>(selector)!
      if (box.checked !== on) box.click()
    }
    const name = () => document.querySelector<HTMLInputElement>('[data-name]')!

    // Spending with no budget is refused, and says why.
    name().value = 'greedy'
    tick('[data-spend]', true)
    button('Grant a connection')!.click()
    await until(
      () => document.body.textContent?.includes('no unlimited connection') ?? false,
      'the refusal',
    )
    expect(button('Revoke')).toBeUndefined()

    // Invoice-only goes through, and lands in the list.
    tick('[data-spend]', false)
    name().value = 'the shop till'
    button('Grant a connection')!.click()
    await until(() => button('Revoke') !== undefined, 'the granted connection')
    expect(document.body.textContent).toContain('the shop till')
    expect(document.body.textContent).toContain('Cannot spend')

    button('Revoke')!.click()
    await until(() => document.body.textContent?.includes('revoked') ?? false, 'the revocation')
    expect(button('Revoke')).toBeUndefined()

    document.querySelector<HTMLButtonElement>('[data-back]')!.click()
    await until(() => button('Lock now') !== undefined, 'settings again')
    document.querySelector<HTMLButtonElement>('[data-back]')!.click()
    await until(onHome, 'home')
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

  it('offers a lightning address in settings, and says a mint is needed first', async () => {
    document.querySelector<HTMLButtonElement>('[data-settings]')!.click()
    await until(() => button('Lock now') !== undefined, 'the settings screen')
    expect(document.body.textContent).toContain('Lightning address')
    // no mints yet, so the form says so rather than offering a price
    expect(document.body.textContent).toContain('Add a mint first')
    expect(document.querySelector('[data-name]')).not.toBeNull()
    document.querySelector<HTMLButtonElement>('[data-back]')!.click()
    await until(onHome, 'home')
  })

  it('shows the recovery words again behind the PIN, and offers to ask the mints', async () => {
    document.querySelector<HTMLButtonElement>('[data-settings]')!.click()
    await until(() => button('Show my words') !== undefined, 'the settings screen')
    expect(document.body.textContent).toContain('Recovery words')
    expect(button('Ask my mints what is still mine')).toBeDefined()
    button('Show my words')!.click()
    await until(() => document.querySelector('.pinwrap') !== null, 'the PIN prompt')
    for (const digit of '210987') type(digit)
    await until(() => document.querySelector('[data-gate]') !== null, 'the words again')
    expect(document.querySelector('[data-words]')!.textContent!.split(/\s+/).length).toBe(24)
    const gate = document.querySelector<HTMLInputElement>('[data-gate]')!
    gate.checked = true
    gate.dispatchEvent(new Event('change'))
    document.querySelector<HTMLButtonElement>('[data-done]')!.click()
    await until(() => button('Lock now') !== undefined, 'settings again')
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
