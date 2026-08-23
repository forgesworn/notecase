import {describe, expect, it} from 'vitest'
import {VaultError} from '../src/vault.ts'
import {frame, openConnection, NOTE_NACK, NOTE_RESP, type PortLike} from '../web/src/vaultserial.ts'

// What happens on the cable when the device answers, refuses, or says
// nothing. These three are not the same thing, and a client that renders
// them the same sends its owner hunting for a fault that is not there.

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))

// A port whose device is a function: it sees each command and decides what
// bytes come back.
const fakePort = (answer: (command: Record<string, unknown>) => Uint8Array | null): PortLike => {
  let push: ((bytes: Uint8Array) => void) | null = null
  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      push = bytes => controller.enqueue(bytes)
    }
  })
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      // strip the HW header to read the JSON the client sent
      const text = new TextDecoder().decode(chunk.subarray(5, chunk.length - 4))
      const reply = answer(JSON.parse(text) as Record<string, unknown>)
      if (reply) push?.(reply)
    }
  })
  return {
    readable,
    writable,
    open: async () => {},
    close: async () => {}
  }
}

describe('the device on the other end', () => {
  it('answers a command', async () => {
    const connection = openConnection(fakePort(() => frame(encode({ok: true, note_count: 2}), NOTE_RESP)))
    connection.speak('frame')
    await expect(connection.transport.request({cmd: 'get_info'}, 1_000)).resolves.toMatchObject({
      ok: true,
      note_count: 2
    })
    connection.transport.close()
  })

  it('says the vault is locked rather than hanging', async () => {
    // The real firmware: get_info answers, everything else NACKs "locked".
    // A client that drops the NACK waits out its whole timeout and then
    // reports silence - for a device sitting right there, talking.
    const connection = openConnection(
      fakePort(command =>
        command.cmd === 'get_info'
          ? frame(encode({ok: true, note_count: 3}), NOTE_RESP)
          : frame(new TextEncoder().encode('locked'), NOTE_NACK)
      )
    )
    connection.speak('frame')
    await expect(connection.transport.request({cmd: 'get_info'}, 1_000)).resolves.toMatchObject({ok: true})

    const refused = connection.transport.request({cmd: 'list_notes'}, 30_000)
    await expect(refused).rejects.toThrow(VaultError)
    await expect(refused).rejects.toThrow(/locked/)
    await expect(refused).rejects.toMatchObject({code: 'locked'})
    connection.transport.close()
  })

  it('explains a build that serves its notes over a relay instead', async () => {
    // That one NACKs the note frame outright, with no reason attached.
    const connection = openConnection(fakePort(() => frame(new Uint8Array(0), NOTE_NACK)))
    connection.speak('frame')
    const refused = connection.transport.request({cmd: 'get_info'}, 1_000)
    await expect(refused).rejects.toMatchObject({code: 'unsupported'})
    await expect(refused).rejects.toThrow(/pair it as a signer/)
    connection.transport.close()
  })

  it('times out only when nothing comes back at all', async () => {
    const connection = openConnection(fakePort(() => null))
    connection.speak('frame')
    await expect(connection.transport.request({cmd: 'get_info'}, 200)).rejects.toMatchObject({
      code: 'timeout'
    })
    connection.transport.close()
  })

  it('tells a long wait apart from a short one, because one means a button', async () => {
    const connection = openConnection(fakePort(() => null))
    connection.speak('frame')
    await expect(connection.transport.request({cmd: 'get_info'}, 200)).rejects.toThrow(
      /^The vault did not answer\.$/
    )
    connection.transport.close()
  })
})
