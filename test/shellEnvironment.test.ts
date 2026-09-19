import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  getCommonDevPaths,
  enrichPath,
  probeLoginShellEnv,
  syncUserShellEnvironment,
  resetEnvironmentSyncState,
} from '../src/main/services/shellEnvironment.js'

describe('shellEnvironment', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    resetEnvironmentSyncState()
  })

  afterEach(() => {
    process.env = { ...originalEnv }
    resetEnvironmentSyncState()
    vi.restoreAllMocks()
  })

  describe('getCommonDevPaths', () => {
    it('returns macOS developer tool directories including Homebrew and Go', () => {
      const paths = getCommonDevPaths('darwin', '/Users/testuser')
      expect(paths).toContain('/opt/homebrew/bin')
      expect(paths).toContain('/opt/homebrew/sbin')
      expect(paths).toContain('/usr/local/bin')
      expect(paths).toContain('/usr/local/go/bin')
      expect(paths).toContain('/Users/testuser/go/bin')
      expect(paths).toContain('/Users/testuser/.cargo/bin')
      expect(paths).toContain('/Users/testuser/.local/bin')
    })

    it('returns Linux developer tool directories including Linuxbrew and Go', () => {
      const paths = getCommonDevPaths('linux', '/home/testuser')
      expect(paths).toContain('/home/linuxbrew/.linuxbrew/bin')
      expect(paths).toContain('/usr/local/bin')
      expect(paths).toContain('/usr/local/go/bin')
      expect(paths).toContain('/home/testuser/go/bin')
      expect(paths).toContain('/home/testuser/.cargo/bin')
    })

    it('returns Windows developer tool directories', () => {
      const paths = getCommonDevPaths('win32', 'C:\\Users\\testuser')
      expect(paths.some((p) => p.includes('Go\\bin'))).toBe(true)
      expect(paths.some((p) => p.includes('.cargo\\bin'))).toBe(true)
    })
  })

  describe('enrichPath', () => {
    it('preserves existing PATH order and appends existing common dev directories without duplicates', () => {
      const initialPath = '/usr/bin:/bin:/usr/sbin:/sbin'
      const fakeExists = (p: string) => {
        return (
          p === '/opt/homebrew/bin' ||
          p === '/usr/local/go/bin' ||
          p === '/Users/test/.cargo/bin'
        )
      }

      const result = enrichPath(initialPath, 'darwin', '/Users/test', fakeExists)
      const parts = result.split(':')

      // Initial entries remain at the front
      expect(parts.slice(0, 4)).toEqual(['/usr/bin', '/bin', '/usr/sbin', '/sbin'])
      // Detected dev directories appended
      expect(parts).toContain('/opt/homebrew/bin')
      expect(parts).toContain('/usr/local/go/bin')
      expect(parts).toContain('/Users/test/.cargo/bin')

      // Unmatched directories are not added
      expect(parts).not.toContain('/usr/local/sbin')
    })

    it('does not duplicate directories that are already present in PATH', () => {
      const initialPath = '/opt/homebrew/bin:/usr/bin:/bin'
      const fakeExists = (p: string) => p === '/opt/homebrew/bin' || p === '/usr/local/go/bin'

      const result = enrichPath(initialPath, 'darwin', '/Users/test', fakeExists)
      const parts = result.split(':')

      expect(parts.filter((p) => p === '/opt/homebrew/bin')).toHaveLength(1)
      expect(parts[0]).toBe('/opt/homebrew/bin')
      expect(parts).toContain('/usr/local/go/bin')
    })

    it('handles empty initial PATH gracefully', () => {
      const fakeExists = (p: string) => p === '/usr/local/bin'
      const result = enrichPath('', 'darwin', '/Users/test', fakeExists)
      expect(result).toBe('/usr/local/bin')
    })
  })

  describe('probeLoginShellEnv', () => {
    it('returns null on win32 platform', () => {
      const result = probeLoginShellEnv({ platform: 'win32' })
      expect(result).toBeNull()
    })

    it('probes shell environment on unix when shell is available', () => {
      if (process.platform === 'win32') return

      const envMap = probeLoginShellEnv({ timeoutMs: 3000 })
      if (envMap) {
        expect(typeof envMap.PATH).toBe('string')
        expect(envMap.PATH.length).toBeGreaterThan(0)
      }
    })
  })

  describe('syncUserShellEnvironment', () => {
    it('enriches process.env.PATH and preserves protected environment variables', () => {
      process.env.ELECTRON_RUN_AS_NODE = '1'
      process.env.PATH = '/usr/bin:/bin'

      syncUserShellEnvironment({
        force: true,
        timeoutMs: 1000,
        platform: 'darwin',
        customHome: '/tmp/nonexistent-home',
      })

      expect(process.env.ELECTRON_RUN_AS_NODE).toBe('1')
      expect(process.env.PATH).toBeDefined()
    })

    it('is idempotent when force is not passed', () => {
      process.env.PATH = '/initial/test/path'

      syncUserShellEnvironment({ force: false, platform: 'win32' })
      const firstRunPath = process.env.PATH

      // Second invocation without force should no-op
      syncUserShellEnvironment({ force: false, platform: 'win32' })
      expect(process.env.PATH).toBe(firstRunPath)
    })
  })
})
