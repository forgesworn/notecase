import {createServer, connect as netConnect, type Server, type Socket} from 'node:net'
import {afterEach, describe, expect, it} from 'vitest'
import {createMockMint} from 'lnurlcash-conformance/mock-mint'
import {createWalletFetch} from '../src/fetchguard.ts'
import {parseProxy} from '../src/proxy.ts'
import {makeWallet, freshK1} from './helpers.ts'

// NOTECASE_PROXY, against a real SOCKS5 server. The point of the test is
// not that a socket opens - it is that the wallet's traffic goes THROUGH
// the proxy and that the mint's hostname is handed over as a name for the
// proxy to resolve, never looked up on this machine.

type Seen = {host: string; port: number}

const socksServer = async (): Promise<{url: string; seen: Seen[]; close: () => Promise<void>}> => {
  const seen: Seen[] = []
  const server: Server = createServer(client => {
    let stage: 'greeting' | 'request' | 'tunnel' = 'greeting'
    let held = Buffer.alloc(0)
    client.on('data', chunk => {
      if (stage === 'tunnel') return
      held = Buffer.concat([held, chunk])
      if (stage === 'greeting') {
        if (held.length < 2) return
        const methods = held[1]!
        if (held.length < 2 + methods) return
        held = held.subarray(2 + methods)
        client.write(Buffer.from([0x05, 0x00]))
        stage = 'request'
      }
      if (stage === 'request') {
        if (held.length < 5) return
        // domain names only: anything else means the client resolved it
        // itself, which is the failure this test exists to catch
        expect(held[3]).toBe(0x03)
        const length = held[4]!
        if (held.length < 5 + length + 2) return
        const host = held.subarray(5, 5 + length).toString('utf8')
        const port = held.readUInt16BE(5 + length)
        const rest = held.subarray(5 + length + 2)
        seen.push({host, port})
        const upstream: Socket = netConnect({host, port}, () => {
          client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))
          if (rest.length) upstream.write(rest)
          client.pipe(upstream)
          upstream.pipe(client)
        })
        upstream.on('error', () => client.destroy())
        stage = 'tunnel'
      }
    })
    client.on('error', () => {})
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return {
    url: `socks5://127.0.0.1:${port}`,
    seen,
    close: () => new Promise<void>(resolve => server.close(() => resolve()))
  }
}

let mint: Awaited<ReturnType<typeof createMockMint>> | null = null
let proxy: Awaited<ReturnType<typeof socksServer>> | null = null
afterEach(async () => {
  await mint?.close()
  await proxy?.close()
  mint = null
  proxy = null
})

describe('NOTECASE_PROXY', () => {
  it('reads a socks5 URL, and refuses anything that is not one', () => {
    expect(parseProxy('socks5://127.0.0.1:9050')).toEqual({host: '127.0.0.1', port: 9050})
    expect(parseProxy('socks5h://tor:9050')).toEqual({host: 'tor', port: 9050})
    expect(parseProxy('socks5://user:pass@127.0.0.1:1080')).toEqual({
      host: '127.0.0.1',
      port: 1080,
      username: 'user',
      password: 'pass'
    })
    // no port means the SOCKS default
    expect(parseProxy('socks5://127.0.0.1').port).toBe(1080)
    expect(() => parseProxy('http://127.0.0.1:8080')).toThrow('socks5://')
    expect(() => parseProxy('127.0.0.1:9050')).toThrow('not a URL')
  })

  it('routes every call to the mint through the proxy, by name', async () => {
    proxy = await socksServer()
    mint = await createMockMint()
    const host = new URL(mint.url).host
    const wallet = makeWallet({fetch: createWalletFetch({proxy: proxy.url})})

    const k1 = freshK1()
    mint.state.creditNote(k1, 21_000)
    const received = await wallet.wallet.receive(`${mint.url}/w?k1=${k1}&amount=21000`)

    expect(received.note.amountMsat).toBe(21_000)
    expect(wallet.wallet.balanceMsat()).toBe(21_000)
    // every call went through the tunnel - one of them, because the
    // connection is kept alive and the rotate reuses it
    expect(proxy.seen.length).toBeGreaterThanOrEqual(1)
    for (const call of proxy.seen) expect(`${call.host}:${call.port}`).toBe(host)
  })

  it('fails honestly when the proxy is not there', async () => {
    mint = await createMockMint()
    const wallet = makeWallet({fetch: createWalletFetch({proxy: 'socks5://127.0.0.1:1'})})
    const k1 = freshK1()
    mint.state.creditNote(k1, 21_000)
    await expect(wallet.wallet.receive(`${mint.url}/w?k1=${k1}&amount=21000`)).rejects.toThrow()
    expect(wallet.data.notes).toHaveLength(0)
  })
})
