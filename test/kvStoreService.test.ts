import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { KVStoreService } from '../plugins/bundled/cpa.core.settings/main/kvStoreService.js'

describe('KVStoreService', () => {
  let service: KVStoreService
  let tempDir: string
  let storeFile: string

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cpa-kv-test-'))
    storeFile = path.join(tempDir, 'settings.json')
    service = new KVStoreService(storeFile)
  })

  afterEach(async () => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true })
    } catch {
      // Ignore
    }
  })

  it('gets, sets and saves key-value data', async () => {
    expect(await service.get('non-existent')).toBeUndefined()

    await service.set('test-key', { foo: 'bar', count: 42 })
    expect(await service.get('test-key')).toEqual({ foo: 'bar', count: 42 })

    // Create a new instance pointing to same file to verify persistence
    const reloaded = new KVStoreService(storeFile)
    expect(await reloaded.get('test-key')).toEqual({ foo: 'bar', count: 42 })
  })

  it('defaults to ~/.coding-professional-agent/settings.json', () => {
    const defaultService = new KVStoreService({ getHomeDir: () => '/mock-home' })
    const expectedPath = path.join('/mock-home', '.coding-professional-agent', 'settings.json')
    expect((defaultService as unknown as { storePath: string }).storePath).toBe(expectedPath)
  })

  it('uses ~/.coding-professional-agent-dev/settings.json when in dev mode', () => {
    const devService = new KVStoreService({ getHomeDir: () => '/mock-home', isDev: true })
    const expectedPath = path.join('/mock-home', '.coding-professional-agent-dev', 'settings.json')
    expect((devService as unknown as { storePath: string }).storePath).toBe(expectedPath)
  })

  it('separates projects into projects.json, cachedModels into cached_models.json, and shortcuts into shortcuts.json', async () => {
    const mockProjects = [
      { id: 'p1', name: 'Project 1', path: '/test/p1' },
      { id: 'p2', name: 'Project 2', path: '/test/p2' },
    ]
    const mockModels = [
      { id: 'm1', name: 'Model 1', provider: 'openai' },
    ]
    const mockShortcuts = {
      'new-chat': [{ ctrl: false, alt: false, shift: false, meta: true, key: 'N' }],
    }

    await service.set('projects', mockProjects)
    await service.set('cachedModels', mockModels)
    await service.set('shortcuts', mockShortcuts)
    await service.set('other-key', { test: true })

    expect(await service.get('projects')).toEqual(mockProjects)
    expect(await service.get('cachedModels')).toEqual(mockModels)
    const storedShortcuts = (await service.get('shortcuts')) as Array<{
      id: string
      shortcuts: Array<{ ctrl: boolean; alt: boolean; shift: boolean; meta: boolean; key: string }>
    }>
    expect(storedShortcuts.find((s) => s.id === 'new-chat')?.shortcuts).toEqual([
      { ctrl: false, alt: false, shift: false, meta: true, key: 'N' },
    ])
    expect(await service.get('other-key')).toEqual({ test: true })

    const projectsFile = path.join(tempDir, 'projects.json')
    const cachedModelsFile = path.join(tempDir, 'cached_models.json')
    const shortcutsFile = path.join(tempDir, 'shortcuts.json')
    const settingsFile = path.join(tempDir, 'settings.json')

    expect(JSON.parse(await fs.readFile(projectsFile, 'utf8'))).toEqual(mockProjects)
    expect(JSON.parse(await fs.readFile(cachedModelsFile, 'utf8'))).toEqual(mockModels)
    const shortcutsContent = JSON.parse(await fs.readFile(shortcutsFile, 'utf8')) as Array<{
      id: string
      shortcuts: Array<{ ctrl: boolean; alt: boolean; shift: boolean; meta: boolean; key: string }>
    }>
    expect(shortcutsContent.find((s) => s.id === 'new-chat')?.shortcuts).toEqual([
      { ctrl: false, alt: false, shift: false, meta: true, key: 'N' },
    ])
    // Verify each item only has id and shortcuts fields
    for (const item of shortcutsContent) {
      expect(Object.keys(item).sort()).toEqual(['id', 'shortcuts'])
    }
    const settingsContent = JSON.parse(await fs.readFile(settingsFile, 'utf8'))
    expect(settingsContent).toEqual({ 'other-key': { test: true } })
    expect(settingsContent.projects).toBeUndefined()
    expect(settingsContent.cachedModels).toBeUndefined()
    expect(settingsContent.shortcuts).toBeUndefined()

    // Reload in a new service instance to verify separate loading
    const reloaded = new KVStoreService(storeFile)
    expect(await reloaded.get('projects')).toEqual(mockProjects)
    expect(await reloaded.get('cachedModels')).toEqual(mockModels)
    const reloadedShortcuts = (await reloaded.get('shortcuts')) as Array<{
      id: string
      shortcuts: Array<{ ctrl: boolean; alt: boolean; shift: boolean; meta: boolean; key: string }>
    }>
    expect(reloadedShortcuts.find((s) => s.id === 'new-chat')?.shortcuts).toEqual([
      { ctrl: false, alt: false, shift: false, meta: true, key: 'N' },
    ])
    expect(await reloaded.get('other-key')).toEqual({ test: true })
  })

  it('separates scheduled tasks into schedule.json and supports persistence', async () => {
    const mockTasks = [
      { id: 't1', title: 'Task 1', schedule: 'Daily 9:00', enabled: true },
      { id: 't2', title: 'Task 2', schedule: 'Weekdays 8:00', enabled: false },
    ]

    await service.set('schedule', mockTasks)
    expect(await service.get('schedule')).toEqual(mockTasks)

    const scheduleFile = path.join(tempDir, 'schedule.json')
    expect(JSON.parse(await fs.readFile(scheduleFile, 'utf8'))).toEqual(mockTasks)

    // Reload in a new instance
    const reloaded = new KVStoreService(storeFile)
    expect(await reloaded.get('schedule')).toEqual(mockTasks)
  })

  it('strips projects, cachedModels, and shortcuts from app-state and saves them separately', async () => {
    const mockProjects = [{ id: 'p-app', name: 'App Project' }]
    const mockModels = [{ id: 'm-app', name: 'App Model' }]
    const mockShortcuts = {
      settings: [{ ctrl: true, alt: false, shift: false, meta: true, key: 'S' }],
    }
    const appState = {
      version: 2,
      settings: { locale: 'zh-CN', shortcuts: mockShortcuts },
      projects: mockProjects,
      cachedModels: mockModels,
      shortcuts: mockShortcuts,
      currentSessionId: 'sess-1',
    }

    await service.set('app-state', appState)

    const projectsFile = path.join(tempDir, 'projects.json')
    const cachedModelsFile = path.join(tempDir, 'cached_models.json')
    const shortcutsFile = path.join(tempDir, 'shortcuts.json')
    const settingsFile = path.join(tempDir, 'settings.json')

    expect(JSON.parse(await fs.readFile(projectsFile, 'utf8'))).toEqual(mockProjects)
    expect(JSON.parse(await fs.readFile(cachedModelsFile, 'utf8'))).toEqual(mockModels)
    const shortcutsContent = JSON.parse(await fs.readFile(shortcutsFile, 'utf8')) as Array<{
      id: string
      shortcuts: Array<{ ctrl: boolean; alt: boolean; shift: boolean; meta: boolean; key: string }>
    }>
    expect(shortcutsContent.find((s) => s.id === 'settings')?.shortcuts).toEqual([
      { ctrl: true, alt: false, shift: false, meta: true, key: 'S' },
    ])
    // Verify each item only has id and shortcuts fields
    for (const item of shortcutsContent) {
      expect(Object.keys(item).sort()).toEqual(['id', 'shortcuts'])
    }

    const savedSettings = JSON.parse(await fs.readFile(settingsFile, 'utf8'))
    expect(savedSettings['app-state']).toEqual({
      version: 2,
      settings: { locale: 'zh-CN' },
      currentSessionId: 'sess-1',
    })
    expect(savedSettings['app-state'].projects).toBeUndefined()
    expect(savedSettings['app-state'].cachedModels).toBeUndefined()
    expect(savedSettings['app-state'].shortcuts).toBeUndefined()
  })

  it('does not overwrite existing projects when app-state is saved with empty projects', async () => {
    const existingProjects = [{ id: 'p-preserve', name: 'Preserved Project' }]
    await service.set('projects', existingProjects)

    const appState = {
      version: 2,
      settings: { locale: 'zh-CN' },
      projects: [],
      currentSessionId: 'sess-1',
    }

    await service.set('app-state', appState)
    expect(await service.get('projects')).toEqual(existingProjects)

    const projectsFile = path.join(tempDir, 'projects.json')
    expect(JSON.parse(await fs.readFile(projectsFile, 'utf8'))).toEqual(existingProjects)
  })

  it('only saves customized shortcuts that differ from system defaults in shortcuts.json', async () => {
    // 1. Setting empty or default shortcuts results in empty shortcuts.json
    await service.set('shortcuts', {})
    const shortcutsFile = path.join(tempDir, 'shortcuts.json')
    expect(JSON.parse(await fs.readFile(shortcutsFile, 'utf8'))).toEqual([])

    // 2. Setting shortcut matching system default also results in empty shortcuts.json
    const defaultSettingsShortcut = {
      settings: [{ ctrl: false, alt: false, shift: false, meta: true, key: ',' }],
    }
    await service.set('shortcuts', defaultSettingsShortcut)
    expect(JSON.parse(await fs.readFile(shortcutsFile, 'utf8'))).toEqual([])

    // 3. Setting customized shortcut that differs from default persists only the difference
    const customizedShortcuts = {
      'new-chat': [{ ctrl: true, alt: false, shift: false, meta: false, key: 'N' }],
      'settings': [{ ctrl: false, alt: false, shift: false, meta: true, key: ',' }], // default, should not be saved
    }
    await service.set('shortcuts', customizedShortcuts)
    const saved = JSON.parse(await fs.readFile(shortcutsFile, 'utf8')) as Array<{
      id: string
      shortcuts: Array<{ ctrl: boolean; alt: boolean; shift: boolean; meta: boolean; key: string }>
    }>
    expect(saved).toEqual([
      {
        id: 'new-chat',
        shortcuts: [{ ctrl: true, alt: false, shift: false, meta: false, key: 'N' }],
      },
    ])
  })

  it('migrates legacy store if target does not exist and splits projects and cachedModels', async () => {
    const legacyDir = path.join(tempDir, 'legacy')
    await fs.mkdir(legacyDir, { recursive: true })
    const legacyFile = path.join(legacyDir, 'app-data.json')
    const legacyData = {
      'migrated': true,
      'counter': 99,
      'app-state': {
        version: 2,
        settings: { theme: 'dark' },
        projects: [{ id: 'legacy-proj', name: 'Legacy Proj' }],
        cachedModels: [{ id: 'legacy-model', name: 'Legacy Model' }],
      },
    }
    await fs.writeFile(legacyFile, JSON.stringify(legacyData), 'utf8')

    const migratingService = new KVStoreService({ getHomeDir: () => tempDir })
    vi.spyOn(migratingService as unknown as { getLegacyStorePath: () => string }, 'getLegacyStorePath').mockReturnValue(legacyFile)

    expect(await migratingService.get('migrated')).toBe(true)
    expect(await migratingService.get('counter')).toBe(99)
    expect(await migratingService.get('projects')).toEqual([{ id: 'legacy-proj', name: 'Legacy Proj' }])
    expect(await migratingService.get('cachedModels')).toEqual([{ id: 'legacy-model', name: 'Legacy Model' }])

    // Verify it saved to settings.json, projects.json, and cached_models.json
    const newTargetFile = path.join(tempDir, '.coding-professional-agent', 'settings.json')
    const newProjectsFile = path.join(tempDir, '.coding-professional-agent', 'projects.json')
    const newCachedModelsFile = path.join(tempDir, '.coding-professional-agent', 'cached_models.json')

    const settingsContent = JSON.parse(await fs.readFile(newTargetFile, 'utf8'))
    expect(settingsContent.migrated).toBe(true)
    expect(settingsContent.counter).toBe(99)
    expect(settingsContent['app-state']).toEqual({
      version: 2,
      settings: {},
    })

    const newUiFile = path.join(tempDir, '.coding-professional-agent', 'ui.json')
    const uiContent = JSON.parse(await fs.readFile(newUiFile, 'utf8'))
    expect(uiContent.theme).toBe('dark')

    const projectsContent = JSON.parse(await fs.readFile(newProjectsFile, 'utf8'))
    expect(projectsContent).toEqual([{ id: 'legacy-proj', name: 'Legacy Proj' }])

    const cachedModelsContent = JSON.parse(await fs.readFile(newCachedModelsFile, 'utf8'))
    expect(cachedModelsContent).toEqual([{ id: 'legacy-model', name: 'Legacy Model' }])
  })

  it('separates UI settings and UI layout into ui.json and strips them from settings.json', async () => {
    const appState = {
      version: 2,
      settings: {
        locale: 'zh-CN',
        theme: 'dark',
        accentColor: '#339CFF',
        uiFontSize: 16,
        showBottomPanel: true,
      },
      sidebarCollapsed: false,
      sidebarWidth: 320,
      currentSessionId: 'sess-1',
    }

    await service.set('app-state', appState)

    const uiFile = path.join(tempDir, 'ui.json')
    const settingsFile = path.join(tempDir, 'settings.json')

    const uiContent = JSON.parse(await fs.readFile(uiFile, 'utf8'))
    expect(uiContent.theme).toBe('dark')
    expect(uiContent.accentColor).toBe('#339CFF')
    expect(uiContent.uiFontSize).toBe(16)
    expect(uiContent.showBottomPanel).toBe(true)
    expect(uiContent.sidebarCollapsed).toBe(false)
    expect(uiContent.sidebarWidth).toBe(320)

    const settingsContent = JSON.parse(await fs.readFile(settingsFile, 'utf8'))
    expect(settingsContent['app-state']).toEqual({
      version: 2,
      settings: { locale: 'zh-CN' },
      currentSessionId: 'sess-1',
    })
    expect(settingsContent['app-state'].sidebarWidth).toBeUndefined()
    expect(settingsContent['app-state'].settings.theme).toBeUndefined()

    // Test get('ui') and set('ui')
    expect(await service.get('ui')).toMatchObject({
      theme: 'dark',
      accentColor: '#339CFF',
      sidebarWidth: 320,
    })

    await service.set('ui', { theme: 'light', customUiProp: 123 })
    const updatedUi = JSON.parse(await fs.readFile(uiFile, 'utf8'))
    expect(updatedUi.theme).toBe('light')
    expect(updatedUi.customUiProp).toBe(123)
    expect(updatedUi.sidebarWidth).toBe(320)
  })

  it('correctly persists sequential and concurrent set calls', async () => {
    const promises = []
    for (let i = 0; i < 10; i++) {
      promises.push(service.set(`key-${i}`, { value: i }))
    }
    await Promise.all(promises)

    const reloaded = new KVStoreService(storeFile)
    for (let i = 0; i < 10; i++) {
      expect(await reloaded.get(`key-${i}`)).toEqual({ value: i })
    }
  })

  it('flushes pending changes synchronously via saveSync/dispose and setSync', async () => {
    service.setSync('sync-key', { saved: true })

    const reloaded = new KVStoreService(storeFile)
    expect(await reloaded.get('sync-key')).toEqual({ saved: true })
    expect(reloaded.getSync('sync-key')).toEqual({ saved: true })

    await service.set('async-key', { saved: true })
    service.dispose()

    const reloaded2 = new KVStoreService(storeFile)
    expect(reloaded2.getSync('async-key')).toEqual({ saved: true })
  })
})
