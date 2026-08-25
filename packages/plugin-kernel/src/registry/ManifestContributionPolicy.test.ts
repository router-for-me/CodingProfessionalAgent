import { describe, expect, it } from 'vitest'
import { PluginManifestError } from '@cpa/plugin-api'
import { ManifestContributionPolicy } from './ManifestContributionPolicy.js'

describe('ManifestContributionPolicy', () => {
    it('allows declared contributions', () => {
        const policy = new ManifestContributionPolicy({
            id: 'cpa.test',
            name: 'Test',
            version: '1.0.0',
            apiVersion: '1.0.0',
            engines: { cpa: '^1.0.0' },
            entries: { renderer: 'renderer/index.js' },
            dependencies: {},
            capabilities: [],
            contributes: {
                action: ['action-1', 'action-2'],
                view: ['view-main'],
            },
        })

        expect(policy.isDeclared('action', 'action-1')).toBe(true)
        expect(policy.isDeclared('action', 'action-2')).toBe(true)
        expect(policy.isDeclared('view', 'view-main')).toBe(true)

        expect(() => policy.assertDeclared('action', 'action-1')).not.toThrow()
        expect(() => policy.assertDeclared('view', 'view-main')).not.toThrow()
    })

    it('rejects undeclared contribution IDs within a declared kind', () => {
        const policy = new ManifestContributionPolicy({
            id: 'cpa.test',
            name: 'Test',
            version: '1.0.0',
            apiVersion: '1.0.0',
            engines: { cpa: '^1.0.0' },
            entries: { renderer: 'renderer/index.js' },
            dependencies: {},
            capabilities: [],
            contributes: {
                action: ['declared-action'],
            },
        })

        expect(policy.isDeclared('action', 'undeclared-action')).toBe(false)
        expect(() => policy.assertDeclared('action', 'undeclared-action')).toThrow(
            PluginManifestError,
        )
        expect(() => policy.assertDeclared('action', 'undeclared-action')).toThrow(
            'Undeclared contribution action/undeclared-action',
        )
    })

    it('rejects contribution kinds that are not declared', () => {
        const policy = new ManifestContributionPolicy({
            id: 'cpa.test',
            name: 'Test',
            version: '1.0.0',
            apiVersion: '1.0.0',
            engines: { cpa: '^1.0.0' },
            entries: { renderer: 'renderer/index.js' },
            dependencies: {},
            capabilities: [],
            contributes: {},
        })

        expect(policy.isDeclared('service', 'my-service')).toBe(false)
        expect(() => policy.assertDeclared('service', 'my-service')).toThrow(
            PluginManifestError,
        )
        expect(() => policy.assertDeclared('service', 'my-service')).toThrow(
            'Undeclared contribution service/my-service',
        )
    })

    it('rejects contributions when contributes object is undefined', () => {
        const policy = new ManifestContributionPolicy({
            id: 'cpa.test',
            name: 'Test',
            version: '1.0.0',
        })

        expect(policy.isDeclared('action', 'any-action')).toBe(false)
        expect(() => policy.assertDeclared('action', 'any-action')).toThrow(
            'Undeclared contribution action/any-action',
        )
    })
})
