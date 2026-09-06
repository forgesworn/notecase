// The same cable, from a terminal.
//
// `vaultwire.ts` is the protocol and takes a `PortLike` — WHATWG streams, the
// shape Web Serial hands out. This adapts a node-serialport to it, so the CLI
// and the browser drive a locker through one implementation of the wire rather
// than two that drift.
//
// `serialport` is a native module and is NOT a dependency of this package. A
// wallet should not need a compiler to install, and almost nobody who installs
// notecase owns a hardware locker. It is imported only when someone actually
// asks for the cable, and its absence is a plain instruction rather than a
// stack trace.

import type {PortLike} from './vaultwire.ts'
import {openConnection} from './vaultwire.ts'
import type {VaultTransport} from './vault.ts'
import {VaultError} from './vault.ts'

/** What a candidate device looks like to `notecase device ports`. */
export type PortInfo = {
  path: string
  /** USB manufacturer string where the OS knows one. */
  manufacturer?: string
  /** Serial number, which on an ESP32-S3 native-USB board is its MAC. */
  serialNumber?: string
}

// Espressif's USB vendor id. Both boards this speaks to are ESP32-class: an
// lnurl-vault and a heartwood both enumerate under it, whether through the
// chip's native USB or a CP2102 bridge (Silicon Labs, 0x10c4).
const USB_VENDORS = new Set(['303a', '10c4'])

type SerialPortModule = {
  SerialPort: {
    new (options: {path: string; baudRate: number; autoOpen: boolean}): NodeSerialPort
    list(): Promise<Array<Record<string, string | undefined>>>
  }
}

type NodeSerialPort = {
  open(cb: (err: Error | null) => void): void
  close(cb: (err: Error | null) => void): void
  write(data: Uint8Array, cb: (err: Error | null | undefined) => void): boolean
  on(event: 'data', cb: (chunk: Buffer) => void): void
  on(event: 'error', cb: (err: Error) => void): void
  removeAllListeners(): void
}

const loadSerialPort = async (): Promise<SerialPortModule> => {
  try {
    // Not a static import and not typed against the package: `serialport` is
    // deliberately absent from package.json, so a bare `import` would fail to
    // typecheck for everyone who builds this without it installed.
    const name = 'serialport'
    return (await import(/* @vite-ignore */ name)) as unknown as SerialPortModule
  } catch {
    throw new VaultError(
      'no_serial',
      'Talking to a locker over the cable needs the `serialport` package, which notecase does not install for you (it is a native module, and most wallets never touch a cable). Run `npm i -g serialport` and try again.'
    )
  }
}

/**
 * Attached devices that could be a locker.
 *
 * Filtered by USB vendor rather than listed raw: on a Mac the raw list is
 * mostly Bluetooth and debug nodes, and picking the wrong one means a command
 * that hangs rather than one that fails.
 */
export const listPorts = async (): Promise<PortInfo[]> => {
  const {SerialPort} = await loadSerialPort()
  const ports = await SerialPort.list()
  return ports
    .filter(p => USB_VENDORS.has((p['vendorId'] ?? '').toLowerCase()))
    .map(p => ({
      path: p['path'] ?? '',
      ...(p['manufacturer'] ? {manufacturer: p['manufacturer']} : {}),
      ...(p['serialNumber'] ? {serialNumber: p['serialNumber']} : {})
    }))
    .filter(p => p.path !== '')
}

/**
 * Open one, as a `PortLike`.
 *
 * The streams are built by hand rather than taken from node's own Web Streams
 * adapter: `openConnection` takes a reader for the life of the connection and
 * expects `close()` to end it, and node-serialport's stream semantics do not
 * line up with that without a wrapper this small anyway.
 */
export const openPort = async (path: string): Promise<PortLike> => {
  const {SerialPort} = await loadSerialPort()
  const port = new SerialPort({path, baudRate: 115200, autoOpen: false})

  let push: ((chunk: Uint8Array) => void) | null = null
  let finish: (() => void) | null = null
  const pending: Uint8Array[] = []
  port.on('data', chunk => {
    const bytes = new Uint8Array(chunk)
    if (push) {
      const deliver = push
      push = null
      deliver(bytes)
    } else {
      pending.push(bytes)
    }
  })

  const readable = new ReadableStream<Uint8Array>({
    pull(controller) {
      const queued = pending.shift()
      if (queued) {
        controller.enqueue(queued)
        return
      }
      return new Promise<void>(resolve => {
        push = bytes => {
          controller.enqueue(bytes)
          resolve()
        }
        finish = () => {
          controller.close()
          resolve()
        }
      })
    }
  })

  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      return new Promise<void>((resolve, reject) => {
        port.write(chunk, err => (err ? reject(err) : resolve()))
      })
    }
  })

  return {
    readable,
    writable,
    async open() {
      await new Promise<void>((resolve, reject) => {
        port.open(err => (err ? reject(err) : resolve()))
      })
    },
    async close() {
      finish?.()
      port.removeAllListeners()
      await new Promise<void>(resolve => port.close(() => resolve()))
    }
  }
}

/**
 * The one candidate, or a refusal that says what to do.
 *
 * Guessing between two attached boards is how a command lands on the wrong
 * device, and on this protocol the wrong device may be holding somebody's
 * money. So more than one is an error asking for `--port`, never a coin toss.
 */
export const soleDevice = async (): Promise<string> => {
  const ports = await listPorts()
  if (ports.length === 1) return ports[0]!.path
  if (ports.length === 0) {
    throw new VaultError(
      'no_device',
      'No locker found. Check the cable, and that the device is powered and not held by another program.'
    )
  }
  const paths = ports.map(p => p.path).join(', ')
  throw new VaultError('ambiguous_device', `More than one candidate device: ${paths}. Name one with --port.`)
}

/**
 * Open a locker and work out which framing it speaks, the way the browser
 * does — the same probe order, for the same measured reason.
 *
 * Framed first is not a preference. A heartwood that receives newline JSON
 * stops answering framed commands for the rest of the session and only
 * reopening the port recovers it, while a vault that receives a frame is
 * poisoned until the next newline because it reads to one and resynchronises.
 * The unrecoverable failure has to be the one that cannot happen, so the
 * repairable probe goes second.
 */
export const connectCable = async (
  path: string,
  probeMs = 3_000
): Promise<{transport: VaultTransport; framing: 'frame' | 'line'; close(): Promise<void>}> => {
  const port = await openPort(path)
  await port.open({baudRate: 115200})
  const connection = openConnection(port)
  for (const framing of ['frame', 'line'] as const) {
    connection.speak(framing)
    // Twice before moving on, because a board that has just been unlocked is
    // still finishing its boot and one probe times out against a device that
    // is merely busy. Learned on the bench 2026-09-06: the timeout is cheap,
    // and the line probe behind it is not.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const reply = await connection.transport.request({cmd: 'get_info'}, probeMs)
        if (reply.ok === true) {
          return {transport: connection.transport, framing, close: () => port.close()}
        }
        // An answer that is not `ok` is still an answer: the device spoke this
        // framing and refused for its own reasons, which the caller should
        // see rather than have replaced by "nothing answered".
        return {transport: connection.transport, framing, close: () => port.close()}
      } catch {
        // try again, then the other framing
      }
    }
  }
  await port.close()
  throw new VaultError(
    'no_device',
    'Nothing answered on either framing. Check the device is unlocked, that nothing else holds the port, and that it is in USB mode rather than serving a relay.'
  )
}
