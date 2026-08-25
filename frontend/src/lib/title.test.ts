import { describe, expect, it } from 'vitest'
import { deriveSessionTitle } from './title'

describe('deriveSessionTitle', () => {
  it('uses default for empty content', () => {
    expect(deriveSessionTitle('', 'zh-CN')).toBe('New chat')
  })

  it('uses default for empty content in en', () => {
    expect(deriveSessionTitle('   ', 'en')).toBe('New chat')
  })

  it('truncates long content with ellipsis', () => {
    const long = 'A'.repeat(80)
    const title = deriveSessionTitle(long, 'en')
    expect(title.endsWith('…')).toBe(true)
    expect(title.length).toBeLessThanOrEqual(41)
  })

  it('keeps short content', () => {
    expect(deriveSessionTitle('Fix login bug', 'en')).toBe('Fix login bug')
  })
})
