import {createPinnedFetch} from 'farrier-kit/node'
import {parseProxy, socks5Connect} from './proxy.ts'

// The fetch every wire call goes through. Public hostnames get farrier's
// DNS-pinned fetch, which resolves once, rejects any private or reserved
// answer, and pins the socket to the approved address - closing the
// rebinding window a check-then-fetch guard leaves open. Loopback literals
// pass straight to global fetch: lnurlcash-kit already restricts http to
// loopback and .onion, and a literal cannot rebind.
//
// NOTECASE_ALLOW_PRIVATE=1 lets LAN-hosted mints through, for people who
// run their own - it is not the default posture.
//
// NOTECASE_PROXY=socks5://127.0.0.1:9050 sends every call through a SOCKS5
// proxy instead, which is how this talks to Tor. That deliberately turns
// the DNS pinning OFF: pinning resolves the mint's hostname on this
// machine, and a wallet that has told its resolver which mint it banks
// with has already given away the thing Tor was for. Through the proxy the
// name is resolved at the far end and never leaves in the clear. The guard
// that is given up with it is the rebinding one, and the honest reading is
// that it is a swap, not an upgrade: see the README.

const isLoopbackLiteral = (hostname: string): boolean =>
  hostname === 'localhost' ||
  hostname === '::1' ||
  hostname === '[::1]' ||
  /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)

// One dispatcher per proxy, built the first time something is fetched, so
// nothing is loaded or connected for a wallet that never sets the variable.
const proxiedFetch = (proxy: string): typeof globalThis.fetch => {
  const spec = parseProxy(proxy)
  let dispatcher: Promise<unknown> | null = null
  const build = async (): Promise<unknown> => {
    const {Agent, buildConnector} = (await import('undici')) as unknown as {
      Agent: new (options: Record<string, unknown>) => unknown
      buildConnector: (options: Record<string, unknown>) => (
        options: Record<string, unknown>,
        callback: (err: Error | null, socket: unknown) => void
      ) => void
    }
    const upgrade = buildConnector({})
    return new Agent({
      connect: (options: Record<string, unknown>, callback: (err: Error | null, socket: unknown) => void) => {
        const host = String(options.hostname ?? '')
        const secure = String(options.protocol ?? '') === 'https:'
        const port = Number(options.port) || (secure ? 443 : 80)
        socks5Connect(spec, host, port).then(
          socket => {
            // http rides the tunnel as it is; https is upgraded over it,
            // so the certificate is checked here and not at the proxy
            if (!secure) return callback(null, socket)
            upgrade({...options, httpSocket: socket}, callback)
          },
          (err: Error) => callback(err, null)
        )
      }
    })
  }
  return async (input, init) => {
    const {fetch: throughProxy} = (await import('undici')) as unknown as {
      fetch: (input: string, init: Record<string, unknown>) => Promise<Response>
    }
    dispatcher ??= build()
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    return throughProxy(url, {...(init as Record<string, unknown>), dispatcher: await dispatcher})
  }
}

export const createWalletFetch = (
  options: {allowPrivate?: boolean; proxy?: string} = {}
): typeof globalThis.fetch => {
  // process may not exist in a browser bundle - the env vars are a Node nicety
  const proxy = options.proxy ?? (typeof process !== 'undefined' ? process.env?.NOTECASE_PROXY : undefined)
  if (proxy) return proxiedFetch(proxy)
  const allowPrivate =
    options.allowPrivate ?? (typeof process !== 'undefined' && process.env?.NOTECASE_ALLOW_PRIVATE === '1')
  const pinned = createPinnedFetch(allowPrivate ? {allowPrivate: true} : {})
  return async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url)
    if (isLoopbackLiteral(url.hostname) || url.hostname.endsWith('.onion')) {
      return globalThis.fetch(input, init)
    }
    return pinned(url.toString(), init)
  }
}
