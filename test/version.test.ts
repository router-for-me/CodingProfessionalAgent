import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { getAppVersion, getUserAgent, resetCachedAppVersion } from '../src/main/utils/version.js'
import * as fs from 'node:fs'
import * as path from 'node:path'

describe('version utility', () => {
  const originalNodeEnv = process.env.NODE_ENV

  beforeEach(() => {
    resetCachedAppVersion()
  })

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv
    resetCachedAppVersion()
  })

  it('returns dev and CodingProfessionalAgent/dev in development environment', () => {
    process.env.NODE_ENV = 'development'
    resetCachedAppVersion()

    expect(getAppVersion()).toBe('dev')
    expect(getUserAgent()).toBe('CodingProfessionalAgent/dev')
    expect(getUserAgent()).not.toContain('(Electron)')
    expect(getUserAgent()).not.toContain('44.0.0')
  })

  it('reads app version from package.json in production/non-dev environment', () => {
    process.env.NODE_ENV = 'production'
    resetCachedAppVersion()

    const pkg = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf8'))
    const version = getAppVersion()
    expect(version).toBe(pkg.version)
    expect(getUserAgent()).toBe(`CodingProfessionalAgent/${pkg.version}`)
    expect(getUserAgent()).not.toContain('(Electron)')
  })
})
