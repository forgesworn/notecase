import {connect as netConnect, type Socket} from 'node:net'

// A SOCKS5 client, so NOTECASE_PROXY can point at Tor.
//
// The hostname is sent to the proxy as a NAME, never resolved here. That
// is the whole point: a wallet that looks a mint up in DNS has told its
// resolver, and its resolver's operator, which mint it banks with before
// a single byte of the request goes anywhere. socks5h semantics, in the
// curl spelling, and the only semantics worth having.

const NO_AUTH = 0x00
const USER_PASS = 0x02

type Reader = {read: (bytes: number) => Promise<Buffer>; done: () => void}

// Reads exact byte counts off a socket without losing what arrived early.
const bufferedReader = (socket: Socket): Reader => {
  let held = Buffer.alloc(0)
  let want: {bytes: number; resolve: (value: Buffer) => void; reject: (err: Error) => void} | null = null
  const settle = (): void => {
    if (!want || held.length < want.bytes) return
    const taken = held.subarray(0, want.bytes)
    held = held.subarray(want.bytes)
    const pending = want
    want = null
    pending.resolve(taken)
  }
  const fail = (err: Error): void => {
    const pending = want
    want = null
    pending?.reject(err)
  }
  const onData = (chunk: Buffer): void => {
    held = Buffer.concat([held, chunk])
    settle()
  }
  const onEnd = (): void => fail(new Error('the proxy closed the connection'))
  const onError = (err: Error): void => fail(err)
  socket.on('data', onData)
  socket.on('end', onEnd)
  socket.on('error', onError)
  return {
    read: (bytes: number) =>
      new Promise<Buffer>((resolve, reject) => {
        want = {bytes, resolve, reject}
        settle()
      }),
    done: () => {
      socket.off('data', onData)
      socket.off('end', onEnd)
      socket.off('error', onError)
      // whatever arrived while the handshake finished is the tunnel's
      if (held.length) socket.unshift(held)
    }
  }
}

const FAILURES: Record<number, string> = {
  1: 'the proxy failed',
  2: 'the proxy refused this connection by its own rules',
  3: 'the network is unreachable from the proxy',
  4: 'the host is unreachable from the proxy',
  5: 'the connection was refused',
  6: 'the connection timed out at the proxy',
  7: 'the proxy does not support this command',
  8: 'the proxy does not support this address type'
}

export type ProxySpec = {host: string; port: number; username?: string; password?: string}

export const parseProxy = (value: string): ProxySpec => {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`NOTECASE_PROXY is not a URL: ${value}`)
  }
  if (!/^socks5h?:$/.test(url.protocol)) {
    throw new Error(`NOTECASE_PROXY must be a socks5:// URL, not ${url.protocol}//`)
  }
  const port = Number(url.port || 1080)
  if (!url.hostname || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`NOTECASE_PROXY needs a host and port: ${value}`)
  }
  return {
    host: url.hostname,
    port,
    ...(url.username ? {username: decodeURIComponent(url.username)} : {}),
    ...(url.password ? {password: decodeURIComponent(url.password)} : {})
  }
}

// Opens a tunnel to host:port through the proxy and hands back the socket
// with the handshake consumed, ready for HTTP or a TLS upgrade.
export const socks5Connect = async (proxy: ProxySpec, host: string, port: number): Promise<Socket> => {
  const socket = netConnect({host: proxy.host, port: proxy.port})
  socket.setNoDelay(true)
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve)
    socket.once('error', reject)
  })
  const reader = bufferedReader(socket)
  const fail = (message: string): never => {
    socket.destroy()
    throw new Error(message)
  }
  try {
    const offered = proxy.username ? [NO_AUTH, USER_PASS] : [NO_AUTH]
    socket.write(Buffer.from([0x05, offered.length, ...offered]))
    const greeting = await reader.read(2)
    if (greeting[0] !== 0x05) fail('that is not a SOCKS5 proxy')
    if (greeting[1] === 0xff) fail('the proxy accepts none of the authentication this offers')
    if (greeting[1] === USER_PASS) {
      const user = Buffer.from(proxy.username ?? '', 'utf8')
      const pass = Buffer.from(proxy.password ?? '', 'utf8')
      socket.write(Buffer.concat([Buffer.from([0x01, user.length]), user, Buffer.from([pass.length]), pass]))
      const answer = await reader.read(2)
      if (answer[1] !== 0x00) fail('the proxy rejected the username and password')
    } else if (greeting[1] !== NO_AUTH) {
      fail('the proxy asked for an authentication method this does not do')
    }

    // The hostname goes as a NAME. Never resolved here.
    const name = Buffer.from(host, 'utf8')
    if (name.length > 255) fail('that hostname is too long for SOCKS5')
    const request = Buffer.concat([
      Buffer.from([0x05, 0x01, 0x00, 0x03, name.length]),
      name,
      Buffer.from([(port >> 8) & 0xff, port & 0xff])
    ])
    socket.write(request)

    const head = await reader.read(4)
    if (head[1] !== 0x00) fail(FAILURES[head[1] ?? 1] ?? 'the proxy refused the connection')
    const type = head[3]
    const addressBytes = type === 0x01 ? 4 : type === 0x04 ? 16 : 1 + ((await reader.read(1))[0] ?? 0)
    await reader.read(type === 0x03 ? addressBytes - 1 : addressBytes)
    await reader.read(2)
    reader.done()
    return socket
  } catch (err) {
    socket.destroy()
    throw err
  }
}
