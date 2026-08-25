import { describe, expect, it } from 'vitest'
import { scanPluginArchitecture, findCycles } from '../scripts/plugin-architecture-report.mjs'

describe('Universal Plugin Platform - Architecture Boundary Scanner', () => {
    describe('Core and Plugin Import Rules', () => {
        it('reports host-to-plugin and cross-plugin imports in legacy fixtures', async () => {
            const report = await scanPluginArchitecture('test/fixtures/plugin-architecture')
            expect(report.hostImportsPlugin.length).toBeGreaterThanOrEqual(1)
            expect(report.crossPluginImports.length).toBeGreaterThanOrEqual(1)
        })

        it('reports core plugin private imports with zero exemptions', async () => {
            const report = await scanPluginArchitecture('test/fixtures/plugin-architecture/core-private-imports')
            expect(report.privateHostImports.length).toBeGreaterThanOrEqual(1)
            const violation = report.privateHostImports.find((v: any) => v.file.includes('cpa.core.sample'))
            expect(violation).toBeDefined()
            expect(violation.pluginId).toBe('cpa.core.sample')
        })
    })

    describe('Direct Native Access Rules', () => {
        it('detects window.electronBridge, globalThis aliases, electron imports, and Node fs in plugins', async () => {
            const report = await scanPluginArchitecture('test/fixtures/plugin-architecture/direct-native-access')
            expect(report.directNativeAccess).toBeDefined()
            expect(report.directNativeAccess.length).toBeGreaterThanOrEqual(4)

            const files = report.directNativeAccess.map((v: any) => v.file)
            expect(files.some((f: string) => f.includes('direct-window.ts'))).toBe(true)
            expect(files.some((f: string) => f.includes('window-alias.ts'))).toBe(true)
            expect(files.some((f: string) => f.includes('globalthis-alias.ts'))).toBe(true)
            expect(files.some((f: string) => f.includes('electron-import.ts'))).toBe(true)
            expect(files.some((f: string) => f.includes('node-fs-import.ts'))).toBe(true)
        })

        it('detects alias/chain taint and destructuring with renames in plugins', async () => {
            const report = await scanPluginArchitecture('test/fixtures/plugin-architecture/direct-native-access')
            const aliasChainViolations = report.directNativeAccess.filter((v: any) => v.file.includes('alias-chain.ts'))
            expect(aliasChainViolations.length).toBeGreaterThanOrEqual(4)
        })

        it('detects element access, template literals, string concatenation, and dynamic computed global access in plugins', async () => {
            const report = await scanPluginArchitecture('test/fixtures/plugin-architecture/direct-native-access')
            const computedViolations = report.directNativeAccess.filter((v: any) => v.file.includes('computed-access.ts'))
            expect(computedViolations.length).toBeGreaterThanOrEqual(4)
        })

        it('detects require aliases, eval require, process.getBuiltinModule, new Function, and unsafe dynamic imports in plugins', async () => {
            const report = await scanPluginArchitecture('test/fixtures/plugin-architecture/direct-native-access')
            const dynamicViolations = report.directNativeAccess.filter((v: any) => v.file.includes('dynamic-eval-require.ts'))
            expect(dynamicViolations.length).toBeGreaterThanOrEqual(5)
        })
    })

    describe('Dynamic Contribution ID Hardcoding Rules', () => {
        it('dynamically collects contribution IDs from manifests and detects host comparisons, switches, and lookups', async () => {
            const report = await scanPluginArchitecture('test/fixtures/plugin-architecture/hardcoded-contributions')
            expect(report.hardcodedContributionIds).toBeDefined()
            expect(report.hardcodedContributionIds.length).toBeGreaterThanOrEqual(3)

            const ids = report.hardcodedContributionIds.map((v: any) => v.contributionId || v.pluginId)
            expect(ids).toContain('custom-matrix-view')
            expect(ids).toContain('custom-matrix-action')
            expect(ids).toContain('custom-matrix-panel')
        })

        it('detects hardcoded contribution IDs via in-file constant propagation and dataflow', async () => {
            const report = await scanPluginArchitecture('test/fixtures/plugin-architecture/hardcoded-contributions')
            const dataflowViolations = report.hardcodedContributionIds.filter((v: any) => v.file.includes('host-dataflow-lookup.ts'))
            expect(dataflowViolations.length).toBeGreaterThanOrEqual(3)
        })
    })

    describe('Manifest Contract Rules', () => {
        it('validates manifests for unknown fields, missing entries, duplicate caps/contributes, and undeclared registrations', async () => {
            const report = await scanPluginArchitecture('test/fixtures/plugin-architecture/manifest-contract')
            expect(report.manifestContract).toBeDefined()
            expect(report.manifestContract.length).toBeGreaterThanOrEqual(4)

            const messages = report.manifestContract.map((v: any) => v.message)
            expect(messages.some((m: string) => m.includes('unknown') || m.includes('rogueSecretKey'))).toBe(true)
            expect(messages.some((m: string) => m.includes('missing') || m.includes('does-not-exist'))).toBe(true)
            expect(messages.some((m: string) => m.includes('duplicate') || m.includes('filesystem.read'))).toBe(true)
            expect(messages.some((m: string) => m.includes('duplicate') || m.includes('dup-view'))).toBe(true)
            expect(messages.some((m: string) => m.includes('undeclared') || m.includes('undeclared-view'))).toBe(true)
        })

        it('detects undeclared contributions wrapped in loops, forEach, helper functions, and object spread', async () => {
            const report = await scanPluginArchitecture('test/fixtures/plugin-architecture/manifest-contract/plugins/cpa.bad.loop-helper-contrib')
            const messages = report.manifestContract.map((v: any) => v.message)
            expect(messages.some((m: string) => m.includes('undeclared-loop-view'))).toBe(true)
            expect(messages.some((m: string) => m.includes('undeclared-array-view'))).toBe(true)
            expect(messages.some((m: string) => m.includes('undeclared-helper-view'))).toBe(true)
            expect(messages.some((m: string) => m.includes('undeclared-spread-view'))).toBe(true)
        })
    })

    describe('Store Effects & Purity Rules', () => {
        it('detects forbidden I/O, native bridge access, and UI component imports in stores', async () => {
            const report = await scanPluginArchitecture('test/fixtures/plugin-architecture/store-effects')
            expect(report.storeEffects).toBeDefined()
            expect(report.storeEffects.length).toBeGreaterThanOrEqual(3)

            const files = report.storeEffects.map((v: any) => v.file)
            expect(files.some((f: string) => f.includes('badIoStore.ts'))).toBe(true)
            expect(files.some((f: string) => f.includes('badBridgeStore.ts'))).toBe(true)
            expect(files.some((f: string) => f.includes('badUiImportStore.ts'))).toBe(true)
            expect(files.some((f: string) => f.includes('goodStore.ts'))).toBe(false)
        })

        it('detects HostServices imports, timers, and storage operations in stores', async () => {
            const report = await scanPluginArchitecture('test/fixtures/plugin-architecture/store-effects')
            const timerViolations = report.storeEffects.filter((v: any) => v.file.includes('badTimerAsyncStore.ts'))
            expect(timerViolations.length).toBeGreaterThanOrEqual(3)
        })
    })

    describe('Legacy Paths and Patterns Rules', () => {
        it('detects deprecated definePlugin and legacy fallback symbol patterns', async () => {
            const report = await scanPluginArchitecture('test/fixtures/plugin-architecture/legacy-paths')
            expect(report.legacyPaths).toBeDefined()
            expect(report.legacyPaths.length).toBeGreaterThanOrEqual(2)

            const files = report.legacyPaths.map((v: any) => v.file)
            expect(files.some((f: string) => f.includes('legacyApiUsage.ts'))).toBe(true)
            expect(files.some((f: string) => f.includes('legacySymbolUsage.ts'))).toBe(true)
        })
    })

    describe('Tarjan SCC Cycle Detection', () => {
        it('detects cycle in fixture files', async () => {
            const report = await scanPluginArchitecture('test/fixtures/plugin-architecture/cycles')
            expect(report.cycles).toBeDefined()
            expect(report.cycles.length).toBe(1)
            expect(report.cycles[0]).toHaveLength(3)
        })

        it('detects cycles using Tarjan SCC algorithm on unit graph', () => {
            const graph = new Map<string, string[]>([
                ['a.ts', ['b.ts']],
                ['b.ts', ['c.ts']],
                ['c.ts', ['a.ts', 'd.ts']],
                ['d.ts', []],
            ])

            const cycles = findCycles(graph)
            expect(cycles).toHaveLength(1)
            expect(cycles[0].sort()).toEqual(['a.ts', 'b.ts', 'c.ts'])
        })

        it('returns empty cycles for an acyclic graph', () => {
            const graph = new Map<string, string[]>([
                ['a.ts', ['b.ts']],
                ['b.ts', ['c.ts']],
                ['c.ts', []],
            ])

            const cycles = findCycles(graph)
            expect(cycles).toHaveLength(0)
        })

        it('excludes type-only imports and type-only exports from cycles (0 cycles)', async () => {
            const report = await scanPluginArchitecture('test/fixtures/plugin-architecture/cycles-type-only')
            expect(report.cycles).toHaveLength(0)
        })
    })

    describe('Generated Loader Boundaries', () => {
        it('flags forged header loader in unauthorized directory as host/violation', async () => {
            const report = await scanPluginArchitecture('test/fixtures/plugin-architecture/generated-loaders')
            expect(report.hostImportsPlugin.length + report.directNativeAccess.length + report.summary.totalViolations).toBeGreaterThanOrEqual(1)
        })
    })

    describe('Production Codebase Compliance', () => {
        it('scans the entire project root with 0 violations across all categories', async () => {
            const report = await scanPluginArchitecture('.')
            expect(report).toBeDefined()

            expect(report.hostImportsPlugin).toEqual([])
            expect(report.crossPluginImports).toEqual([])
            expect(report.privateHostImports).toEqual([])
            expect(report.directNativeAccess).toEqual([])
            expect(report.hardcodedContributionIds).toEqual([])
            expect(report.manifestContract).toEqual([])
            expect(report.storeEffects).toEqual([])
            expect(report.legacyPaths).toEqual([])
            expect(report.cycles).toEqual([])

            expect(report.summary.filesScanned).toBeGreaterThan(500)
            expect(report.summary.totalViolations).toBe(0)
        })
    })
})
