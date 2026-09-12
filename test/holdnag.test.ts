import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {holdNagger} from '../src/holdnag.ts'

describe('waiting for a hold', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  const harness = () => {
    const lines: string[] = []
    const bells = {count: 0}
    const nag = holdNagger({
      log: line => lines.push(line.trim()),
      bell: () => {
        bells.count += 1
      },
      everyMs: 8_000
    })
    return {lines, bells, nag}
  }

  it('says the ask again, with the bell, until the step changes', () => {
    const {lines, bells, nag} = harness()
    nag.step('hold the device button to release aaaa1111')
    expect(bells.count).toBe(1)
    vi.advanceTimersByTime(16_000)
    expect(lines.filter(l => l.startsWith('still waiting'))).toHaveLength(2)
    expect(lines.at(-1)).toContain('release aaaa1111')
    expect(bells.count).toBe(3)

    // The next step ends it, and a step that asks for nothing never nags.
    nag.step('writing aaaa1111 off on the device')
    vi.advanceTimersByTime(30_000)
    expect(lines.filter(l => l.startsWith('still waiting'))).toHaveLength(2)
    expect(bells.count).toBe(3)
  })

  it('stops when the call returns', () => {
    const {lines, nag} = harness()
    nag.step('hold the device button to send')
    nag.stop()
    vi.advanceTimersByTime(30_000)
    expect(lines.filter(l => l.startsWith('still waiting'))).toHaveLength(0)
  })
})
