// @vitest-environment happy-dom
import {beforeAll, beforeEach, describe, expect, it} from 'vitest'
import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'

// The share target, as a POST.
//
// A shared payload can be a live bearer note, and the secret in it is the
// money. A GET share target puts that secret in the request line, which is
// what a web server writes to its access log - and the wallet is not
// necessarily served by the mint that issued the note, so one operator's
// log would hold another's secrets. These tests pin the property that
// matters: the secret never appears in a URL.

const NOTE = 'lnurlw://mint.example/w?k1=' + 'ab'.repeat(32) + '&amount=21000'

// ---- the service worker half -------------------------------------------
//
// share-handler.js is a separate file because it has to be importable into
// the generated Workbox worker. It is evaluated here against a fake `self`
// so the listener it registers can be driven directly.

interface FetchEvent {
  request: Request
  respondWith(response: Promise<Response> | Response): void
}

const loadHandler = (cacheStore: Map<string, Response>) => {
  // Resolved from the working directory: under happy-dom `import.meta.url`
  // is an http URL, so fileURLToPath refuses it.
  const source = readFileSync(resolve(process.cwd(), 'web/public/share-handler.js'), 'utf-8')
  let listener: ((event: FetchEvent) => void) | undefined
  const fakeCaches = {
    open: async () => ({
      put: async (key: string, response: Response) => {
        cacheStore.set(key, response)
      },
      match: async (key: string) => cacheStore.get(key),
      delete: async (key: string) => cacheStore.delete(key)
    })
  }
  // Named anything but `self`: a local `self` would shadow the global one
  // and put the whole function body in its temporal dead zone.
  const fakeSelf = {
    location: {origin: 'https://wallet.example', href: 'https://wallet.example/sw.js'},
    addEventListener: (name: string, fn: (event: FetchEvent) => void) => {
      if (name === 'fetch') listener = fn
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function('self', 'caches', 'Response', source)(fakeSelf, fakeCaches, Response)
  if (!listener) throw new Error('share-handler registered no fetch listener')
  return listener
}

/** Drives one request through the worker's listener. */
const post = async (
  listener: (event: FetchEvent) => void,
  url: string,
  form: FormData | null,
  method = 'POST'
): Promise<Response | null> => {
  const request = {
    method,
    url,
    formData: async () => {
      if (!form) throw new Error('not a form')
      return form
    }
  } as unknown as Request
  let answered: Promise<Response> | Response | null = null
  listener({request, respondWith: response => { answered = response }})
  return answered === null ? null : await answered
}

describe('the share worker', () => {
  let swStore: Map<string, Response>
  beforeEach(() => { swStore = new Map() })

  it('takes the POST, stashes the fields and redirects to a clean root', async () => {
    const listener = loadHandler(swStore)
    const form = new FormData()
    form.set('text', NOTE)

    const response = await post(listener, 'https://wallet.example/share', form)
    expect(response).not.toBeNull()
    expect(response!.status).toBe(303)
    // The redirect target carries nothing: no query, no fragment.
    expect(new URL(response!.headers.get('location')!, 'https://wallet.example').href).toBe(
      'https://wallet.example/'
    )
    expect(response!.headers.get('location')).not.toContain('ab'.repeat(32))

    const stashed = swStore.get('/__notecase_pending_share__')
    expect(stashed).toBeDefined()
    expect(JSON.parse(await stashed!.text()).text).toBe(NOTE)
  })

  it('leaves everything that is not the share POST alone', async () => {
    const listener = loadHandler(swStore)
    // A GET to /share is the fallback path, and the page handles it.
    expect(await post(listener, 'https://wallet.example/share', null, 'GET')).toBeNull()
    // A POST elsewhere is somebody else's business.
    expect(await post(listener, 'https://wallet.example/other', new FormData())).toBeNull()
    // And a POST to another origin's /share is not ours to answer.
    expect(await post(listener, 'https://elsewhere.example/share', new FormData())).toBeNull()
  })

  it('still lands the user somewhere sane when the form cannot be read', async () => {
    const listener = loadHandler(swStore)
    // Losing a share is a nuisance; a broken page while holding a note is
    // worse. So a redirect either way, and nothing stashed.
    const response = await post(listener, 'https://wallet.example/share', null)
    expect(response!.status).toBe(303)
    expect(swStore.size).toBe(0)
  })
})

// ---- the page half ------------------------------------------------------
//
// Importing main.ts boots the wallet, so it needs the shell the real page
// provides, and it is imported once for the whole file.

const store = new Map<string, Response>()
let collectPostedShare: () => Promise<string | null>

beforeAll(async () => {
  ;(globalThis as {caches?: unknown}).caches = {
    open: async () => ({
      match: async (key: string) => store.get(key),
      delete: async (key: string) => store.delete(key),
      put: async (key: string, value: Response) => { store.set(key, value) }
    })
  }
  document.body.innerHTML = '<div id="app"></div><div id="toasts"></div>'
  ;({collectPostedShare} = await import('../web/src/main.ts'))
})

describe('the page collects a posted share', () => {
  it('reads the stash, picks the note out of it, and clears it', async () => {
    store.set(
      '/__notecase_pending_share__',
      new Response(JSON.stringify({text: `here you go ${NOTE} enjoy`}))
    )

    expect(await collectPostedShare()).toBe(NOTE)
    // Collected once: a second boot must not re-offer somebody else's note.
    expect(store.size).toBe(0)
    expect(await collectPostedShare()).toBeNull()
  })

  it('says nothing when there is no stash', async () => {
    store.clear()
    expect(await collectPostedShare()).toBeNull()
  })

  it('survives a browser with no cache API at all', async () => {
    const had = (globalThis as {caches?: unknown}).caches
    delete (globalThis as {caches?: unknown}).caches
    expect(await collectPostedShare()).toBeNull()
    ;(globalThis as {caches?: unknown}).caches = had
  })
})
