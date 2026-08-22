// The Web Share Target, as a POST.
//
// A shared payload can be a live bearer note, and the secret in it IS the
// money. A GET share target puts that secret in the request line, which is
// exactly what a web server writes to its access log. In normal use the
// service worker answers the navigation from the precache and it never
// reaches the network - but a worker that is updating, evicted, unregistered
// or bypassed by a hard reload lets it out, and then one operator's log holds
// another mint's note secrets. The wallet is not necessarily served by the
// mint that issued what you are holding.
//
// So the payload travels in a POST body instead, where there is nothing to
// log, nothing to land in history and nothing to leak through a referrer.
//
// This worker stays deliberately ignorant of what a note looks like. It
// stashes the three raw share fields and redirects to the plain root; the
// page decides what was shared, using the same code that reads the GET
// fallback. Two copies of "which field has the money in it" would drift.
//
// Imported at the top of the generated Workbox worker, so this fetch
// listener registers before Workbox's navigation route and gets first
// refusal on the POST.

const SHARE_CACHE = 'notecase-pending-share'
const SHARE_STASH = '/__notecase_pending_share__'

self.addEventListener('fetch', event => {
  const request = event.request
  if (request.method !== 'POST') return

  let url
  try {
    url = new URL(request.url)
  } catch {
    return
  }
  if (url.origin !== self.location.origin || url.pathname !== '/share') return

  event.respondWith(
    (async () => {
      // Whatever happens, land the user on a clean root rather than on a
      // page that failed. Losing a share is a nuisance; showing them a
      // broken app while holding their note is worse.
      try {
        const form = await request.formData()
        const payload = {
          title: form.get('title'),
          text: form.get('text'),
          url: form.get('url'),
        }
        const cache = await caches.open(SHARE_CACHE)
        await cache.put(
          SHARE_STASH,
          new Response(JSON.stringify(payload), {
            headers: { 'content-type': 'application/json' },
          }),
        )
      } catch {
        // fall through to the redirect: nothing stashed, nothing shown
      }
      // Absolute, resolved against the worker's own location: the spec
      // wants a valid URL here, and relying on a relative one to resolve
      // against an implicit base is how this breaks under a different
      // scope. 303 so the browser turns the POST into a GET.
      return Response.redirect(new URL('/', self.location.href).href, 303)
    })(),
  )
})
