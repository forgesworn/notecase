// @vitest-environment happy-dom
import {afterEach, describe, expect, it} from 'vitest'
import {bearerNoteIdOfPreimage, hashK1} from '../src/lnurlcash.js'
import {emptyWallet} from '../src/types.ts'
import {createBrowserWallet, unlockWithPin} from '../web/src/browser-store.ts'
import {freshK1} from './helpers.ts'

// The PWA keeps the same sealed wallet the CLI does, so an older one there is
// moved onto Q-keyed note ids the same way, as it is unlocked.
describe('the browser wallet store', () => {
  afterEach(() => {
    localStorage.clear()
  })

  it('moves an older wallet onto Q-keyed note ids as it is unlocked', async () => {
    const k1 = freshK1()
    const data = emptyWallet()
    data.notes.push({
      id: hashK1(k1),
      k1,
      amountMsat: 21_000,
      baseUrl: 'https://mint.example/w',
      callback: 'https://mint.example/cb',
      mintHost: 'mint.example',
      state: 'live',
      origin: 'receive',
      createdAt: 1,
      updatedAt: 1
    })
    // written as an older release wrote it, then locked
    const created = await createBrowserWallet('123456', structuredClone(data))
    created.data.notes[0]!.id = hashK1(k1)
    await created.save()

    const opened = await unlockWithPin('123456')
    expect(opened!.data.notes[0]!.id).toBe(bearerNoteIdOfPreimage(k1))
  })
})
