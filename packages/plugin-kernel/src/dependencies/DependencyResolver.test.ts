import { describe, expect, it } from 'vitest'
import type { ResolvedPluginPackage } from '@cpa/plugin-api'
import {
    resolvePluginGraph,
    type BlockedPlugin,
    type ResolvePluginGraphInput,
} from './DependencyResolver.js'

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

describe('DependencyResolver', () => {
    describe('Topological sorting & Activation order', () => {
        it('sorts required dependencies before dependents', () => {
            const graph = resolvePluginGraph({
                packages: [
                    createPkg('ui', { dependencies: { core: '^1.0.0' } }),
                    createPkg('core'),
                ],
                enabledPluginIds: new Set(['ui', 'core']),
                cpaVersion: '1.0.0',
            })
            expect(graph.activationOrder.map((item) => item.manifest.id)).toEqual(['core', 'ui'])
            expect(graph.blocked).toEqual([])
        })

        it('sorts a multi-level dependency chain correctly', () => {
            const graph = resolvePluginGraph({
                packages: [
                    createPkg('app', { dependencies: { service: '^1.0.0' } }),
                    createPkg('service', { dependencies: { db: '^1.0.0' } }),
                    createPkg('db'),
                ],
                enabledPluginIds: new Set(['app', 'service', 'db']),
                cpaVersion: '1.0.0',
            })
            expect(graph.activationOrder.map((item) => item.manifest.id)).toEqual(['db', 'service', 'app'])
            expect(graph.blocked).toEqual([])
        })

        it('resolves diamonds and branching dependency graphs', () => {
            // app depends on auth and store; auth and store both depend on base
            const graph = resolvePluginGraph({
                packages: [
                    createPkg('app', { dependencies: { auth: '^1.0.0', store: '^1.0.0' } }),
                    createPkg('auth', { dependencies: { base: '^1.0.0' } }),
                    createPkg('store', { dependencies: { base: '^1.0.0' } }),
                    createPkg('base'),
                ],
                enabledPluginIds: new Set(['app', 'auth', 'store', 'base']),
                cpaVersion: '1.0.0',
            })
            const order = graph.activationOrder.map((item) => item.manifest.id)
            expect(order[0]).toBe('base')
            expect(order.indexOf('base')).toBeLessThan(order.indexOf('auth'))
            expect(order.indexOf('base')).toBeLessThan(order.indexOf('store'))
            expect(order.indexOf('auth')).toBeLessThan(order.indexOf('app'))
            expect(order.indexOf('store')).toBeLessThan(order.indexOf('app'))
        })

        it('tie-breaks independent plugins by activationPriority ascending then manifest.id lexicographically', () => {
            const graph = resolvePluginGraph({
                packages: [
                    createPkg('plugin-z', { priority: 500 }),
                    createPkg('plugin-b', { priority: 1000 }),
                    createPkg('plugin-a', { priority: 1000 }),
                    createPkg('plugin-first', { priority: 10 }),
                ],
                enabledPluginIds: new Set(['plugin-z', 'plugin-b', 'plugin-a', 'plugin-first']),
                cpaVersion: '1.0.0',
            })
            expect(graph.activationOrder.map((item) => item.manifest.id)).toEqual([
                'plugin-first', // priority 10
                'plugin-z',     // priority 500
                'plugin-a',     // priority 1000, alphabetical 'a' before 'b'
                'plugin-b',     // priority 1000, alphabetical 'b'
            ])
        })

        it('defaults activationPriority to 1000 when omitted', () => {
            const graph = resolvePluginGraph({
                packages: [
                    createPkg('low-prio', { priority: 2000 }),
                    createPkg('default-prio'), // default 1000
                    createPkg('high-prio', { priority: 100 }),
                ],
                enabledPluginIds: new Set(['low-prio', 'default-prio', 'high-prio']),
                cpaVersion: '1.0.0',
            })
            expect(graph.activationOrder.map((item) => item.manifest.id)).toEqual([
                'high-prio',
                'default-prio',
                'low-prio',
            ])
        })

        it('respects dependency constraint over activationPriority', () => {
            // consumer has higher priority (lower number 10) than dependency (priority 5000),
            // but dependency MUST still activate first
            const graph = resolvePluginGraph({
                packages: [
                    createPkg('consumer', { priority: 10, dependencies: { provider: '^1.0.0' } }),
                    createPkg('provider', { priority: 5000 }),
                ],
                enabledPluginIds: new Set(['consumer', 'provider']),
                cpaVersion: '1.0.0',
            })
            expect(graph.activationOrder.map((item) => item.manifest.id)).toEqual(['provider', 'consumer'])
        })
    })

    describe('CPA engine version validation', () => {
        it('accepts compatible CPA engine versions', () => {
            const graph = resolvePluginGraph({
                packages: [createPkg('valid-plugin', { cpaEngine: '>=1.0.0 <2.0.0' })],
                enabledPluginIds: new Set(['valid-plugin']),
                cpaVersion: '1.5.3',
            })
            expect(graph.activationOrder.map((p) => p.manifest.id)).toEqual(['valid-plugin'])
            expect(graph.blocked).toEqual([])
        })

        it('blocks plugins with incompatible CPA engine version', () => {
            const graph = resolvePluginGraph({
                packages: [createPkg('incompatible-plugin', { cpaEngine: '^2.0.0' })],
                enabledPluginIds: new Set(['incompatible-plugin']),
                cpaVersion: '1.0.0',
            })
            expect(graph.activationOrder).toEqual([])
            expect(graph.blocked).toEqual([
                {
                    pluginId: 'incompatible-plugin',
                    reason: 'incompatible-version',
                },
            ])
        })
    })

    describe('Disabled plugins', () => {
        it('blocks plugins not included in enabledPluginIds', () => {
            const graph = resolvePluginGraph({
                packages: [createPkg('enabled-plugin'), createPkg('disabled-plugin')],
                enabledPluginIds: new Set(['enabled-plugin']),
                cpaVersion: '1.0.0',
            })
            expect(graph.activationOrder.map((p) => p.manifest.id)).toEqual(['enabled-plugin'])
            expect(graph.blocked).toEqual([
                {
                    pluginId: 'disabled-plugin',
                    reason: 'disabled',
                },
            ])
        })

        it('blocks dependents when their required dependency is disabled', () => {
            const graph = resolvePluginGraph({
                packages: [
                    createPkg('consumer', { dependencies: { provider: '^1.0.0' } }),
                    createPkg('provider'),
                ],
                enabledPluginIds: new Set(['consumer']), // provider is disabled
                cpaVersion: '1.0.0',
            })
            expect(graph.activationOrder).toEqual([])
            expect(graph.blocked).toEqual([
                {
                    pluginId: 'consumer',
                    reason: 'missing-dependency',
                    dependencyId: 'provider',
                },
                {
                    pluginId: 'provider',
                    reason: 'disabled',
                },
            ])
        })
    })

    describe('Required dependencies validation & Cascading blocks', () => {
        it('blocks plugin when required dependency is missing from packages', () => {
            const graph = resolvePluginGraph({
                packages: [
                    createPkg('consumer', { dependencies: { nonexistent: '^1.0.0' } }),
                ],
                enabledPluginIds: new Set(['consumer']),
                cpaVersion: '1.0.0',
            })
            expect(graph.activationOrder).toEqual([])
            expect(graph.blocked).toEqual([
                {
                    pluginId: 'consumer',
                    reason: 'missing-dependency',
                    dependencyId: 'nonexistent',
                },
            ])
        })

        it('blocks plugin when required dependency version is incompatible', () => {
            const graph = resolvePluginGraph({
                packages: [
                    createPkg('consumer', { dependencies: { provider: '^2.0.0' } }),
                    createPkg('provider', { version: '1.2.0' }),
                ],
                enabledPluginIds: new Set(['consumer', 'provider']),
                cpaVersion: '1.0.0',
            })
            // provider itself is valid and enabled, so provider activates, but consumer is blocked
            expect(graph.activationOrder.map((p) => p.manifest.id)).toEqual(['provider'])
            expect(graph.blocked).toEqual([
                {
                    pluginId: 'consumer',
                    reason: 'incompatible-version',
                    dependencyId: 'provider',
                },
            ])
        })

        it('propagates block down a deep dependency tree', () => {
            const graph = resolvePluginGraph({
                packages: [
                    createPkg('top', { dependencies: { mid: '^1.0.0' } }),
                    createPkg('mid', { dependencies: { bottom: '^1.0.0' } }),
                    createPkg('bottom', { cpaEngine: '^2.0.0' }), // Incompatible CPA version
                ],
                enabledPluginIds: new Set(['top', 'mid', 'bottom']),
                cpaVersion: '1.0.0',
            })
            expect(graph.activationOrder).toEqual([])
            const blockedMap = new Map(graph.blocked.map((b) => [b.pluginId, b]))
            expect(blockedMap.get('bottom')).toEqual({
                pluginId: 'bottom',
                reason: 'incompatible-version',
            })
            expect(blockedMap.get('mid')).toEqual({
                pluginId: 'mid',
                reason: 'missing-dependency',
                dependencyId: 'bottom',
            })
            expect(blockedMap.get('top')).toEqual({
                pluginId: 'top',
                reason: 'missing-dependency',
                dependencyId: 'mid',
            })
        })
    })

    describe('Optional dependencies', () => {
        it('does not block when an optional dependency is missing', () => {
            const graph = resolvePluginGraph({
                packages: [
                    createPkg('consumer', { optionalDependencies: { missingOpt: '^1.0.0' } }),
                ],
                enabledPluginIds: new Set(['consumer']),
                cpaVersion: '1.0.0',
            })
            expect(graph.activationOrder.map((p) => p.manifest.id)).toEqual(['consumer'])
            expect(graph.blocked).toEqual([])
        })

        it('does not block when an optional dependency is disabled', () => {
            const graph = resolvePluginGraph({
                packages: [
                    createPkg('consumer', { optionalDependencies: { opt: '^1.0.0' } }),
                    createPkg('opt'),
                ],
                enabledPluginIds: new Set(['consumer']), // opt is disabled
                cpaVersion: '1.0.0',
            })
            expect(graph.activationOrder.map((p) => p.manifest.id)).toEqual(['consumer'])
            expect(graph.blocked).toEqual([
                {
                    pluginId: 'opt',
                    reason: 'disabled',
                },
            ])
        })

        it('does not block when an optional dependency version is incompatible', () => {
            const graph = resolvePluginGraph({
                packages: [
                    createPkg('consumer', { optionalDependencies: { opt: '^2.0.0' } }),
                    createPkg('opt', { version: '1.0.0' }),
                ],
                enabledPluginIds: new Set(['consumer', 'opt']),
                cpaVersion: '1.0.0',
            })
            // Both activate, consumer is NOT blocked, but incompatible optional dep is not an ordering constraint
            const activeIds = graph.activationOrder.map((p) => p.manifest.id)
            expect(activeIds).toContain('consumer')
            expect(activeIds).toContain('opt')
            expect(graph.blocked).toEqual([])
        })

        it('orders compatible optional dependencies before consumer', () => {
            const graph = resolvePluginGraph({
                packages: [
                    createPkg('consumer', { priority: 100, optionalDependencies: { opt: '^1.0.0' } }),
                    createPkg('opt', { priority: 500, version: '1.2.0' }),
                ],
                enabledPluginIds: new Set(['consumer', 'opt']),
                cpaVersion: '1.0.0',
            })
            expect(graph.activationOrder.map((p) => p.manifest.id)).toEqual(['opt', 'consumer'])
            expect(graph.blocked).toEqual([])
        })
    })

    describe('Dependency cycles detection', () => {
        it('blocks every member of a direct 2-plugin dependency cycle', () => {
            const graph = resolvePluginGraph({
                packages: [
                    createPkg('a', { dependencies: { b: '*' } }),
                    createPkg('b', { dependencies: { a: '*' } }),
                ],
                enabledPluginIds: new Set(['a', 'b']),
                cpaVersion: '1.0.0',
            })
            expect(graph.activationOrder).toEqual([])
            expect(graph.blocked.map((item) => item.pluginId).sort()).toEqual(['a', 'b'])
            for (const item of graph.blocked) {
                expect(item.reason).toBe('dependency-cycle')
            }
        })

        it('blocks every member of a 3-plugin cycle', () => {
            const graph = resolvePluginGraph({
                packages: [
                    createPkg('a', { dependencies: { b: '*' } }),
                    createPkg('b', { dependencies: { c: '*' } }),
                    createPkg('c', { dependencies: { a: '*' } }),
                ],
                enabledPluginIds: new Set(['a', 'b', 'c']),
                cpaVersion: '1.0.0',
            })
            expect(graph.activationOrder).toEqual([])
            expect(graph.blocked.map((item) => item.pluginId).sort()).toEqual(['a', 'b', 'c'])
            for (const item of graph.blocked) {
                expect(item.reason).toBe('dependency-cycle')
            }
        })

        it('blocks self-referential cycle', () => {
            const graph = resolvePluginGraph({
                packages: [createPkg('self', { dependencies: { self: '*' } })],
                enabledPluginIds: new Set(['self']),
                cpaVersion: '1.0.0',
            })
            expect(graph.activationOrder).toEqual([])
            expect(graph.blocked).toEqual([
                {
                    pluginId: 'self',
                    reason: 'dependency-cycle',
                },
            ])
        })

        it('activates independent plugins while blocking cycle members and their dependents', () => {
            const graph = resolvePluginGraph({
                packages: [
                    createPkg('independent'),
                    createPkg('cycle1', { dependencies: { cycle2: '*' } }),
                    createPkg('cycle2', { dependencies: { cycle1: '*' } }),
                    createPkg('dependent-on-cycle', { dependencies: { cycle1: '*' } }),
                ],
                enabledPluginIds: new Set(['independent', 'cycle1', 'cycle2', 'dependent-on-cycle']),
                cpaVersion: '1.0.0',
            })
            expect(graph.activationOrder.map((p) => p.manifest.id)).toEqual(['independent'])
            const blockedMap = new Map(graph.blocked.map((b) => [b.pluginId, b]))
            expect(blockedMap.get('cycle1')?.reason).toBe('dependency-cycle')
            expect(blockedMap.get('cycle2')?.reason).toBe('dependency-cycle')
            expect(blockedMap.get('dependent-on-cycle')).toEqual({
                pluginId: 'dependent-on-cycle',
                reason: 'missing-dependency',
                dependencyId: 'cycle1',
            })
        })

        it('does not block plugins when an optional dependency cycle can be broken', () => {
            // b requires a; a optionally depends on b.
            // Since b is optional for a, a should activate first, then b activates after a.
            const graph = resolvePluginGraph({
                packages: [
                    createPkg('a', { optionalDependencies: { b: '*' } }),
                    createPkg('b', { dependencies: { a: '*' } }),
                ],
                enabledPluginIds: new Set(['a', 'b']),
                cpaVersion: '1.0.0',
            })
            expect(graph.activationOrder.map((p) => p.manifest.id)).toEqual(['a', 'b'])
            expect(graph.blocked).toEqual([])
        })
    })

    describe('Empty and Edge cases', () => {
        it('handles empty package list gracefully', () => {
            const graph = resolvePluginGraph({
                packages: [],
                enabledPluginIds: new Set(),
                cpaVersion: '1.0.0',
            })
            expect(graph.activationOrder).toEqual([])
            expect(graph.blocked).toEqual([])
        })
    })
})
