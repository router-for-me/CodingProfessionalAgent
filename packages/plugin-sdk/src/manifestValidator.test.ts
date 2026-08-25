import { describe, expect, it } from 'vitest'
import {
    parsePluginManifest,
    validatePluginManifest,
} from './manifestValidator.js'

describe('parsePluginManifest and validatePluginManifest', () => {
    it('accepts a fully-specified manifest', () => {
        const manifest = parsePluginManifest({
            id: 'cpa.core.chat',
            name: 'Chat',
            version: '1.0.0',
            apiVersion: '1.0.0',
            engines: { cpa: '>=1.0.0' },
            entries: {
                renderer: './renderer/index.tsx',
                agent: './agent/index.ts',
            },
            dependencies: {
                'cpa.core.session-manager': '>=1.0.0',
            },
            capabilities: ['sessions.read', 'agent.run'],
            contributes: {
                view: ['chat'],
                'chat-renderer': ['user-message', 'assistant-message'],
            },
        })
        expect(manifest.id).toBe('cpa.core.chat')
        expect(manifest.entries.renderer).toBe('./renderer/index.tsx')
        expect(manifest.dependencies['cpa.core.session-manager']).toBe('>=1.0.0')
        expect(manifest.capabilities).toEqual(['sessions.read', 'agent.run'])
        expect(manifest.contributes.view).toEqual(['chat'])
    })

    it('accepts a manifest with explicit empty declarations', () => {
        const manifest = parsePluginManifest({
            id: 'cpa.minimal',
            name: 'Minimal Plugin',
            version: '1.0.0',
            apiVersion: '1.0.0',
            engines: { cpa: '>=1.0.0' },
            entries: {},
            dependencies: {},
            capabilities: [],
            contributes: {},
        })
        expect(manifest.id).toBe('cpa.minimal')
        expect(manifest.entries).toEqual({})
        expect(manifest.dependencies).toEqual({})
        expect(manifest.capabilities).toEqual([])
        expect(manifest.contributes).toEqual({})
    })

    it('rejects a manifest missing entries', () => {
        expect(() =>
            parsePluginManifest({
                id: 'cpa.bad',
                name: 'Bad',
                version: '1.0.0',
                apiVersion: '1.0.0',
                engines: { cpa: '>=1.0.0' },
                dependencies: {},
                capabilities: [],
                contributes: {},
            }),
        ).toThrow('Manifest "entries" is required')
    })

    it('rejects a manifest missing dependencies', () => {
        const res = validatePluginManifest({
            id: 'cpa.bad',
            name: 'Bad',
            version: '1.0.0',
            apiVersion: '1.0.0',
            engines: { cpa: '>=1.0.0' },
            entries: {},
            capabilities: [],
            contributes: {},
        })
        expect(res.valid).toBe(false)
        expect(res.errors).toContain('Manifest "dependencies" is required and must be an object (use {} if none)')
    })

    it('rejects a manifest missing capabilities', () => {
        const res = validatePluginManifest({
            id: 'cpa.bad',
            name: 'Bad',
            version: '1.0.0',
            apiVersion: '1.0.0',
            engines: { cpa: '>=1.0.0' },
            entries: {},
            dependencies: {},
            contributes: {},
        })
        expect(res.valid).toBe(false)
        expect(res.errors).toContain('Manifest "capabilities" is required and must be an array (use [] if none)')
    })

    it('rejects a manifest missing contributes', () => {
        const res = validatePluginManifest({
            id: 'cpa.bad',
            name: 'Bad',
            version: '1.0.0',
            apiVersion: '1.0.0',
            engines: { cpa: '>=1.0.0' },
            entries: {},
            dependencies: {},
            capabilities: [],
        })
        expect(res.valid).toBe(false)
        expect(res.errors).toContain('Manifest "contributes" is required and must be an object (use {} if none)')
    })

    it('rejects invalid capability wildcard patterns', () => {
        expect(() =>
            parsePluginManifest({
                id: 'cpa.bad.cap',
                name: 'Bad Cap',
                version: '1.0.0',
                apiVersion: '1.0.0',
                engines: { cpa: '>=1.0.0' },
                entries: {},
                dependencies: {},
                capabilities: ['*'],
                contributes: {},
            }),
        ).toThrow('Invalid capability pattern "*"')
    })

    it('rejects duplicate capabilities', () => {
        expect(() =>
            parsePluginManifest({
                id: 'cpa.bad.dup',
                name: 'Bad Dup',
                version: '1.0.0',
                apiVersion: '1.0.0',
                engines: { cpa: '>=1.0.0' },
                entries: {},
                dependencies: {},
                capabilities: ['sessions.read', 'sessions.read'],
                contributes: {},
            }),
        ).toThrow('Duplicate capability "sessions.read"')
    })

    it('rejects unknown contribution kinds', () => {
        expect(() =>
            parsePluginManifest({
                id: 'cpa.bad.contrib',
                name: 'Bad Contrib',
                version: '1.0.0',
                apiVersion: '1.0.0',
                engines: { cpa: '>=1.0.0' },
                entries: {},
                dependencies: {},
                capabilities: [],
                contributes: {
                    // @ts-expect-error invalid contribution kind
                    unknownKind: ['item1'],
                },
            }),
        ).toThrow('contains unknown contribution kind "unknownKind"')
    })

    it('rejects duplicate contribution IDs within a kind', () => {
        expect(() =>
            parsePluginManifest({
                id: 'cpa.bad.contrib.dup',
                name: 'Bad Contrib Dup',
                version: '1.0.0',
                apiVersion: '1.0.0',
                engines: { cpa: '>=1.0.0' },
                entries: {},
                dependencies: {},
                capabilities: [],
                contributes: {
                    view: ['chat', 'chat'],
                },
            }),
        ).toThrow('Duplicate contribution ID "chat"')
    })
})
