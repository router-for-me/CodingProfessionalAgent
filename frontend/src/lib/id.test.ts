import { describe, expect, it } from 'vitest'
import { createId } from './id'

describe('createId', () => {
  it('returns non-empty unique-ish ids', () => {
    const a = createId()
    const b = createId()
    expect(a.length).toBeGreaterThan(8)
    expect(a).not.toBe(b)
  })
})
