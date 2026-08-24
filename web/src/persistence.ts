// Whether this browser has promised to keep the wallet.
//
// The store is a sealed blob in localStorage, and localStorage is evictable:
// under storage pressure a browser may discard it for an origin it does not
// think matters. The twelve words rebuild every note this wallet derived,
// but not one somebody handed over that has not been rotated yet, and not
// the mints, pins, history or pending outcomes. So the grant is worth
// asking for - and worth reporting truthfully when it is refused, because
// `persist()` is a request, not a control. Firefox asks the person, Safari
// decides on its own, Chrome largely grants it to origins it considers
// installed or engaged.

export type StorageState = 'granted' | 'denied' | 'unsupported'

// Only the two methods this needs, and both optional: an older browser has
// a storage manager with no persist() on it, which is a real case and not
// an error. Asking for the whole StorageManager would be asking for
// estimate() and getDirectory() that nothing here calls.
export type PersistableStorage = Partial<Pick<StorageManager, 'persisted' | 'persist'>>

type Persistable = Required<PersistableStorage>

const persistable = (storage?: PersistableStorage): storage is Persistable =>
  typeof storage?.persisted === 'function' && typeof storage?.persist === 'function'

/** Reads the grant without ever asking for one. */
export const persistenceState = async (storage?: PersistableStorage): Promise<StorageState> => {
  if (!persistable(storage)) return 'unsupported'
  return (await storage.persisted()) ? 'granted' : 'denied'
}

/** Asks for the grant, unless it is already held. */
export const requestPersistence = async (storage?: PersistableStorage): Promise<StorageState> => {
  if (!persistable(storage)) return 'unsupported'
  if (await storage.persisted()) return 'granted'
  return (await storage.persist()) ? 'granted' : 'denied'
}

// ---------- install ----------

export type InstallState = 'installed' | 'available' | 'ios-manual' | 'unavailable'

export type InstallEnv = {
  /** matchMedia('(display-mode: standalone)') - everywhere but iOS Safari */
  displayStandalone: boolean
  /** navigator.standalone - iOS Safari's own answer to the same question */
  navigatorStandalone: boolean
  /** iPadOS Safari reports a Mac user agent; touch points give it away */
  maxTouchPoints: number
  userAgent: string
  /** a beforeinstallprompt has been captured and can still be fired */
  hasPrompt: boolean
}

const isApplePhoneOrTablet = (env: InstallEnv): boolean =>
  /iPhone|iPad|iPod/.test(env.userAgent) || (/Macintosh/.test(env.userAgent) && env.maxTouchPoints > 0)

export const installState = (env: InstallEnv): InstallState => {
  if (env.displayStandalone || env.navigatorStandalone) return 'installed'
  if (env.hasPrompt) return 'available'
  if (isApplePhoneOrTablet(env)) return 'ios-manual'
  return 'unavailable'
}

type InstallPromptEvent = Event & {
  prompt: () => Promise<void>
  userChoice: Promise<{outcome: 'accepted' | 'dismissed'}>
}

export type InstallWatcher = {
  hasPrompt: () => boolean
  fire: () => Promise<'accepted' | 'dismissed' | 'unavailable'>
  env: () => InstallEnv
}

// Chrome fires beforeinstallprompt once, early, and only the event it hands
// over can open the install dialog - so it has to be caught before the app
// renders and kept. preventDefault stops the browser's own mini-infobar
// fighting the wallet's UI for the same decision. A dismissal keeps the
// event: the browser will not offer a second one, and someone who said not
// now may well say yes from Settings later.
export const createInstallWatcher = (target: EventTarget): InstallWatcher => {
  let prompt: InstallPromptEvent | null = null

  target.addEventListener('beforeinstallprompt', event => {
    event.preventDefault()
    prompt = event as InstallPromptEvent
  })
  target.addEventListener('appinstalled', () => {
    prompt = null
  })

  return {
    hasPrompt: () => prompt !== null,
    fire: async () => {
      if (!prompt) return 'unavailable'
      await prompt.prompt()
      const {outcome} = await prompt.userChoice
      if (outcome === 'accepted') prompt = null
      return outcome
    },
    env: () => ({
      displayStandalone: globalThis.matchMedia?.('(display-mode: standalone)').matches ?? false,
      navigatorStandalone: (navigator as {standalone?: boolean}).standalone ?? false,
      maxTouchPoints: navigator.maxTouchPoints ?? 0,
      userAgent: navigator.userAgent,
      hasPrompt: prompt !== null
    })
  }
}

// Is there anything worth saying after the recovery words?
//
// Only where the wallet is not already durable AND there is a lever to
// pull. A grant already held needs no screen; a browser with no storage
// manager and no way to install has nothing this screen could change, and
// showing it anyway would be a nag with no button that works.
export const shouldOfferKeepSafe = (storage: StorageState, install: InstallState): boolean => {
  if (storage === 'granted') return false
  if (storage === 'denied') return true
  return install === 'available' || install === 'ios-manual'
}
