import type {VaultTransport} from '../../src/vault.ts'
import {VaultError} from '../../src/vault.ts'

// The cable.
//
// Two devices answer the same lnurl-vault command protocol over USB and
// wrap it differently, so the framing is the only thing that differs here:
//
//   - lnurl-vault: newline-delimited JSON. One command object per line in,
//     one response object per line out.
//   - heartwood-esp32: a binary frame, because its serial surface is shared
//     with signing traffic and has to be self-delimiting:
//       [0x48 0x57] [type u8] [length u16 BE] [payload] [crc32 u32 BE]
//     with 0x70 out and 0x71 back. The CRC covers type + length + payload,
//     not the magic.
//
// Which one is on the end of the cable is not something to ask a person -
// they plugged in a vault, not a framing. connectVault tries the framed
// one first, because a device that answers a frame with a correct CRC has
// identified itself beyond doubt, and falls back to lines.

const MAGIC = [0x48, 0x57] as const
const NOTE_CMD = 0x70
export const NOTE_RESP = 0x71
const HEADER = 5
const PROBE_MS = 2_000

export const serialSupported = (): boolean =>
  typeof navigator !== 'undefined' && 'serial' in navigator

const crcTable = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1
    table[index] = value >>> 0
  }
  return table
})()

// Exported because framing is a protocol surface, not an implementation
// detail: it is what a corrupted reply about money has to be caught by,
// and a BLE transport would reuse the same parsers.
export const crc32 = (bytes: Uint8Array): number => {
  let crc = 0xffffffff
  for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff]!
  return (crc ^ 0xffffffff) >>> 0
}

export const frame = (payload: Uint8Array, type: number = NOTE_CMD): Uint8Array => {
  const out = new Uint8Array(HEADER + payload.length + 4)
  out[0] = MAGIC[0]
  out[1] = MAGIC[1]
  out[2] = type
  out[3] = (payload.length >> 8) & 0xff
  out[4] = payload.length & 0xff
  out.set(payload, HEADER)
  const covered = new Uint8Array(3 + payload.length)
  covered[0] = type
  covered[1] = out[3]!
  covered[2] = out[4]!
  covered.set(payload, 3)
  const crc = crc32(covered)
  out[HEADER + payload.length] = (crc >>> 24) & 0xff
  out[HEADER + payload.length + 1] = (crc >>> 16) & 0xff
  out[HEADER + payload.length + 2] = (crc >>> 8) & 0xff
  out[HEADER + payload.length + 3] = crc & 0xff
  return out
}

// Pulls whole messages out of a byte stream. Serial gives no message
// boundaries of its own - a reply can arrive in six chunks or share one
// with the next - so both framings are parsed as "keep bytes until a
// complete message is in hand".
export type Parser = {feed(chunk: Uint8Array): string[]}

export const lineParser = (): Parser => {
  let buffer = ''
  const decoder = new TextDecoder()
  return {
    feed(chunk) {
      buffer += decoder.decode(chunk, {stream: true})
      const out: string[] = []
      for (;;) {
        const end = buffer.indexOf('\n')
        if (end < 0) return out
        const line = buffer.slice(0, end).trim()
        buffer = buffer.slice(end + 1)
        if (line) out.push(line)
      }
    }
  }
}

export const frameParser = (): Parser => {
  let buffer = new Uint8Array(0)
  const decoder = new TextDecoder()
  return {
    feed(chunk) {
      const joined = new Uint8Array(buffer.length + chunk.length)
      joined.set(buffer)
      joined.set(chunk, buffer.length)
      buffer = joined
      const out: string[] = []
      for (;;) {
        // Resynchronise on the magic rather than giving up: a device that
        // logs a line to the same port would otherwise wedge the stream
        // for good.
        let start = 0
        while (start + 1 < buffer.length && !(buffer[start] === MAGIC[0] && buffer[start + 1] === MAGIC[1])) {
          start += 1
        }
        if (start > 0) buffer = buffer.slice(start)
        if (buffer.length < HEADER) return out
        const length = (buffer[3]! << 8) | buffer[4]!
        if (buffer.length < HEADER + length + 4) return out
        const type = buffer[2]!
        const payload = buffer.subarray(HEADER, HEADER + length)
        const covered = new Uint8Array(3 + length)
        covered[0] = type
        covered[1] = buffer[3]!
        covered[2] = buffer[4]!
        covered.set(payload, 3)
        const declared =
          ((buffer[HEADER + length]! << 24) |
            (buffer[HEADER + length + 1]! << 16) |
            (buffer[HEADER + length + 2]! << 8) |
            buffer[HEADER + length + 3]!) >>>
          0
        const text = decoder.decode(payload)
        buffer = buffer.slice(HEADER + length + 4)
        // A frame whose CRC does not hold is a frame that did not arrive.
        // Dropping it is right: the command times out and is retried, which
        // is far better than acting on a corrupted response about money.
        if (declared !== crc32(covered)) continue
        if (type === NOTE_RESP) out.push(text)
      }
    }
  }
}

