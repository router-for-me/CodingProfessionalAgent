import { describe, expect, it } from 'vitest'
import * as path from 'node:path'
import * as fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { scanBundledPluginContracts } from '../scripts/generate-bundled-plugin-catalog.mjs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const repoRoot = path.resolve(__dirname, '..')

describe('bundledPluginContract baseline', () => {
    it('accounts for every bundled plugin through a real entry or the migration adapter', async () => {
        const report = await scanBundledPluginContracts(repoRoot)

        // Baseline plus the independently packaged Web Search plugin.
        expect(report.pluginIds).toHaveLength(23)
        expect(report.pluginIds).toContain('cpa.core.web-search')
        expect(report.unaccountedPluginIds).toEqual([])
        expect(report.duplicatePluginIds).toEqual([])
        expect(report.manifestCopies).toBe(0)
    })

    it('ensures cpa.core.session-manager is fully migrated with real entries and zero legacy adapters', async () => {
        const sessionManagerDir = path.join(repoRoot, 'plugins', 'bundled', 'cpa.core.session-manager')
        const manifestPath = path.join(sessionManagerDir, 'manifest.json')
        expect(fs.existsSync(manifestPath)).toBe(true)

        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
        expect(manifest.id).toBe('cpa.core.session-manager')
        expect(manifest.entries).toBeDefined()
        expect(manifest.entries.main).toBe('./main/index.ts')
        expect(manifest.entries.renderer).toBe('./renderer/index.tsx')
        expect(manifest.entries.agent).toBe('./agent/index.ts')
        expect(manifest.dependencies).toBeDefined()
        expect(manifest.capabilities).toBeDefined()
        expect(manifest.contributes).toBeDefined()

        // Check real files exist
        const mainEntryPath = path.join(sessionManagerDir, 'main', 'index.ts')
        const rendererEntryPath = path.join(sessionManagerDir, 'renderer', 'index.tsx')
        const agentEntryPath = path.join(sessionManagerDir, 'agent', 'index.ts')

        expect(fs.existsSync(mainEntryPath)).toBe(true)
        expect(fs.existsSync(rendererEntryPath)).toBe(true)
        expect(fs.existsSync(agentEntryPath)).toBe(true)

        // Entries must use definePluginEntry and must NOT embed manifest
        const mainCode = fs.readFileSync(mainEntryPath, 'utf8')
        const rendererCode = fs.readFileSync(rendererEntryPath, 'utf8')
        const agentCode = fs.readFileSync(agentEntryPath, 'utf8')

        expect(mainCode).toContain('definePluginEntry')
        expect(rendererCode).toContain('definePluginEntry')
        expect(agentCode).toContain('definePluginEntry')

        expect(mainCode).not.toMatch(/manifest:\s*\{/)
        expect(rendererCode).not.toMatch(/manifest:\s*\{/)
        expect(agentCode).not.toMatch(/manifest:\s*\{/)

        // Ensure scanner reports all three as real entries
        const report = await scanBundledPluginContracts(repoRoot)
        const sessionManagerRealEntries = report.realEntries.filter((e) => e.pluginId === 'cpa.core.session-manager')
        expect(sessionManagerRealEntries.map((e) => e.runtime).sort()).toEqual(['agent', 'main', 'renderer'])

        const sessionManagerLegacy = report.legacyEntries.filter((e) => e.pluginId === 'cpa.core.session-manager')
        expect(sessionManagerLegacy).toHaveLength(0)
    })

    it('ensures cpa.core.settings is fully migrated with real entries, authoritative manifest, and zero legacy adapters', async () => {
        const settingsDir = path.join(repoRoot, 'plugins', 'bundled', 'cpa.core.settings')
        const manifestPath = path.join(settingsDir, 'manifest.json')
        expect(fs.existsSync(manifestPath)).toBe(true)

        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
        expect(manifest.id).toBe('cpa.core.settings')
        expect(manifest.entries).toBeDefined()
        expect(manifest.entries.main).toBe('./main/index.ts')
        expect(manifest.entries.renderer).toBe('./renderer/index.tsx')
        expect(manifest.entries.agent).toBeUndefined()
        expect(manifest.dependencies).toBeDefined()
        expect(manifest.capabilities).toBeDefined()
        expect(manifest.contributes).toBeDefined()
        expect(manifest.contributes['service']).toContain('kvStoreService')
        expect(manifest.contributes['rpc']).toEqual(
            expect.arrayContaining(['kvstore:get', 'kvstore:set', 'kvstore:save']),
        )
        expect(manifest.contributes['settings-group']).toEqual(
            expect.arrayContaining(['personal', 'integrations', 'code']),
        )
        expect(manifest.contributes['settings-group']).not.toContain('archived')
        expect(manifest.contributes['settings']).toEqual(
            expect.arrayContaining([
                'general',
                'appearance',
                'personalization',
                'shortcuts',
                'connections',
                'plugins',
                'git',
                'environments',
            ]),
        )
        expect(manifest.contributes['action']).toEqual(
            expect.arrayContaining(['settings', 'user.logout', 'keyboard-shortcuts']),
        )

        // Check real files exist
        const mainEntryPath = path.join(settingsDir, 'main', 'index.ts')
        const rendererEntryPath = path.join(settingsDir, 'renderer', 'index.tsx')

        expect(fs.existsSync(mainEntryPath)).toBe(true)
        expect(fs.existsSync(rendererEntryPath)).toBe(true)

        // Entries must use definePluginEntry and must NOT embed manifest
        const mainCode = fs.readFileSync(mainEntryPath, 'utf8')
        const rendererCode = fs.readFileSync(rendererEntryPath, 'utf8')

        expect(mainCode).toContain('definePluginEntry')
        expect(rendererCode).toContain('definePluginEntry')

        expect(mainCode).not.toMatch(/manifest:\s*\{/)
        expect(rendererCode).not.toMatch(/manifest:\s*\{/)

        // Ensure scanner reports main and renderer as real entries
        const report = await scanBundledPluginContracts(repoRoot)
        const settingsRealEntries = report.realEntries.filter((e) => e.pluginId === 'cpa.core.settings')
        expect(settingsRealEntries.map((e) => e.runtime).sort()).toEqual(['main', 'renderer'])

        const settingsLegacy = report.legacyEntries.filter((e) => e.pluginId === 'cpa.core.settings')
        expect(settingsLegacy).toHaveLength(0)
    })

    it('ensures cpa.core.home is fully migrated with real entries and zero legacy adapters', async () => {
        const pluginDir = path.join(repoRoot, 'plugins', 'bundled', 'cpa.core.home')
        const manifestPath = path.join(pluginDir, 'manifest.json')
        expect(fs.existsSync(manifestPath)).toBe(true)

        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
        expect(manifest.id).toBe('cpa.core.home')
        expect(manifest.entries).toBeDefined()
        expect(manifest.entries.renderer).toBe('./renderer/index.tsx')
        expect(manifest.entries.main).toBeUndefined()
        expect(manifest.entries.agent).toBeUndefined()
        expect(manifest.contributes).toBeDefined()
        expect(manifest.contributes['view']).toContain('home')
        expect(manifest.contributes['navigation']).toContain('home')

        const rendererEntryPath = path.join(pluginDir, 'renderer', 'index.tsx')
        expect(fs.existsSync(rendererEntryPath)).toBe(true)

        const rendererCode = fs.readFileSync(rendererEntryPath, 'utf8')
        expect(rendererCode).toContain('definePluginEntry')
        expect(rendererCode).not.toMatch(/manifest:\s*\{/)

        const report = await scanBundledPluginContracts(repoRoot)
        const realEntries = report.realEntries.filter((e) => e.pluginId === 'cpa.core.home')
        expect(realEntries.map((e) => e.runtime)).toEqual(['renderer'])

        const legacy = report.legacyEntries.filter((e) => e.pluginId === 'cpa.core.home')
        expect(legacy).toHaveLength(0)
    })

    it('ensures cpa.core.navigation is fully migrated with real entries and zero legacy adapters', async () => {
        const pluginDir = path.join(repoRoot, 'plugins', 'bundled', 'cpa.core.navigation')
        const manifestPath = path.join(pluginDir, 'manifest.json')
        expect(fs.existsSync(manifestPath)).toBe(true)

        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
        expect(manifest.id).toBe('cpa.core.navigation')
        expect(manifest.entries).toBeDefined()
        expect(manifest.entries.renderer).toBe('./renderer/index.tsx')
        expect(manifest.entries.main).toBeUndefined()
        expect(manifest.entries.agent).toBeUndefined()
        expect(manifest.contributes).toBeDefined()
        expect(manifest.contributes['view']).toBeUndefined()
        expect(manifest.contributes['navigation']).toBeUndefined()
        expect(manifest.contributes['action']).toEqual(
            expect.arrayContaining(['toggle-sidebar', 'focus-main-chat-input', 'navigate-back', 'navigate-forward']),
        )

        const rendererEntryPath = path.join(pluginDir, 'renderer', 'index.tsx')
        expect(fs.existsSync(rendererEntryPath)).toBe(true)

        const rendererCode = fs.readFileSync(rendererEntryPath, 'utf8')
        expect(rendererCode).toContain('definePluginEntry')
        expect(rendererCode).not.toMatch(/manifest:\s*\{/)

        const report = await scanBundledPluginContracts(repoRoot)
        const realEntries = report.realEntries.filter((e) => e.pluginId === 'cpa.core.navigation')
        expect(realEntries.map((e) => e.runtime)).toEqual(['renderer'])

        const legacy = report.legacyEntries.filter((e) => e.pluginId === 'cpa.core.navigation')
        expect(legacy).toHaveLength(0)
    })

    it('ensures cpa.core.scheduler is fully migrated with real entries and zero legacy adapters', async () => {
        const pluginDir = path.join(repoRoot, 'plugins', 'bundled', 'cpa.core.scheduler')
        const manifestPath = path.join(pluginDir, 'manifest.json')
        expect(fs.existsSync(manifestPath)).toBe(true)

        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
        expect(manifest.id).toBe('cpa.core.scheduler')
        expect(manifest.entries).toBeDefined()
        expect(manifest.entries.main).toBe('./main/index.ts')
        expect(manifest.entries.renderer).toBe('./renderer/index.tsx')
        expect(manifest.entries.agent).toBeUndefined()
        expect(manifest.contributes).toBeDefined()
        expect(manifest.contributes['view']).toContain('scheduled')
        expect(manifest.contributes['navigation']).toContain('scheduled')
        expect(manifest.contributes['action']).toContain('manage-scheduled-tasks')

        const mainEntryPath = path.join(pluginDir, 'main', 'index.ts')
        const rendererEntryPath = path.join(pluginDir, 'renderer', 'index.tsx')
        expect(fs.existsSync(mainEntryPath)).toBe(true)
        expect(fs.existsSync(rendererEntryPath)).toBe(true)

        const mainCode = fs.readFileSync(mainEntryPath, 'utf8')
        const rendererCode = fs.readFileSync(rendererEntryPath, 'utf8')
        expect(mainCode).toContain('definePluginEntry')
        expect(rendererCode).toContain('definePluginEntry')
        expect(mainCode).not.toMatch(/manifest:\s*\{/)
        expect(rendererCode).not.toMatch(/manifest:\s*\{/)

        const report = await scanBundledPluginContracts(repoRoot)
        const realEntries = report.realEntries.filter((e) => e.pluginId === 'cpa.core.scheduler')
        expect(realEntries.map((e) => e.runtime).sort()).toEqual(['main', 'renderer'])

        const legacy = report.legacyEntries.filter((e) => e.pluginId === 'cpa.core.scheduler')
        expect(legacy).toHaveLength(0)
    })

    it('ensures cpa.core.worktree is fully migrated with real entries and zero legacy adapters', async () => {
        const pluginDir = path.join(repoRoot, 'plugins', 'bundled', 'cpa.core.worktree')
        const manifestPath = path.join(pluginDir, 'manifest.json')
        expect(fs.existsSync(manifestPath)).toBe(true)

        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
        expect(manifest.id).toBe('cpa.core.worktree')
        expect(manifest.entries).toBeDefined()
        expect(manifest.entries.main).toBe('./main/index.ts')
        expect(manifest.entries.renderer).toBe('./renderer/index.tsx')
        expect(manifest.entries.agent).toBeUndefined()
        expect(manifest.contributes).toBeDefined()
        expect(manifest.contributes['service']).toContain('worktreeCoordinationService')
        expect(manifest.contributes['rpc']).toEqual(
            expect.arrayContaining([
                'worktree:setup',
                'worktree:list',
                'worktree:delete',
                'worktree:resolve-root',
            ]),
        )
        expect(manifest.contributes['settings']).toContain('worktrees')
        expect(manifest.contributes['action']).toContain('toggle-local-worktree')

        const mainEntryPath = path.join(pluginDir, 'main', 'index.ts')
        const rendererEntryPath = path.join(pluginDir, 'renderer', 'index.tsx')
        expect(fs.existsSync(mainEntryPath)).toBe(true)
        expect(fs.existsSync(rendererEntryPath)).toBe(true)

        const mainCode = fs.readFileSync(mainEntryPath, 'utf8')
        const rendererCode = fs.readFileSync(rendererEntryPath, 'utf8')
        expect(mainCode).toContain('definePluginEntry')
        expect(rendererCode).toContain('definePluginEntry')
        expect(mainCode).not.toMatch(/manifest:\s*\{/)
        expect(rendererCode).not.toMatch(/manifest:\s*\{/)

        const report = await scanBundledPluginContracts(repoRoot)
        const realEntries = report.realEntries.filter((e) => e.pluginId === 'cpa.core.worktree')
        expect(realEntries.map((e) => e.runtime).sort()).toEqual(['main', 'renderer'])

        const legacy = report.legacyEntries.filter((e) => e.pluginId === 'cpa.core.worktree')
        expect(legacy).toHaveLength(0)
    })

    it('ensures cpa.core.usage-stats is fully migrated with real entries and zero legacy adapters', async () => {
        const pluginDir = path.join(repoRoot, 'plugins', 'bundled', 'cpa.core.usage-stats')
        const manifestPath = path.join(pluginDir, 'manifest.json')
        expect(fs.existsSync(manifestPath)).toBe(true)

        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
        expect(manifest.id).toBe('cpa.core.usage-stats')
        expect(manifest.entries).toBeDefined()
        expect(manifest.entries.renderer).toBe('./renderer/index.tsx')
        expect(manifest.entries.main).toBeUndefined()
        expect(manifest.entries.agent).toBeUndefined()
        expect(manifest.contributes).toBeDefined()
        expect(manifest.contributes['settings']).toContain('usage')
        expect(manifest.contributes['action']).toContain('user.remainingUsage')

        const rendererEntryPath = path.join(pluginDir, 'renderer', 'index.tsx')
        expect(fs.existsSync(rendererEntryPath)).toBe(true)

        const rendererCode = fs.readFileSync(rendererEntryPath, 'utf8')
        expect(rendererCode).toContain('definePluginEntry')
        expect(rendererCode).not.toMatch(/manifest:\s*\{/)

        const report = await scanBundledPluginContracts(repoRoot)
        const realEntries = report.realEntries.filter((e) => e.pluginId === 'cpa.core.usage-stats')
        expect(realEntries.map((e) => e.runtime)).toEqual(['renderer'])

        const legacy = report.legacyEntries.filter((e) => e.pluginId === 'cpa.core.usage-stats')
        expect(legacy).toHaveLength(0)
    })

    it('ensures cpa.core.chat is fully migrated with real entries, authoritative manifest, and zero legacy adapters', async () => {
        const chatDir = path.join(repoRoot, 'plugins', 'bundled', 'cpa.core.chat')
        const manifestPath = path.join(chatDir, 'manifest.json')
        expect(fs.existsSync(manifestPath)).toBe(true)

        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
        expect(manifest.id).toBe('cpa.core.chat')
        expect(manifest.entries).toBeDefined()
        expect(manifest.entries.renderer).toBe('./renderer/index.tsx')
        expect(manifest.entries.main).toBeUndefined()
        expect(manifest.entries.agent).toBeUndefined()
        expect(manifest.dependencies).toBeDefined()
        expect(manifest.capabilities).toBeDefined()
        expect(manifest.contributes).toBeDefined()
        expect(manifest.contributes['view']).toContain('chat')
        expect(manifest.contributes['slot']).toContain('turn-header')
        expect(manifest.contributes['chat-renderer']).toEqual(
            expect.arrayContaining([
                'user-message',
                'assistant-message',
                'compaction-message',
                'thinking-part',
                'text-part',
                'tool-call-part',
            ]),
        )

        // Check real files exist
        const rendererEntryPath = path.join(chatDir, 'renderer', 'index.tsx')
        expect(fs.existsSync(rendererEntryPath)).toBe(true)

        // Entries must use definePluginEntry and must NOT embed manifest
        const rendererCode = fs.readFileSync(rendererEntryPath, 'utf8')
        expect(rendererCode).toContain('definePluginEntry')
        expect(rendererCode).not.toMatch(/manifest:\s*\{/)

        // Ensure scanner reports renderer as real entry
        const report = await scanBundledPluginContracts(repoRoot)
        const chatRealEntries = report.realEntries.filter((e) => e.pluginId === 'cpa.core.chat')
        expect(chatRealEntries.map((e) => e.runtime)).toEqual(['renderer'])

        const chatLegacy = report.legacyEntries.filter((e) => e.pluginId === 'cpa.core.chat')
        expect(chatLegacy).toHaveLength(0)
    })

    it('ensures cpa.core.composer is fully migrated with real entries, authoritative manifest, and zero legacy adapters', async () => {
        const composerDir = path.join(repoRoot, 'plugins', 'bundled', 'cpa.core.composer')
        const manifestPath = path.join(composerDir, 'manifest.json')
        expect(fs.existsSync(manifestPath)).toBe(true)

        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
        expect(manifest.id).toBe('cpa.core.composer')
        expect(manifest.entries).toBeDefined()
        expect(manifest.entries.renderer).toBe('./renderer/index.tsx')
        expect(manifest.entries.main).toBeUndefined()
        expect(manifest.entries.agent).toBeUndefined()
        expect(manifest.dependencies).toBeDefined()
        expect(manifest.capabilities).toBeDefined()
        expect(manifest.contributes).toBeDefined()
        expect(manifest.contributes['slot']).toEqual(['composer-container'])
        expect(manifest.contributes['composer']).toEqual(
            expect.arrayContaining([
                'composer-attach',
                'request-approval',
                'context-usage-ring',
                'model-select',
                'files',
                'prompt-preprocessor',
                'skill-preprocessor',
            ]),
        )
        expect(manifest.contributes['action']).toEqual(
            expect.arrayContaining([
                'cycle-reasoning-effort',
                'next-model',
                'previous-model',
                'open-model-selector',
                'open-folder',
                'compact',
            ]),
        )

        // Check real files exist
        const rendererEntryPath = path.join(composerDir, 'renderer', 'index.tsx')
        expect(fs.existsSync(rendererEntryPath)).toBe(true)

        // Entries must use definePluginEntry and must NOT embed manifest
        const rendererCode = fs.readFileSync(rendererEntryPath, 'utf8')
        expect(rendererCode).toContain('definePluginEntry')
        expect(rendererCode).not.toMatch(/manifest:\s*\{/)

        // Ensure scanner reports renderer as real entry
        const report = await scanBundledPluginContracts(repoRoot)
        const composerRealEntries = report.realEntries.filter((e) => e.pluginId === 'cpa.core.composer')
        expect(composerRealEntries.map((e) => e.runtime)).toEqual(['renderer'])

        const composerLegacy = report.legacyEntries.filter((e) => e.pluginId === 'cpa.core.composer')
        expect(composerLegacy).toHaveLength(0)
    })

    it('ensures cpa.core.terminal is fully migrated with real entries, authoritative manifest, and zero legacy adapters', async () => {
        const terminalDir = path.join(repoRoot, 'plugins', 'bundled', 'cpa.core.terminal')
        const manifestPath = path.join(terminalDir, 'manifest.json')
        expect(fs.existsSync(manifestPath)).toBe(true)

        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
        expect(manifest.id).toBe('cpa.core.terminal')
        expect(manifest.entries).toBeDefined()
        expect(manifest.entries.renderer).toBe('./renderer/index.tsx')
        expect(manifest.entries.main).toBeUndefined()
        expect(manifest.entries.agent).toBeUndefined()
        expect(manifest.dependencies).toBeDefined()
        expect(manifest.capabilities).toBeDefined()
        expect(manifest.capabilities).toEqual(
            expect.arrayContaining(['pty.spawn', 'pty.write', 'pty.resize', 'pty.close']),
        )
        expect(manifest.contributes).toBeDefined()
        expect(manifest.contributes['slot']).toEqual(
            expect.arrayContaining(['terminal-content', 'terminal-bottom-tabs']),
        )
        expect(manifest.contributes['panel']).toEqual(['terminal'])
        expect(manifest.contributes['action']).toEqual(
            expect.arrayContaining(['toggle-bottom-panel', 'open-terminal']),
        )

        // Check real files exist
        const rendererEntryPath = path.join(terminalDir, 'renderer', 'index.tsx')
        expect(fs.existsSync(rendererEntryPath)).toBe(true)

        // Entries must use definePluginEntry and must NOT embed manifest
        const rendererCode = fs.readFileSync(rendererEntryPath, 'utf8')
        expect(rendererCode).toContain('definePluginEntry')
        expect(rendererCode).not.toMatch(/manifest:\s*\{/)

        // Ensure scanner reports renderer as real entry
        const report = await scanBundledPluginContracts(repoRoot)
        const terminalRealEntries = report.realEntries.filter((e) => e.pluginId === 'cpa.core.terminal')
        expect(terminalRealEntries.map((e) => e.runtime)).toEqual(['renderer'])

        const terminalLegacy = report.legacyEntries.filter((e) => e.pluginId === 'cpa.core.terminal')
        expect(terminalLegacy).toHaveLength(0)
    })

    it('ensures cpa.core.browser is fully migrated with real entries, authoritative manifest, and zero legacy adapters', async () => {
        const browserDir = path.join(repoRoot, 'plugins', 'bundled', 'cpa.core.browser')
        const manifestPath = path.join(browserDir, 'manifest.json')
        expect(fs.existsSync(manifestPath)).toBe(true)

        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
        expect(manifest.id).toBe('cpa.core.browser')
        expect(manifest.entries).toBeDefined()
        expect(manifest.entries.renderer).toBe('./renderer/index.tsx')
        expect(manifest.entries.main).toBeUndefined()
        expect(manifest.entries.agent).toBeUndefined()
        expect(manifest.dependencies).toBeDefined()
        expect(manifest.capabilities).toBeDefined()
        expect(manifest.capabilities).toEqual(
            expect.arrayContaining(['network.http', 'network.websocket']),
        )
        expect(manifest.contributes).toBeDefined()
        expect(manifest.contributes['panel']).toEqual(['browser'])
        expect(manifest.contributes['action']).toEqual(
            expect.arrayContaining([
                'open-browser-tab',
                'toggle-browser-panel',
                'reload-browser-page',
                'force-reload-browser-page',
                'browser-back',
                'browser-forward',
            ]),
        )

        // Check real files exist
        const rendererEntryPath = path.join(browserDir, 'renderer', 'index.tsx')
        expect(fs.existsSync(rendererEntryPath)).toBe(true)

        // Entries must use definePluginEntry and must NOT embed manifest
        const rendererCode = fs.readFileSync(rendererEntryPath, 'utf8')
        expect(rendererCode).toContain('definePluginEntry')
        expect(rendererCode).not.toMatch(/manifest:\s*\{/)

        // Ensure scanner reports renderer as real entry
        const report = await scanBundledPluginContracts(repoRoot)
        const browserRealEntries = report.realEntries.filter((e) => e.pluginId === 'cpa.core.browser')
        expect(browserRealEntries.map((e) => e.runtime)).toEqual(['renderer'])

        const browserLegacy = report.legacyEntries.filter((e) => e.pluginId === 'cpa.core.browser')
        expect(browserLegacy).toHaveLength(0)
    })

    it('ensures cpa.core.file-manager is fully migrated with real entries, authoritative manifest, and zero legacy adapters', async () => {
        const fileManagerDir = path.join(repoRoot, 'plugins', 'bundled', 'cpa.core.file-manager')
        const manifestPath = path.join(fileManagerDir, 'manifest.json')
        expect(fs.existsSync(manifestPath)).toBe(true)

        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
        expect(manifest.id).toBe('cpa.core.file-manager')
        expect(manifest.entries).toBeDefined()
        expect(manifest.entries.renderer).toBe('./renderer/index.tsx')
        expect(manifest.entries.main).toBeUndefined()
        expect(manifest.entries.agent).toBeUndefined()
        expect(manifest.dependencies).toBeDefined()
        expect(manifest.capabilities).toBeDefined()
        expect(manifest.capabilities).toEqual(
            expect.arrayContaining(['filesystem.read', 'filesystem.write', 'system.clipboard']),
        )
        expect(manifest.contributes).toBeDefined()
        expect(manifest.contributes['panel']).toEqual(['file-manager'])
        expect(manifest.contributes['action']).toEqual(
            expect.arrayContaining([
                'search-files',
                'go-to-line',
                'copy-file-path',
                'reveal-in-file-manager',
            ]),
        )

        // Check real files exist
        const rendererEntryPath = path.join(fileManagerDir, 'renderer', 'index.tsx')
        expect(fs.existsSync(rendererEntryPath)).toBe(true)

        // Entries must use definePluginEntry and must NOT embed manifest
        const rendererCode = fs.readFileSync(rendererEntryPath, 'utf8')
        expect(rendererCode).toContain('definePluginEntry')
        expect(rendererCode).not.toMatch(/manifest:\s*\{/)

        // Ensure scanner reports renderer as real entry
        const report = await scanBundledPluginContracts(repoRoot)
        const fileManagerRealEntries = report.realEntries.filter((e) => e.pluginId === 'cpa.core.file-manager')
        expect(fileManagerRealEntries.map((e) => e.runtime)).toEqual(['renderer'])

        const fileManagerLegacy = report.legacyEntries.filter((e) => e.pluginId === 'cpa.core.file-manager')
        expect(fileManagerLegacy).toHaveLength(0)
    })

    it('ensures cpa.core.review is fully migrated with real renderer entry, authoritative manifest, and zero legacy adapters', async () => {
        const reviewDir = path.join(repoRoot, 'plugins', 'bundled', 'cpa.core.review')
        const manifestPath = path.join(reviewDir, 'manifest.json')
        expect(fs.existsSync(manifestPath)).toBe(true)

        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
        expect(manifest.id).toBe('cpa.core.review')
        expect(manifest.entries).toBeDefined()
        expect(manifest.entries.renderer).toBe('./renderer/index.tsx')
        expect(manifest.entries.main).toBeUndefined()
        expect(manifest.entries.agent).toBeUndefined()
        expect(manifest.dependencies).toBeDefined()
        expect(manifest.capabilities).toBeDefined()
        expect(manifest.capabilities).toEqual(
            expect.arrayContaining(['filesystem.read', 'process.spawn', 'sessions.read']),
        )
        expect(manifest.contributes).toBeDefined()
        expect(manifest.contributes['panel']).toEqual(['review'])
        expect(manifest.contributes['action']).toEqual(
            expect.arrayContaining(['open-review-tab', 'toggle-review-panel']),
        )
        expect(manifest.contributes['chat-renderer']).toEqual(['review-diff-tool-card'])

        // Check real file exists
        const rendererEntryPath = path.join(reviewDir, 'renderer', 'index.tsx')
        expect(fs.existsSync(rendererEntryPath)).toBe(true)

        // Entries must use definePluginEntry and must NOT embed manifest
        const rendererCode = fs.readFileSync(rendererEntryPath, 'utf8')
        expect(rendererCode).toContain('definePluginEntry')
        expect(rendererCode).not.toMatch(/manifest:\s*\{/)

        // Ensure scanner reports renderer as real entry
        const report = await scanBundledPluginContracts(repoRoot)
        const reviewRealEntries = report.realEntries.filter((e) => e.pluginId === 'cpa.core.review')
        expect(reviewRealEntries.map((e) => e.runtime)).toEqual(['renderer'])

        const reviewLegacy = report.legacyEntries.filter((e) => e.pluginId === 'cpa.core.review')
        expect(reviewLegacy).toHaveLength(0)
    })

    it('ensures cpa.core.subagent is fully migrated with real renderer and agent entries, authoritative manifest, and zero legacy adapters', async () => {
        const subagentDir = path.join(repoRoot, 'plugins', 'bundled', 'cpa.core.subagent')
        const manifestPath = path.join(subagentDir, 'manifest.json')
        expect(fs.existsSync(manifestPath)).toBe(true)

        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
        expect(manifest.id).toBe('cpa.core.subagent')
        expect(manifest.entries).toBeDefined()
        expect(manifest.entries.renderer).toBe('./renderer/index.tsx')
        expect(manifest.entries.agent).toBe('./agent/index.ts')
        expect(manifest.entries.main).toBeUndefined()
        expect(manifest.dependencies).toBeDefined()
        expect(manifest.capabilities).toBeDefined()
        expect(manifest.capabilities).toEqual(
            expect.arrayContaining(['agent.subagents', 'sessions.read']),
        )
        expect(manifest.contributes).toBeDefined()
        expect(manifest.contributes['slot']).toEqual([
            'subagent-content',
            'subagent-pills-slot',
            'pinned-summary-subagents',
        ])
        expect(manifest.contributes['panel']).toEqual(['subagent'])
        expect(manifest.contributes['settings']).toEqual(['subagents'])
        expect(manifest.contributes['action']).toEqual(
            expect.arrayContaining(['toggle-activity-view', 'show-pet']),
        )
        expect(manifest.contributes['chat-renderer']).toEqual(['subagent-pills'])
        expect(manifest.contributes['tool-factory']).toEqual(
            expect.arrayContaining(['spawn_agent', 'send_message', 'stop_agent']),
        )

        // Check real files exist
        const rendererEntryPath = path.join(subagentDir, 'renderer', 'index.tsx')
        const agentEntryPath = path.join(subagentDir, 'agent', 'index.ts')
        expect(fs.existsSync(rendererEntryPath)).toBe(true)
        expect(fs.existsSync(agentEntryPath)).toBe(true)

        // Entries must use definePluginEntry and must NOT embed manifest
        const rendererCode = fs.readFileSync(rendererEntryPath, 'utf8')
        const agentCode = fs.readFileSync(agentEntryPath, 'utf8')
        expect(rendererCode).toContain('definePluginEntry')
        expect(agentCode).toContain('definePluginEntry')
        expect(rendererCode).not.toMatch(/manifest:\s*\{/)
        expect(agentCode).not.toMatch(/manifest:\s*\{/)

        // Ensure scanner reports renderer and agent as real entries
        const report = await scanBundledPluginContracts(repoRoot)
        const subagentRealEntries = report.realEntries.filter((e) => e.pluginId === 'cpa.core.subagent')
        expect(subagentRealEntries.map((e) => e.runtime).sort()).toEqual(['agent', 'renderer'])

        const subagentLegacy = report.legacyEntries.filter((e) => e.pluginId === 'cpa.core.subagent')
        expect(subagentLegacy).toHaveLength(0)
    })

    it('ensures cpa.core.tools is fully migrated with real agent entry, authoritative manifest, and zero legacy adapters', async () => {
        const toolsDir = path.join(repoRoot, 'plugins', 'bundled', 'cpa.core.tools')
        const manifestPath = path.join(toolsDir, 'manifest.json')
        expect(fs.existsSync(manifestPath)).toBe(true)

        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
        expect(manifest.id).toBe('cpa.core.tools')
        expect(manifest.entries).toBeDefined()
        expect(manifest.entries.agent).toBe('./agent/index.ts')
        expect(manifest.entries.renderer).toBeUndefined()
        expect(manifest.entries.main).toBeUndefined()
        expect(manifest.dependencies).toBeDefined()
        expect(manifest.capabilities).toBeDefined()
        expect(manifest.capabilities).toEqual(
            expect.arrayContaining(['filesystem.*', 'process.spawn']),
        )
        expect(manifest.contributes).toBeDefined()
        expect(manifest.contributes['tool-factory']).toEqual(
            expect.arrayContaining(['read', 'shell', 'edit', 'write']),
        )

        // Check real file exists
        const agentEntryPath = path.join(toolsDir, 'agent', 'index.ts')
        expect(fs.existsSync(agentEntryPath)).toBe(true)

        // Entry must use definePluginEntry and must NOT embed manifest
        const agentCode = fs.readFileSync(agentEntryPath, 'utf8')
        expect(agentCode).toContain('definePluginEntry')
        expect(agentCode).not.toMatch(/manifest:\s*\{/)

        // Ensure scanner reports agent as real entry
        const report = await scanBundledPluginContracts(repoRoot)
        const toolsRealEntries = report.realEntries.filter((e) => e.pluginId === 'cpa.core.tools')
        expect(toolsRealEntries.map((e) => e.runtime)).toEqual(['agent'])

        const toolsLegacy = report.legacyEntries.filter((e) => e.pluginId === 'cpa.core.tools')
        expect(toolsLegacy).toHaveLength(0)
    })

    it('ensures cpa.core.resources is fully migrated with real agent entry, authoritative manifest, and zero legacy adapters', async () => {
        const resourcesDir = path.join(repoRoot, 'plugins', 'bundled', 'cpa.core.resources')
        const manifestPath = path.join(resourcesDir, 'manifest.json')
        expect(fs.existsSync(manifestPath)).toBe(true)

        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
        expect(manifest.id).toBe('cpa.core.resources')
        expect(manifest.entries).toBeDefined()
        expect(manifest.entries.agent).toBe('./agent/index.ts')
        expect(manifest.entries.renderer).toBeUndefined()
        expect(manifest.entries.main).toBeUndefined()
        expect(manifest.dependencies).toBeDefined()
        expect(manifest.capabilities).toBeDefined()
        expect(manifest.capabilities).toEqual(
            expect.arrayContaining(['filesystem.read']),
        )
        expect(manifest.contributes).toBeDefined()
        expect(manifest.contributes['resource-provider']).toEqual(
            expect.arrayContaining(['cpa.core.context', 'cpa.core.skills', 'cpa.core.prompt-templates']),
        )

        // Check real file exists
        const agentEntryPath = path.join(resourcesDir, 'agent', 'index.ts')
        expect(fs.existsSync(agentEntryPath)).toBe(true)

        // Entry must use definePluginEntry and must NOT embed manifest
        const agentCode = fs.readFileSync(agentEntryPath, 'utf8')
        expect(agentCode).toContain('definePluginEntry')
        expect(agentCode).not.toMatch(/manifest:\s*\{/)

        // Ensure scanner reports agent as real entry
        const report = await scanBundledPluginContracts(repoRoot)
        const resourcesRealEntries = report.realEntries.filter((e) => e.pluginId === 'cpa.core.resources')
        expect(resourcesRealEntries.map((e) => e.runtime)).toEqual(['agent'])

        const resourcesLegacy = report.legacyEntries.filter((e) => e.pluginId === 'cpa.core.resources')
        expect(resourcesLegacy).toHaveLength(0)
    })

    it('ensures cpa.core.hooks is fully migrated with real renderer and agent entries, authoritative manifest, and zero legacy adapters', async () => {
        const hooksDir = path.join(repoRoot, 'plugins', 'bundled', 'cpa.core.hooks')
        const manifestPath = path.join(hooksDir, 'manifest.json')
        expect(fs.existsSync(manifestPath)).toBe(true)

        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
        expect(manifest.id).toBe('cpa.core.hooks')
        expect(manifest.entries).toBeDefined()
        expect(manifest.entries.renderer).toBe('./renderer/index.tsx')
        expect(manifest.entries.agent).toBe('./agent/index.ts')
        expect(manifest.entries.main).toBeUndefined()
        expect(manifest.dependencies).toBeDefined()
        expect(manifest.capabilities).toBeDefined()
        expect(manifest.capabilities).toEqual(
            expect.arrayContaining(['filesystem.read', 'filesystem.write', 'process.spawn']),
        )
        expect(manifest.contributes).toBeDefined()
        expect(manifest.contributes['settings']).toEqual(['hooks'])
        expect(manifest.contributes['hook']).toEqual([
            'SessionStart',
            'UserPromptSubmit',
            'PreToolUse',
            'PermissionRequest',
            'PostToolUse',
            'PreCompact',
            'PostCompact',
            'SubagentStart',
            'SubagentStop',
            'Stop',
            'SessionEnd',
        ])

        // Check real files exist
        const rendererEntryPath = path.join(hooksDir, 'renderer', 'index.tsx')
        const agentEntryPath = path.join(hooksDir, 'agent', 'index.ts')
        expect(fs.existsSync(rendererEntryPath)).toBe(true)
        expect(fs.existsSync(agentEntryPath)).toBe(true)

        // Entries must use definePluginEntry and must NOT embed manifest
        const rendererCode = fs.readFileSync(rendererEntryPath, 'utf8')
        const agentCode = fs.readFileSync(agentEntryPath, 'utf8')
        expect(rendererCode).toContain('definePluginEntry')
        expect(agentCode).toContain('definePluginEntry')
        expect(rendererCode).not.toMatch(/manifest:\s*\{/)
        expect(agentCode).not.toMatch(/manifest:\s*\{/)

        // Ensure scanner reports renderer and agent as real entries
        const report = await scanBundledPluginContracts(repoRoot)
        const hooksRealEntries = report.realEntries.filter((e) => e.pluginId === 'cpa.core.hooks')
        expect(hooksRealEntries.map((e) => e.runtime).sort()).toEqual(['agent', 'renderer'])

        const hooksLegacy = report.legacyEntries.filter((e) => e.pluginId === 'cpa.core.hooks')
        expect(hooksLegacy).toHaveLength(0)
    })

    it('ensures cpa.core.ask is fully migrated with real renderer and agent entries, authoritative manifest, and zero legacy adapters', async () => {
        const askDir = path.join(repoRoot, 'plugins', 'bundled', 'cpa.core.ask')
        const manifestPath = path.join(askDir, 'manifest.json')
        expect(fs.existsSync(manifestPath)).toBe(true)

        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
        expect(manifest.id).toBe('cpa.core.ask')
        expect(manifest.entries).toBeDefined()
        expect(manifest.entries.renderer).toBe('./renderer/index.tsx')
        expect(manifest.entries.agent).toBe('./agent/index.ts')
        expect(manifest.entries.main).toBeUndefined()
        expect(manifest.dependencies).toBeDefined()
        expect(manifest.capabilities).toBeDefined()
        expect(manifest.capabilities).toContain('ui.overlay')
        expect(manifest.contributes).toBeDefined()
        expect(manifest.contributes['floating']).toEqual(['ask-overlay'])
        expect(manifest.contributes['tool-factory']).toEqual(['ask'])

        // Check real files exist
        const rendererEntryPath = path.join(askDir, 'renderer', 'index.tsx')
        const agentEntryPath = path.join(askDir, 'agent', 'index.ts')
        expect(fs.existsSync(rendererEntryPath)).toBe(true)
        expect(fs.existsSync(agentEntryPath)).toBe(true)

        // Entries must use definePluginEntry and must NOT embed manifest
        const rendererCode = fs.readFileSync(rendererEntryPath, 'utf8')
        const agentCode = fs.readFileSync(agentEntryPath, 'utf8')
        expect(rendererCode).toContain('definePluginEntry')
        expect(agentCode).toContain('definePluginEntry')
        expect(rendererCode).not.toMatch(/manifest:\s*\{/)
        expect(agentCode).not.toMatch(/manifest:\s*\{/)

        // Ensure scanner reports renderer and agent as real entries
        const report = await scanBundledPluginContracts(repoRoot)
        const askRealEntries = report.realEntries.filter((e) => e.pluginId === 'cpa.core.ask')
        expect(askRealEntries.map((e) => e.runtime).sort()).toEqual(['agent', 'renderer'])

        const askLegacy = report.legacyEntries.filter((e) => e.pluginId === 'cpa.core.ask')
        expect(askLegacy).toHaveLength(0)
    })

    it('ensures cpa.core.manage-todo-list is fully migrated with real renderer and agent entries, authoritative manifest, and zero legacy adapters', async () => {
        const todoDir = path.join(repoRoot, 'plugins', 'bundled', 'cpa.core.manage-todo-list')
        const manifestPath = path.join(todoDir, 'manifest.json')
        expect(fs.existsSync(manifestPath)).toBe(true)

        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
        expect(manifest.id).toBe('cpa.core.manage-todo-list')
        expect(manifest.entries).toBeDefined()
        expect(manifest.entries.renderer).toBe('./renderer/index.tsx')
        expect(manifest.entries.agent).toBe('./agent/index.ts')
        expect(manifest.entries.main).toBeUndefined()
        expect(manifest.dependencies).toBeDefined()
        expect(manifest.capabilities).toBeDefined()
        expect(manifest.capabilities).toContain('sessions.read')
        expect(manifest.contributes).toBeDefined()
        expect(manifest.contributes['tool-factory']).toEqual(['todo'])
        expect(manifest.contributes['floating']).toEqual(['todo-progress-bar'])
        expect(manifest.contributes['chat-renderer']).toEqual(['manage-todo-list-tool-card'])

        // Check real files exist
        const rendererEntryPath = path.join(todoDir, 'renderer', 'index.tsx')
        const agentEntryPath = path.join(todoDir, 'agent', 'index.ts')
        expect(fs.existsSync(rendererEntryPath)).toBe(true)
        expect(fs.existsSync(agentEntryPath)).toBe(true)

        // Entries must use definePluginEntry and must NOT embed manifest
        const rendererCode = fs.readFileSync(rendererEntryPath, 'utf8')
        const agentCode = fs.readFileSync(agentEntryPath, 'utf8')
        expect(rendererCode).toContain('definePluginEntry')
        expect(agentCode).toContain('definePluginEntry')
        expect(rendererCode).not.toMatch(/manifest:\s*\{/)
        expect(agentCode).not.toMatch(/manifest:\s*\{/)

        // Ensure scanner reports renderer and agent as real entries
        const report = await scanBundledPluginContracts(repoRoot)
        const todoRealEntries = report.realEntries.filter((e) => e.pluginId === 'cpa.core.manage-todo-list')
        expect(todoRealEntries.map((e) => e.runtime).sort()).toEqual(['agent', 'renderer'])

        const todoLegacy = report.legacyEntries.filter((e) => e.pluginId === 'cpa.core.manage-todo-list')
        expect(todoLegacy).toHaveLength(0)
    })

    it('ensures cpa.core.memories is fully migrated with real renderer and agent entries, authoritative manifest, and zero legacy adapters', async () => {
        const memoriesDir = path.join(repoRoot, 'plugins', 'bundled', 'cpa.core.memories')
        const manifestPath = path.join(memoriesDir, 'manifest.json')
        expect(fs.existsSync(manifestPath)).toBe(true)

        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
        expect(manifest.id).toBe('cpa.core.memories')
        expect(manifest.entries).toBeDefined()
        expect(manifest.entries.renderer).toBe('./renderer/index.tsx')
        expect(manifest.entries.agent).toBe('./agent/index.ts')
        expect(manifest.entries.main).toBeUndefined()
        expect(manifest.dependencies).toBeDefined()
        expect(manifest.capabilities).toBeDefined()
        expect(manifest.capabilities).toEqual(
            expect.arrayContaining(['filesystem.read', 'filesystem.write']),
        )
        expect(manifest.contributes).toBeDefined()
        expect(manifest.contributes['tool-factory']).toEqual(
            expect.arrayContaining([
                'memories_list',
                'memories_read',
                'memories_search',
                'memories_add_ad_hoc_note',
            ]),
        )
        expect(manifest.contributes['resource-provider']).toEqual(['cpa.core.memories'])
        expect(manifest.contributes['component-wrapper']).toEqual(['cpa.memories.personalization-wrapper'])

        // Check real files exist
        const rendererEntryPath = path.join(memoriesDir, 'renderer', 'index.tsx')
        const agentEntryPath = path.join(memoriesDir, 'agent', 'index.ts')
        expect(fs.existsSync(rendererEntryPath)).toBe(true)
        expect(fs.existsSync(agentEntryPath)).toBe(true)

        // Entries must use definePluginEntry and must NOT embed manifest
        const rendererCode = fs.readFileSync(rendererEntryPath, 'utf8')
        const agentCode = fs.readFileSync(agentEntryPath, 'utf8')
        expect(rendererCode).toContain('definePluginEntry')
        expect(agentCode).toContain('definePluginEntry')
        expect(rendererCode).not.toMatch(/manifest:\s*\{/)
        expect(agentCode).not.toMatch(/manifest:\s*\{/)

        // Ensure scanner reports renderer and agent as real entries
        const report = await scanBundledPluginContracts(repoRoot)
        const memoriesRealEntries = report.realEntries.filter((e) => e.pluginId === 'cpa.core.memories')
        expect(memoriesRealEntries.map((e) => e.runtime).sort()).toEqual(['agent', 'renderer'])

        const memoriesLegacy = report.legacyEntries.filter((e) => e.pluginId === 'cpa.core.memories')
        expect(memoriesLegacy).toHaveLength(0)
    })

    it('ensures cpa.core.protocol-codex is fully migrated with real renderer and agent entries, authoritative manifest, and zero legacy adapters', async () => {
        const codexDir = path.join(repoRoot, 'plugins', 'bundled', 'cpa.core.protocol-codex')
        const manifestPath = path.join(codexDir, 'manifest.json')
        expect(fs.existsSync(manifestPath)).toBe(true)

        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
        expect(manifest.id).toBe('cpa.core.protocol-codex')
        expect(manifest.entries).toBeDefined()
        expect(manifest.entries.renderer).toBe('./renderer/index.tsx')
        expect(manifest.entries.agent).toBe('./agent/index.ts')
        expect(manifest.entries.main).toBeUndefined()
        expect(manifest.dependencies).toBeDefined()
        expect(manifest.capabilities).toBeDefined()
        expect(manifest.capabilities).toEqual(
            expect.arrayContaining(['network.http', 'network.websocket', 'models.read']),
        )
        expect(manifest.contributes).toBeDefined()
        expect(manifest.contributes['protocol']).toEqual(['codex-responses-ws'])
        expect(manifest.contributes['model-catalog']).toEqual(['cliproxyapi'])
        expect(manifest.contributes['settings']).toEqual(['models'])

        // Check real files exist
        const rendererEntryPath = path.join(codexDir, 'renderer', 'index.tsx')
        const agentEntryPath = path.join(codexDir, 'agent', 'index.ts')
        expect(fs.existsSync(rendererEntryPath)).toBe(true)
        expect(fs.existsSync(agentEntryPath)).toBe(true)

        // Entries must use definePluginEntry and must NOT embed manifest
        const rendererCode = fs.readFileSync(rendererEntryPath, 'utf8')
        const agentCode = fs.readFileSync(agentEntryPath, 'utf8')
        expect(rendererCode).toContain('definePluginEntry')
        expect(agentCode).toContain('definePluginEntry')
        expect(rendererCode).not.toMatch(/manifest:\s*\{/)
        expect(agentCode).not.toMatch(/manifest:\s*\{/)

        // Ensure scanner reports renderer and agent as real entries
        const report = await scanBundledPluginContracts(repoRoot)
        const codexRealEntries = report.realEntries.filter((e) => e.pluginId === 'cpa.core.protocol-codex')
        expect(codexRealEntries.map((e) => e.runtime).sort()).toEqual(['agent', 'renderer'])

        const codexLegacy = report.legacyEntries.filter((e) => e.pluginId === 'cpa.core.protocol-codex')
        expect(codexLegacy).toHaveLength(0)
    })

    it('ensures cpa.core.file-changes is fully migrated with real renderer entry, authoritative manifest, and zero legacy adapters', async () => {
        const fileChangesDir = path.join(repoRoot, 'plugins', 'bundled', 'cpa.core.file-changes')
        const manifestPath = path.join(fileChangesDir, 'manifest.json')
        expect(fs.existsSync(manifestPath)).toBe(true)

        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
        expect(manifest.id).toBe('cpa.core.file-changes')
        expect(manifest.entries).toBeDefined()
        expect(manifest.entries.renderer).toBe('./renderer/index.tsx')
        expect(manifest.entries.main).toBeUndefined()
        expect(manifest.entries.agent).toBeUndefined()
        expect(manifest.dependencies).toBeDefined()
        expect(manifest.capabilities).toBeDefined()
        expect(manifest.capabilities).toContain('filesystem.read')
        expect(manifest.contributes).toBeDefined()
        expect(manifest.contributes['chat-renderer']).toEqual(['file-changes-tool-card'])

        // Check real files exist
        const rendererEntryPath = path.join(fileChangesDir, 'renderer', 'index.tsx')
        expect(fs.existsSync(rendererEntryPath)).toBe(true)

        // Entries must use definePluginEntry and must NOT embed manifest
        const rendererCode = fs.readFileSync(rendererEntryPath, 'utf8')
        expect(rendererCode).toContain('definePluginEntry')
        expect(rendererCode).not.toMatch(/manifest:\s*\{/)

        // Ensure scanner reports renderer as real entry
        const report = await scanBundledPluginContracts(repoRoot)
        const fileChangesRealEntries = report.realEntries.filter((e) => e.pluginId === 'cpa.core.file-changes')
        expect(fileChangesRealEntries.map((e) => e.runtime)).toEqual(['renderer'])

        const fileChangesLegacy = report.legacyEntries.filter((e) => e.pluginId === 'cpa.core.file-changes')
        expect(fileChangesLegacy).toHaveLength(0)
    })

    it('ensures generated loader files exist and do not copy manifest JSON', () => {
        const rendererLoadersPath = path.join(
            repoRoot,
            'frontend',
            'src',
            'plugins',
            'generated',
            'bundledPluginLoaders.ts',
        )
        const mainLoadersPath = path.join(
            repoRoot,
            'src',
            'main',
            'plugins',
            'generated',
            'bundledPluginLoaders.ts',
        )

        expect(fs.existsSync(rendererLoadersPath)).toBe(true)
        expect(fs.existsSync(mainLoadersPath)).toBe(true)

        const rendererContent = fs.readFileSync(rendererLoadersPath, 'utf8')
        const mainContent = fs.readFileSync(mainLoadersPath, 'utf8')

        // Neither file should embed serialized manifest copies or bundledPluginPackages
        expect(rendererContent).not.toContain('bundledPluginPackages')
        expect(mainContent).not.toContain('bundledPluginPackages')
        expect(rendererContent).toContain('bundledRendererEntryLoaders')
        expect(mainContent).toContain('bundledMainEntryLoaders')
    })

    it('enforces vitest runner discovery contract: every bundled plugin test is matched by exactly one runner', () => {
        // Collect all test files under plugins/bundled/
        const bundledDir = path.join(repoRoot, 'plugins', 'bundled')
        const allTestFiles: string[] = []

        function walk(dir: string) {
            const entries = fs.readdirSync(dir, { withFileTypes: true })
            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name)
                if (entry.isDirectory()) {
                    walk(fullPath)
                } else if (/\.test\.(ts|tsx)$/.test(entry.name)) {
                    allTestFiles.push(path.relative(repoRoot, fullPath))
                }
            }
        }
        walk(bundledDir)

        expect(allTestFiles.length).toBeGreaterThan(0)

        // Read vitest configs
        const electronConfig = fs.readFileSync(path.join(repoRoot, 'vitest.electron.config.ts'), 'utf8')
        const frontendConfig = fs.readFileSync(path.join(repoRoot, 'frontend', 'vitest.config.ts'), 'utf8')

        // Assert electron config includes main plugin tests but NOT agent or renderer plugin tests
        expect(electronConfig).toContain('plugins/bundled/**/main/**/*.test.ts')
        expect(electronConfig).not.toContain('plugins/bundled/**/agent/**/*.test.ts')
        expect(electronConfig).not.toContain('plugins/bundled/**/renderer/**/*.test')

        // Assert frontend config includes renderer and agent plugin tests but NOT main plugin tests
        expect(frontendConfig).toContain('../plugins/bundled/**/renderer/**/*.test.{ts,tsx}')
        expect(frontendConfig).toContain('../plugins/bundled/**/agent/**/*.test.{ts,tsx}')
        expect(frontendConfig).not.toContain('../plugins/bundled/**/main/**/*.test')

        // Verify every test file maps cleanly to exactly one runner category
        for (const file of allTestFiles) {
            const isMain = file.includes('/main/')
            const isRenderer = file.includes('/renderer/')
            const isAgent = file.includes('/agent/')

            const matchCount = (isMain ? 1 : 0) + (isRenderer ? 1 : 0) + (isAgent ? 1 : 0)
            expect(matchCount, `File ${file} must belong to exactly one runtime category`).toBe(1)
        }
    })
})
