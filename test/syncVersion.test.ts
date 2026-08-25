import { describe, it, expect } from 'vitest'
import { parseVersionFromTag } from '../scripts/sync-version.js'

describe('parseVersionFromTag', () => {
  it('parses standard semver tag with v prefix', () => {
    expect(parseVersionFromTag('v1.2.3')).toBe('1.2.3')
    expect(parseVersionFromTag('v0.1.0')).toBe('0.1.0')
    expect(parseVersionFromTag('v2.0.0-beta.1')).toBe('2.0.0-beta.1')
  })

  it('parses semver tag without v prefix', () => {
    expect(parseVersionFromTag('1.2.3')).toBe('1.2.3')
    expect(parseVersionFromTag('1.0.0-rc.1')).toBe('1.0.0-rc.1')
  })

  it('parses full git ref for tag', () => {
    expect(parseVersionFromTag('refs/tags/v1.5.0')).toBe('1.5.0')
    expect(parseVersionFromTag('refs/tags/1.5.0')).toBe('1.5.0')
    expect(parseVersionFromTag('refs/tags/v2.1.0-alpha.2')).toBe('2.1.0-alpha.2')
  })

  it('returns null for branch refs and invalid strings', () => {
    expect(parseVersionFromTag('refs/heads/main')).toBeNull()
    expect(parseVersionFromTag('refs/heads/release/1.0')).toBeNull()
    expect(parseVersionFromTag('refs/pull/123/merge')).toBeNull()
    expect(parseVersionFromTag('random-text')).toBeNull()
    expect(parseVersionFromTag('')).toBeNull()
    expect(parseVersionFromTag(null as any)).toBeNull()
  })
})
