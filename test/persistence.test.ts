import {describe, expect, it} from 'vitest'
import {
  createInstallWatcher,
  installState,
  persistenceState,
  requestPersistence,
  shouldOfferKeepSafe,
  type InstallEnv
} from '../web/src/persistence.ts'

// A bearer note lives in this browser's localStorage, and a browser is
// allowed to evict that under storage pressure. The twelve words rebuild
// every note this wallet derived, but not one somebody handed over that
// has not been rotated yet, and not the mints, pins or history. So
// persistence is not a nicety here, and neither is being honest about
// whether we actually got it.

const storageThat = (persisted: boolean, granting: boolean) => {
  const calls: string[] = []
  return {
    calls,
    api: {
      persisted: async () => {
        calls.push('persisted')
        return persisted
      },
      persist: async () => {
        calls.push('persist')
        return granting
      }
    }
  }
}

describe('requestPersistence', () => {
  it('reports granted without asking again when storage is already persistent', async () => {
    const storage = storageThat(true, false)
    expect(await requestPersistence(storage.api)).toBe('granted')
    expect(storage.calls).toEqual(['persisted'])
  })

  it('asks for persistence when it does not have it, and reports the grant', async () => {
    const storage = storageThat(false, true)
    expect(await requestPersistence(storage.api)).toBe('granted')
    expect(storage.calls).toEqual(['persisted', 'persist'])
  })

  it('reports denied when the browser refuses', async () => {
    const storage = storageThat(false, false)
    expect(await requestPersistence(storage.api)).toBe('denied')
  })

  it('reports unsupported rather than throwing where there is no storage manager', async () => {
    expect(await requestPersistence(undefined)).toBe('unsupported')
  })

  it('reports unsupported where the storage manager cannot persist', async () => {
    expect(await requestPersistence({persisted: async () => false})).toBe('unsupported')
  })
})

describe('persistenceState', () => {
  it('reads the current state without ever asking for a grant', async () => {
    const storage = storageThat(false, true)
    expect(await persistenceState(storage.api)).toBe('denied')
    expect(storage.calls).toEqual(['persisted'])
  })

  it('reports granted when storage is already persistent', async () => {
    const storage = storageThat(true, true)
    expect(await persistenceState(storage.api)).toBe('granted')
  })

  it('reports unsupported where there is no storage manager', async () => {
    expect(await persistenceState(undefined)).toBe('unsupported')
  })
})

// Install state exists to answer one question honestly: is there a button
// worth showing, and will pressing it do anything? iOS has no
// beforeinstallprompt and never will, so a wallet that shows a dead button
// there is lying; it gets told to use Share -> Add to Home Screen instead.

const IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'
const IPAD = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15'
const CHROME = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'

const env = (over: Partial<InstallEnv> = {}): InstallEnv => ({
  displayStandalone: false,
  navigatorStandalone: false,
  maxTouchPoints: 0,
  userAgent: CHROME,
  hasPrompt: false,
  ...over
})

describe('installState', () => {
  it('is installed when the page is running in standalone display mode', () => {
    expect(installState(env({displayStandalone: true}))).toBe('installed')
  })

  it('is installed on an iOS home-screen launch, which reports standalone on navigator instead', () => {
    expect(installState(env({userAgent: IOS, navigatorStandalone: true}))).toBe('installed')
  })

  it('is available once a beforeinstallprompt has been captured', () => {
    expect(installState(env({hasPrompt: true}))).toBe('available')
  })

  it('counts an installed app as installed even where a prompt was also captured', () => {
    expect(installState(env({displayStandalone: true, hasPrompt: true}))).toBe('installed')
  })

  it('tells iOS to add to the home screen by hand, since it has no prompt to fire', () => {
    expect(installState(env({userAgent: IOS}))).toBe('ios-manual')
  })

  it('recognises an iPadOS Safari that reports itself as a Mac by its touch points', () => {
    expect(installState(env({userAgent: IPAD, maxTouchPoints: 5}))).toBe('ios-manual')
  })

  it('leaves a real desktop Safari alone rather than calling it iOS', () => {
    expect(installState(env({userAgent: IPAD, maxTouchPoints: 0}))).toBe('unavailable')
  })

  it('is unavailable on a browser that has offered no prompt', () => {
    expect(installState(env())).toBe('unavailable')
  })
})

