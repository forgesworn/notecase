import {describe, expect, it} from 'vitest'
import {crc32, frame, frameParser, lineParser, NOTE_RESP} from '../web/src/vaultserial.ts'

// The cable, byte by byte.
//
// Serial hands over whatever happened to be in the buffer: a reply can
// arrive in six chunks, or share one with the next, or follow a line of
// boot chatter nobody asked for. None of that is exotic - it is what a USB
// stream normally does - and all of it lands on money, because the message
// being reassembled says whether a note was confirmed.

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))
const reply = (value: unknown) => frame(encode(value), NOTE_RESP)

describe('the heartwood frame', () => {
  it('computes the CRC the firmware computes', () => {
    // the standard check value for CRC-32/IEEE, which is what
    // crc32fast on the device produces
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926)
  })

  it('round-trips a command through the wire format', () => {
    const bytes = reply({ok: true, note_count: 3})
    expect(bytes[0]).toBe(0x48)
    expect(bytes[1]).toBe(0x57)
    expect(bytes[2]).toBe(0x71)
    const parser = frameParser()
    expect(parser.feed(bytes)).toEqual([JSON.stringify({ok: true, note_count: 3})])
  })

  it('reassembles a reply that arrives one byte at a time', () => {
    const bytes = reply({ok: true, k1: 'ab'.repeat(32)})
    const parser = frameParser()
    const out: string[] = []
    for (const byte of bytes) out.push(...parser.feed(new Uint8Array([byte])))
    expect(out).toHaveLength(1)
    expect(JSON.parse(out[0]!)).toMatchObject({ok: true})
  })

  it('reads two replies that shared one chunk', () => {
    const first = reply({ok: true, id: 'one'})
    const second = reply({ok: true, id: 'two'})
    const both = new Uint8Array(first.length + second.length)
    both.set(first)
    both.set(second, first.length)
    expect(frameParser().feed(both).map(text => JSON.parse(text).id)).toEqual(['one', 'two'])
  })

  it('resynchronises past junk rather than wedging for good', () => {
    // a boot banner on the same port, then a real frame
    const junk = new TextEncoder().encode('heartwood 0.0.7 starting\r\n')
    const good = reply({ok: true, id: 'after'})
    const stream = new Uint8Array(junk.length + good.length)
    stream.set(junk)
    stream.set(good, junk.length)
    expect(frameParser().feed(stream).map(text => JSON.parse(text).id)).toEqual(['after'])
  })

  it('drops a frame whose CRC does not hold', () => {
    // A corrupted reply about money must not be acted on. Dropping it
    // times the command out, which is retried; believing it is not.
    const bytes = reply({ok: true, id: 'tampered'})
    bytes[bytes.length - 1] = (bytes[bytes.length - 1]! ^ 0xff) & 0xff
    const parser = frameParser()
    expect(parser.feed(bytes)).toEqual([])
    // and the stream is still usable afterwards
    expect(parser.feed(reply({ok: true, id: 'next'})).map(text => JSON.parse(text).id)).toEqual(['next'])
  })

  it('ignores a frame that is not a note response', () => {
    // 0x15 is the firmware's NACK: a real frame, not an answer to this.
    expect(frameParser().feed(frame(encode({ok: false}), 0x15))).toEqual([])
  })
})

describe('the newline framing', () => {
  it('reads one object per line, however the chunks fall', () => {
    const parser = lineParser()
    expect(parser.feed(new TextEncoder().encode('{"ok":true,"a":'))).toEqual([])
    expect(parser.feed(new TextEncoder().encode('1}\n{"ok":true,"a":2}\n'))).toEqual([
      '{"ok":true,"a":1}',
      '{"ok":true,"a":2}'
    ])
  })

  it('skips blank lines rather than answering with one', () => {
    expect(lineParser().feed(new TextEncoder().encode('\n\n{"ok":true}\n'))).toEqual(['{"ok":true}'])
  })
})
