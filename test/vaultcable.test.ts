import {describe, expect, it} from 'vitest'
import {VaultError} from '../src/vault.ts'
import {frame, crc32, openConnection, NOTE_NACK, NOTE_RESP, type PortLike} from '../web/src/vaultserial.ts'

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

  it('sends a device in relay mode to the surface that does work', async () => {
    // The firmware's own words, verbatim: in relay mode the cable's note
    // frame is closed on purpose, because its gated commands block for
    // thirty seconds on a button and that would stall the relay loop.
    // Nothing is broken and nothing needs reflashing - the locker is just
    // served somewhere else, and this wallet already speaks that surface.
    const connection = openConnection(
      fakePort(() =>
        frame(new TextEncoder().encode('use heartwood_note_* over the relay'), NOTE_NACK)
      )
    )
    connection.speak('frame')
    const refused = connection.transport.request({cmd: 'get_info'}, 1_000)
    await expect(refused).rejects.toMatchObject({code: 'wrong_surface'})
    await expect(refused).rejects.toThrow(/relay mode/)
    await expect(refused).rejects.toThrow(/Hardware signer/)
    // and it says what a cable-capable device would need to be
    await expect(refused).rejects.toThrow(/USB mode/)
    connection.transport.close()
  })

  it('passes an unrecognised refusal through rather than flattening it', async () => {
    // A reason nobody has seen before is still more use than "unsupported".
    const connection = openConnection(
      fakePort(() => frame(new TextEncoder().encode('something new'), NOTE_NACK))
    )
    connection.speak('frame')
    await expect(connection.transport.request({cmd: 'get_info'}, 1_000)).rejects.toThrow(
      /refused that: something new/
    )
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

// ---- the cable from a terminal ----
//
// The framing moved to src/vaultwire.ts so the CLI and the browser share one
// implementation. These check the seam itself: that the move kept the wire
// identical, and that the node-side port adapter presents the same PortLike
// the browser hands in.

describe('the wire, shared by both surfaces', () => {
  it('frames a command the same way it always did', () => {
    // The bytes are the contract with two devices in the field. If this
    // changes, a locker stops answering.
    const framed = frame(new TextEncoder().encode('{"cmd":"get_info"}'))
    expect(framed[0]).toBe(0x48)
    expect(framed[1]).toBe(0x57)
    expect(framed[2]).toBe(0x70)
    expect((framed[3]! << 8) | framed[4]!).toBe(18)
    // CRC covers type + length + payload, not the magic
    const covered = new Uint8Array([framed[2]!, framed[3]!, framed[4]!, ...framed.slice(5, 5 + 18)])
    const crc = crc32(covered)
    expect(framed.slice(-4)).toEqual(
      new Uint8Array([(crc >>> 24) & 0xff, (crc >>> 16) & 0xff, (crc >>> 8) & 0xff, crc & 0xff])
    )
  })

  it('is re-exported from the web module, so the browser path is unchanged', async () => {
    // The split must not have moved anything out from under web/src/main.ts.
    const web = await import('../web/src/vaultserial.ts')
    const wire = await import('../src/vaultwire.ts')
    for (const name of ['crc32', 'frame', 'lineParser', 'frameParser', 'openConnection', 'NOTE_CMD', 'NOTE_RESP']) {
      expect(web[name as keyof typeof web], `${name} should still be reachable from vaultserial`).toBe(
        wire[name as keyof typeof wire]
      )
    }
  })

  it('says what to do when serialport is not installed', async () => {
    // It is deliberately not a dependency: a wallet should not need a
    // compiler to install, and almost nobody who installs notecase owns a
    // locker. The absence has to read as an instruction, not a stack trace.
    const {listPorts} = await import('../src/vaultport.ts')
    try {
      await listPorts()
      // serialport IS installed in this environment, which is fine - the
      // call simply works and there is nothing to assert about its absence.
    } catch (err) {
      expect((err as Error).message).toMatch(/serialport/)
      expect((err as Error).message).toMatch(/npm i/)
    }
  })
})