// The capture has to happen before the app renders, because Chrome fires
// beforeinstallprompt once and early. Holding it as a watcher object rather
// than module state keeps it out of the tests' way, and keeps two of them
// from sharing one captured event.

type FakeEvent = {prompt: () => Promise<void>; userChoice: Promise<{outcome: string}>}

const fakePrompt = (outcome: 'accepted' | 'dismissed') => {
  const calls: string[] = []
  const event: FakeEvent = {
    prompt: async () => {
      calls.push('prompt')
    },
    userChoice: Promise.resolve({outcome})
  }
  return {event, calls}
}

describe('install watcher', () => {
  it('has no prompt before the browser offers one', () => {
    const watcher = createInstallWatcher(new EventTarget())
    expect(watcher.hasPrompt()).toBe(false)
  })

  it('captures the browser offer and suppresses the browser own banner', () => {
    const target = new EventTarget()
    const watcher = createInstallWatcher(target)
    const offer = Object.assign(new Event('beforeinstallprompt', {cancelable: true}), fakePrompt('accepted').event)
    target.dispatchEvent(offer)
    expect(watcher.hasPrompt()).toBe(true)
    expect(offer.defaultPrevented).toBe(true)
  })

  it('reports unavailable when asked to fire with nothing captured', async () => {
    const watcher = createInstallWatcher(new EventTarget())
    expect(await watcher.fire()).toBe('unavailable')
  })

  it('fires the captured prompt and reports that it was accepted', async () => {
    const target = new EventTarget()
    const watcher = createInstallWatcher(target)
    const {event, calls} = fakePrompt('accepted')
    target.dispatchEvent(Object.assign(new Event('beforeinstallprompt'), event))
    expect(await watcher.fire()).toBe('accepted')
    expect(calls).toEqual(['prompt'])
  })

  it('reports a dismissal and keeps the prompt, since a browser only offers it once', async () => {
    const target = new EventTarget()
    const watcher = createInstallWatcher(target)
    const {event} = fakePrompt('dismissed')
    target.dispatchEvent(Object.assign(new Event('beforeinstallprompt'), event))
    expect(await watcher.fire()).toBe('dismissed')
    expect(watcher.hasPrompt()).toBe(true)
  })

  it('drops the prompt once the app reports itself installed', () => {
    const target = new EventTarget()
    const watcher = createInstallWatcher(target)
    const {event} = fakePrompt('accepted')
    target.dispatchEvent(Object.assign(new Event('beforeinstallprompt'), event))
    target.dispatchEvent(new Event('appinstalled'))
    expect(watcher.hasPrompt()).toBe(false)
  })
})

// A screen that cannot change anything is a nag. This decides whether the
// step after the recovery words has something to offer at all - which is
// also why the existing first-run walk still lands straight on home in a
// test DOM with no storage manager and no install prompt.

describe('shouldOfferKeepSafe', () => {
  it('says nothing when the storage grant is already held', () => {
    expect(shouldOfferKeepSafe('granted', 'available')).toBe(false)
    expect(shouldOfferKeepSafe('granted', 'ios-manual')).toBe(false)
  })

  it('speaks up when the grant was refused, because asking is worth a try', () => {
    expect(shouldOfferKeepSafe('denied', 'unavailable')).toBe(true)
  })

  it('speaks up on iOS, where the home screen is the only way to earn the grant', () => {
    expect(shouldOfferKeepSafe('unsupported', 'ios-manual')).toBe(true)
  })

  it('offers the install where that is the lever, even with no storage manager', () => {
    expect(shouldOfferKeepSafe('unsupported', 'available')).toBe(true)
  })

  it('stays quiet where nothing it could offer would help', () => {
    expect(shouldOfferKeepSafe('unsupported', 'unavailable')).toBe(false)
    expect(shouldOfferKeepSafe('unsupported', 'installed')).toBe(false)
  })
})
