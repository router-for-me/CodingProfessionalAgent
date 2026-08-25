import { describe, expect, it } from 'vitest'
import { formatElapsed } from './formatElapsed.js'

describe('formatElapsed', () => {
  it('formats durations precisely', () => {
    expect(formatElapsed(29_000)).toBe('29s')
    expect(formatElapsed(65_000)).toBe('1m 5s')
    expect(formatElapsed(196_000)).toBe('3m 16s')
    expect(formatElapsed(3_726_000)).toBe('1h 2m 6s')
    // 1 hour 21 minutes 23 seconds
    expect(formatElapsed((1 * 3600 + 21 * 60 + 23) * 1000)).toBe('1h 21m 23s')
    // 12 years 2 months 21 days 1 hour 21 minutes 23 seconds
    const longDurationSec = ((12 * 365 + 2 * 30 + 21) * 24 + 1) * 3600 + 21 * 60 + 23
    expect(formatElapsed(longDurationSec * 1000)).toBe('12y 2mo 21d 1h 21m 23s')
  })

  it('formats English units', () => {
    expect(formatElapsed(29_000, 'en')).toBe('29s')
    expect(formatElapsed(196_000, 'en-US')).toBe('3m 16s')
    expect(formatElapsed(3_726_000, 'en')).toBe('1h 2m 6s')
    // 1 hour 21 minutes 23 seconds
    expect(formatElapsed((1 * 3600 + 21 * 60 + 23) * 1000, 'en')).toBe('1h 21m 23s')
    // 12 years 2 months 21 days 1 hour 21 minutes 23 seconds
    const longDurationSec = ((12 * 365 + 2 * 30 + 21) * 24 + 1) * 3600 + 21 * 60 + 23
    expect(formatElapsed(longDurationSec * 1000, 'en')).toBe('12y 2mo 21d 1h 21m 23s')
  })

  it('handles zero seconds when scaled up', () => {
    expect(formatElapsed(60_000)).toBe('1m 0s')
    expect(formatElapsed(3_600_000)).toBe('1h 0m 0s')
    expect(formatElapsed((3600 + 23) * 1000)).toBe('1h 0m 23s')
  })

  it('clamps negative values', () => {
    expect(formatElapsed(-10, 'en')).toBe('0s')
  })
})
