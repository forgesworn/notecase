// Web Serial, and only Web Serial. The protocol itself lives in
// ../../src/vaultwire.ts so the CLI can speak it without a browser; this file
// is the half that needs `navigator`.
export * from '../../src/vaultwire.ts'
import {openConnection, PROBE_MS, type PortLike} from '../../src/vaultwire.ts'
import {VaultError} from '../../src/vault.ts'
import type {VaultTransport} from '../../src/vault.ts'

export const serialSupported = (): boolean =>
  typeof navigator !== 'undefined' && 'serial' in navigator


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
    } catch (err) {
      // A refusal is not a failure to find the device - it IS the device,
      // declining. Say what it said rather than reporting an empty port.
      if (err instanceof VaultError && err.code !== 'timeout') {
        connection.transport.close()
        throw err
      }
      // otherwise: not this framing, or nothing answering at all
    }
  }
  connection.transport.close()
  throw new VaultError(
    'timeout',
    'Something is on that port but it does not answer as a vault. Check it is powered, unlocked, and not busy with another tab.'
  )
}
