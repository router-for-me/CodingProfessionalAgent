import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import {
  EnvironmentWatcherService,
} from '../../src/main/services/environmentWatcherService.js'
import type { NativeEvent } from '../../src/shared/types.js'

describe('EnvironmentWatcherService', () => {
  let service: EnvironmentWatcherService
  let tempDir: string
  let emittedEvents: NativeEvent[]

  beforeEach(async () => {
    emittedEvents = []
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cpa-env-watcher-test-'))
    service = new EnvironmentWatcherService(
      (event) => emittedEvents.push(event),
      { debounceMs: 20 },
    )
  })

  afterEach(async () => {
    service.dispose()
    try {
      await fs.rm(tempDir, { recursive: true, force: true })
    } catch {
      // Ignore cleanup error
    }
  })

  it('returns null for project without environment.toml without throwing', async () => {
    const result = await service.getProjectEnvironment(tempDir)
    expect(result).toBeNull()
  })

  it('detects .cpa/environments/environment.toml', async () => {
    const cpaEnvDir = path.join(tempDir, '.cpa', 'environments')
    await fs.mkdir(cpaEnvDir, { recursive: true })
    const tomlPath = path.join(cpaEnvDir, 'environment.toml')
    await fs.writeFile(tomlPath, 'name = "test-cpa"\n', 'utf8')

    const result = await service.getProjectEnvironment(tempDir)
    expect(result).not.toBeNull()
    expect(result?.filePath).toBe(tomlPath)
    expect(result?.content).toContain('test-cpa')
  })

  it('detects root environment.toml as fallback', async () => {
    const tomlPath = path.join(tempDir, 'environment.toml')
    await fs.writeFile(tomlPath, 'name = "root-env"\n', 'utf8')

    const result = await service.getProjectEnvironment(tempDir)
    expect(result).not.toBeNull()
    expect(result?.filePath).toBe(tomlPath)
    expect(result?.content).toContain('root-env')
  })

  it('serves from cache on subsequent calls', async () => {
    const tomlPath = path.join(tempDir, 'environment.toml')
    await fs.writeFile(tomlPath, 'name = "initial"\n', 'utf8')

    const first = await service.getProjectEnvironment(tempDir)
    expect(first?.content).toContain('initial')

    // Overwrite file directly without waiting for watcher event
    await fs.writeFile(tomlPath, 'name = "updated"\n', 'utf8')
    const cached = await service.getProjectEnvironment(tempDir)
    expect(cached?.content).toContain('initial')

    // Invalidate cache
    service.invalidateCache(tempDir)
    const fresh = await service.getProjectEnvironment(tempDir)
    expect(fresh?.content).toContain('updated')
  })

  it('emits environment:changed event when environment file is created/modified', async () => {
    // Initial state: no env
    await service.getProjectEnvironment(tempDir)
    await service.watchProjects([tempDir])

    const tomlPath = path.join(tempDir, 'environment.toml')
    await fs.writeFile(tomlPath, 'name = "watcher-detected"\n', 'utf8')

    // Wait for fs watcher and debounce with retry loop
    for (let i = 0; i < 20; i++) {
      if (emittedEvents.some((e) => e.kind === 'environment:changed')) {
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }

    const changeEvent = emittedEvents.find((e) => e.kind === 'environment:changed')
    expect(changeEvent).toBeDefined()
    if (changeEvent) {
      const data = JSON.parse(changeEvent.data)
      expect(data.projectPath).toBe(path.resolve(tempDir))
      expect(data.hasEnv).toBe(true)
      expect(data.content).toContain('watcher-detected')
    }
  })

  it('cleans up watchers on dispose', async () => {
    await service.watchProjects([tempDir])
    service.dispose()
    // Calling getProjectEnvironment after dispose still works safely
    const result = await service.getProjectEnvironment(tempDir)
    expect(result).toBeNull()
  })
})