type PortLike = {
  readable: ReadableStream<Uint8Array> | null
  writable: WritableStream<Uint8Array> | null
  open(options: {baudRate: number}): Promise<void>
  close(): Promise<void>
}

// One command in flight at a time, which is what the protocol is: every
// command gets exactly one response, and the device answers in order.
//
// The reader and writer are taken once and kept for the life of the
// connection. Only the parser is swappable, because working out which
// framing a device speaks means asking it the same question twice - and a
// port whose reader has been cancelled cannot be asked anything again.
const openConnection = (port: PortLike) => {
  const encoder = new TextEncoder()
  const waiting: Array<(message: string) => void> = []
  const reader = port.readable!.getReader()
  const writer = port.writable!.getWriter()
  let parser: Parser = frameParser()
  let framing: 'frame' | 'line' = 'frame'
  let closed = false

  const pump = (async () => {
    try {
      for (;;) {
        const {value, done} = await reader.read()
        if (done) return
        if (!value) continue
        for (const message of parser.feed(value)) waiting.shift()?.(message)
      }
    } catch {
      // the cable went away; anything pending times out on its own
    }
  })()

  const transport: VaultTransport = {
    async request(command, timeoutMs) {
      if (closed) throw new VaultError('unsupported', 'The vault is not connected.')
      const answer = new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          const index = waiting.indexOf(settle)
          if (index >= 0) waiting.splice(index, 1)
          reject(
            new VaultError(
              'timeout',
              timeoutMs > 30_000
                ? 'The vault did not answer. If it was waiting for a button, nobody pressed one.'
                : 'The vault did not answer.'
            )
          )
        }, timeoutMs)
        const settle = (message: string) => {
          clearTimeout(timer)
          resolve(message)
        }
        waiting.push(settle)
      })
      const json = JSON.stringify(command)
      await writer.write(framing === 'frame' ? frame(encoder.encode(json)) : encoder.encode(`${json}\n`))
      const text = await answer
      try {
        return JSON.parse(text) as Record<string, unknown>
      } catch {
        throw new VaultError('bad_request', 'The vault answered with something that is not JSON.')
      }
    },
    close() {
      if (closed) return
      closed = true
      void reader.cancel().catch(() => {})
      void writer.close().catch(() => {})
      void pump.then(() => port.close().catch(() => {}))
    }
  }

  return {
    transport,
    speak(next: 'frame' | 'line') {
      framing = next
      parser = next === 'frame' ? frameParser() : lineParser()
      waiting.splice(0)
    }
  }
}

// Asks for a port, opens it, and works out which framing the thing on the
// end speaks by asking it what it is.
export const connectVault = async (): Promise<{transport: VaultTransport; framing: 'frame' | 'line'}> => {
  if (!serialSupported()) {
    throw new VaultError(
      'unsupported',
      'This browser has no Web Serial. Chrome or Edge on a desktop can talk to a vault over USB; Safari and Firefox cannot.'
    )
  }
  const serial = (navigator as unknown as {serial: {requestPort(): Promise<PortLike>}}).serial
  const port = await serial.requestPort()
  await port.open({baudRate: 115_200})
  const connection = openConnection(port)

  for (const framing of ['frame', 'line'] as const) {
    connection.speak(framing)
    try {
      const reply = await connection.transport.request({cmd: 'get_info'}, PROBE_MS)
      if (reply.ok === true) return {transport: connection.transport, framing}
    } catch {
      // not this framing, or not answering at all
    }
  }
  connection.transport.close()
  throw new VaultError(
    'timeout',
    'Something is on that port but it does not answer as a vault. Check it is powered, unlocked, and not busy with another tab.'
  )
}
