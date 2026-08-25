import { describe, expect, it } from 'vitest'
import type { ResolvedPluginPackage } from '@cpa/plugin-api'
import { PluginCatalog } from './PluginCatalog.js'

function createPkg(
    id: string,
    options?: {
        version?: string
        cpaEngine?: string
        dependencies?: Record<string, string>
        optionalDependencies?: Record<string, string>
        priority?: number
    },
): ResolvedPluginPackage {
    return {
        manifest: {
            id,
            name: id,
            version: options?.version ?? '1.0.0',
            apiVersion: '1',
            engines: {
                cpa: options?.cpaEngine ?? '^1.0.0',
            },
            dependencies: options?.dependencies,
            optionalDependencies: options?.optionalDependencies,
            activationPriority: options?.priority,
        },
        source: {
            kind: 'bundled',
            spec: `bundled:${id}`,
        },
        sourceRoot: `/plugins/${id}`,
        entries: {},
    }
}

describe('PluginCatalog', () => {
    it('initializes with packages, enabled ids, and cpa version', () => {
        const pkgA = createPkg('plugin-a')
        const pkgB = createPkg('plugin-b')
        const catalog = new PluginCatalog({
            cpaVersion: '1.0.0',
            packages: [pkgA, pkgB],
            enabledPluginIds: ['plugin-a'],
        })

        expect(catalog.getCpaVersion()).toBe('1.0.0')
        expect(catalog.getPackages()).toHaveLength(2)
        expect(catalog.getPackage('plugin-a')).toEqual(pkgA)
        expect(catalog.getPackage('plugin-b')).toEqual(pkgB)
        expect(catalog.hasPackage('plugin-a')).toBe(true)
        expect(catalog.hasPackage('nonexistent')).toBe(false)
        expect(catalog.isEnabled('plugin-a')).toBe(true)
        expect(catalog.isEnabled('plugin-b')).toBe(false)
    })

    it('allows adding, removing, and updating packages', () => {
        const catalog = new PluginCatalog({ cpaVersion: '1.0.0' })
        const pkgA = createPkg('plugin-a')

        catalog.addPackage(pkgA)
        expect(catalog.hasPackage('plugin-a')).toBe(true)
        expect(catalog.getPackages()).toHaveLength(1)

        const removed = catalog.removePackage('plugin-a')
        expect(removed).toBe(true)
        expect(catalog.hasPackage('plugin-a')).toBe(false)
        expect(catalog.removePackage('plugin-a')).toBe(false)

        catalog.setPackages([createPkg('x'), createPkg('y')])
        expect(catalog.getPackages().map((p) => p.manifest.id)).toEqual(['x', 'y'])
    })

    it('allows toggling enabled plugin IDs', () => {
        const catalog = new PluginCatalog({
            cpaVersion: '1.0.0',
            packages: [createPkg('plugin-a'), createPkg('plugin-b')],
        })

        expect(catalog.isEnabled('plugin-a')).toBe(false)
        catalog.enablePlugin('plugin-a')
        expect(catalog.isEnabled('plugin-a')).toBe(true)

        catalog.disablePlugin('plugin-a')
        expect(catalog.isEnabled('plugin-a')).toBe(false)

        catalog.setEnabledPluginIds(['plugin-a', 'plugin-b'])
        expect(catalog.isEnabled('plugin-a')).toBe(true)
        expect(catalog.isEnabled('plugin-b')).toBe(true)
    })

    it('resolves graph and caches the resolution until invalidated', () => {
        const catalog = new PluginCatalog({
            cpaVersion: '1.0.0',
            packages: [
                createPkg('ui', { dependencies: { core: '^1.0.0' } }),
                createPkg('core'),
            ],
            enabledPluginIds: ['ui', 'core'],
        })

        const graph1 = catalog.resolveGraph()
        expect(graph1.activationOrder.map((p) => p.manifest.id)).toEqual(['core', 'ui'])
        expect(graph1.blocked).toEqual([])

        // Second call should return cached resolution
        const graph2 = catalog.resolveGraph()
        expect(graph2).toBe(graph1)

        // Mutating enabled state invalidates the cached graph
        catalog.disablePlugin('core')
        const graph3 = catalog.resolveGraph()
        expect(graph3).not.toBe(graph1)
        expect(graph3.activationOrder).toEqual([])
        expect(graph3.blocked.map((b) => b.pluginId).sort()).toEqual(['core', 'ui'])
    })

    it('computes plugin status correctly', () => {
        const catalog = new PluginCatalog({
            cpaVersion: '1.0.0',
            packages: [
                createPkg('active-pkg'),
                createPkg('disabled-pkg'),
                createPkg('incompatible-cpa', { cpaEngine: '^2.0.0' }),
                createPkg('missing-dep', { dependencies: { nonexistent: '^1.0.0' } }),
            ],
            enabledPluginIds: ['active-pkg', 'incompatible-cpa', 'missing-dep'],
        })

        expect(catalog.getPluginStatus('active-pkg')).toBe('resolved')
        expect(catalog.getPluginStatus('disabled-pkg')).toBe('inactive')
        expect(catalog.getPluginStatus('incompatible-cpa')).toBe('incompatible')
        expect(catalog.getPluginStatus('missing-dep')).toBe('blocked')
    })

    it('provides PluginSummary objects for all packages', () => {
        const pkgA = createPkg('a')
        const pkgDisabled = createPkg('b')
        const catalog = new PluginCatalog({
            cpaVersion: '1.0.0',
            packages: [pkgA, pkgDisabled],
            enabledPluginIds: ['a'],
        })

        const summaries = catalog.getPluginSummaries()
        expect(summaries).toHaveLength(2)

        const summaryA = catalog.getPluginSummary('a')
        expect(summaryA).toEqual({
            manifest: pkgA.manifest,
            status: 'resolved',
            generation: 0,
            source: pkgA.source,
            sourceKind: pkgA.source.kind,
        })

        const summaryB = catalog.getPluginSummary('b')
        expect(summaryB).toEqual({
            manifest: pkgDisabled.manifest,
            status: 'inactive',
            generation: 0,
            error: 'Plugin is disabled',
            source: pkgDisabled.source,
            sourceKind: pkgDisabled.source.kind,
        })
    })
})
