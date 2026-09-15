import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { getAppVersion, getUserAgent, resetCachedAppVersion } from '../src/main/utils/version.js'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import * as electron from 'electron'
import { UpdateStateStorage } from '../src/main/services/update/updateStateStorage.js'

describe('version utility', () => {
  const originalNodeEnv = process.env.NODE_ENV
  const originalCpaDev = process.env.CPA_DEV
  let tempRuntimeDir: string

  beforeEach(() => {
    tempRuntimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpa-version-test-'))
    resetCachedAppVersion()
    delete process.env.CPA_DEV
  })

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv
    if (originalCpaDev !== undefined) {
      process.env.CPA_DEV = originalCpaDev
    } else {
      delete process.env.CPA_DEV
    }
    resetCachedAppVersion()
    try {
      fs.rmSync(tempRuntimeDir, { recursive: true, force: true })
    } catch {}
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

  it('reads active version from UpdateStateStorage when configured', () => {
    process.env.NODE_ENV = 'production'
    resetCachedAppVersion()

    const storage = new UpdateStateStorage({ runtimeDir: tempRuntimeDir, baseVersion: '1.0.0' })
    storage.recordPendingVersion('1.0.4', 'versions/1.0.4/app.asar')
    storage.activatePendingVersion()

    const version = getAppVersion()
    expect(version).toBeDefined()
    expect(typeof version).toBe('string')
  })
})
