import {createPinnedFetch} from 'farrier-kit/node'

// The fetch every wire call goes through. Public hostnames get farrier's
// DNS-pinned fetch, which resolves once, rejects any private or reserved
// answer, and pins the socket to the approved address - closing the
// rebinding window a check-then-fetch guard leaves open. Loopback literals
// pass straight to global fetch: lnurlcash-kit already restricts http to
// loopback and .onion, and a literal cannot rebind.
//
// NOTECASE_ALLOW_PRIVATE=1 lets LAN-hosted mints through, for people who
// run their own - it is not the default posture.

const isLoopbackLiteral = (hostname: string): boolean =>
  hostname === 'localhost' ||
  hostname === '::1' ||
  hostname === '[::1]' ||
  /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)

export const createWalletFetch = (options: {allowPrivate?: boolean} = {}): typeof globalThis.fetch => {
  const allowPrivate = options.allowPrivate ?? process.env.NOTECASE_ALLOW_PRIVATE === '1'
  const pinned = createPinnedFetch(allowPrivate ? {allowPrivate: true} : {})
  return async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url)
    if (isLoopbackLiteral(url.hostname) || url.hostname.endsWith('.onion')) {
      return globalThis.fetch(input, init)
    }
    return pinned(url.toString(), init)
  }
}
