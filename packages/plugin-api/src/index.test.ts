import { describe, expect, it } from 'vitest'
import {
    DuplicatePluginSourceError,
    PluginActivationError,
    PluginCapabilityError,
    PluginConflictError,
    PluginDeactivationError,
    PluginDependencyError,
    PluginError,
    PluginManifestError,
    PluginValidationError,
    assertValidCapabilityPattern,
    createServiceToken,
    deserializeCapabilityError,
    isValidCapabilityPattern,
    matchesCapability,
    resolvePackageCriticality,
    serializeCapabilityError,
    type PluginManifest,
} from './index.js'

function makeManifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
    return {
        id: 'test.plugin',
        name: 'Test Plugin',
        version: '1.0.0',
        apiVersion: '1.0.0',
        engines: { cpa: '^1.0.0' },
        entries: {},
        dependencies: {},
        capabilities: [],
        contributes: {},
        ...overrides,
    }
}

describe('@cpa/plugin-api error classes', () => {
    it('instantiates PluginError and sets default code', () => {
        const err = new PluginError('Something failed', { pluginId: 'my.plugin' })
        expect(err.name).toBe('PluginError')
        expect(err.code).toBe('PLUGIN_ERROR')
        expect(err.pluginId).toBe('my.plugin')
        expect(err.message).toBe('Something failed')
    })

    it('instantiates all specific error subclasses', () => {
        expect(new PluginManifestError('bad manifest').name).toBe('PluginManifestError')
        expect(new PluginValidationError('validation failed', ['e1', 'e2']).validationErrors).toEqual(['e1', 'e2'])
        expect(new DuplicatePluginSourceError('duplicate source').name).toBe('DuplicatePluginSourceError')
        expect(new PluginActivationError('activation failed').name).toBe('PluginActivationError')
        expect(new PluginDeactivationError('deactivation failed').name).toBe('PluginDeactivationError')
        expect(new PluginDependencyError('dependency failed').name).toBe('PluginDependencyError')
        expect(new PluginConflictError('conflict failed').name).toBe('PluginConflictError')
        expect(new PluginCapabilityError('capability failed').name).toBe('PluginCapabilityError')
    })
})

describe('@cpa/plugin-api capability helpers', () => {
    it('validates capability grant patterns', () => {
        expect(isValidCapabilityPattern('sessions.read')).toBe(true)
        expect(isValidCapabilityPattern('sessions.*')).toBe(true)
        expect(isValidCapabilityPattern('*')).toBe(false)
        expect(isValidCapabilityPattern('*.read')).toBe(false)
        expect(isValidCapabilityPattern('sessions.*.read')).toBe(false)
        expect(isValidCapabilityPattern('sessions**')).toBe(false)
        expect(isValidCapabilityPattern('')).toBe(false)

        expect(() => assertValidCapabilityPattern('sessions.read')).not.toThrow()
        expect(() => assertValidCapabilityPattern('sessions.*')).not.toThrow()
        expect(() => assertValidCapabilityPattern('*')).toThrow(PluginCapabilityError)
        expect(() => assertValidCapabilityPattern('*.read')).toThrow(PluginCapabilityError)
    })

    it('matches capability patterns correctly', () => {
        expect(matchesCapability('sessions.read', 'sessions.read')).toBe(true)
        expect(matchesCapability('sessions.read', 'sessions.write')).toBe(false)
        expect(matchesCapability('sessions.*', 'sessions.read')).toBe(true)
        expect(matchesCapability('sessions.*', 'sessions.write')).toBe(true)
        expect(matchesCapability('sessions.*', 'sessions.sub.action')).toBe(true)
        expect(matchesCapability('sessions.*', 'filesystem.read')).toBe(false)
        expect(matchesCapability('sessions.*', 'sessions')).toBe(false)
    })
})

describe('@cpa/plugin-api protocol error serialization', () => {
    it('serializes and deserializes PluginValidationError with validationErrors', () => {
        const original = new PluginValidationError('Invalid args', ['err1', 'err2'], { pluginId: 'test-p' })
        const dto = serializeCapabilityError(original)
        expect(dto.name).toBe('PluginValidationError')
        expect(dto.validationErrors).toEqual(['err1', 'err2'])
        expect(dto.pluginId).toBe('test-p')

        const restored = deserializeCapabilityError(dto)
        expect(restored).toBeInstanceOf(PluginValidationError)
        expect((restored as PluginValidationError).validationErrors).toEqual(['err1', 'err2'])
        expect((restored as PluginValidationError).pluginId).toBe('test-p')
    })

    it('serializes and deserializes PluginCapabilityError', () => {
        const original = new PluginCapabilityError('Plugin lacks capability', { pluginId: 'p1' })
        const dto = serializeCapabilityError(original)
        const restored = deserializeCapabilityError(dto)
        expect(restored).toBeInstanceOf(PluginCapabilityError)
        expect((restored as PluginCapabilityError).pluginId).toBe('p1')
    })
})

describe('@cpa/plugin-api service tokens', () => {
    it('creates service tokens with unique ids', () => {
        interface MyService {
            doSomething(): void
        }
        const token = createServiceToken<MyService>('my.custom.service')
        expect(token.id).toBe('my.custom.service')
    })
})

describe('@cpa/plugin-api resolvePackageCriticality', () => {
    it('returns explicit manifest criticality when present', () => {
        expect(
            resolvePackageCriticality({
                manifest: makeManifest({ id: 'p1', criticality: 'optional' }),
                source: { kind: 'bundled', spec: 'bundled:p1' },
            }),
        ).toBe('optional')
        expect(
            resolvePackageCriticality({
                manifest: makeManifest({ id: 'p2', criticality: 'platform' }),
                source: { kind: 'global-config', spec: 'p2@1.0.0' },
            }),
        ).toBe('platform')
    })

    it('defaults bundled packages to required', () => {
        expect(
            resolvePackageCriticality({
                manifest: makeManifest({ id: 'core1' }),
                source: { kind: 'bundled', spec: 'bundled:core1' },
            }),
        ).toBe('required')
        expect(
            resolvePackageCriticality({
                manifest: makeManifest({ id: 'core3' }),
                isCore: true,
                source: { kind: 'npm', spec: 'npm:core3' },
            }),
        ).toBe('required')
    })

    it('defaults external non-core packages to optional', () => {
        expect(
            resolvePackageCriticality({
                manifest: makeManifest({ id: 'ext1' }),
                source: { kind: 'global-config', spec: 'ext1@1.0.0' },
            }),
        ).toBe('optional')
        expect(
            resolvePackageCriticality({
                manifest: makeManifest({ id: 'ext2' }),
                source: { kind: 'npm', spec: 'ext2@1.0.0' },
            }),
        ).toBe('optional')
    })
})
