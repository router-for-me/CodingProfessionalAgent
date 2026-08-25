import React from 'react'
import { renderHook, act } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { RendererRegistry } from '../platform/rendererRegistry'
import { createRendererRuntimeHost } from '../platform/RendererPluginRuntimeHost'
import { useSlotContributions } from './useSlotContributions'
import type { PluginEntryDefinition, ResolvedPluginPackage } from '@cpa/plugin-api'

describe('useSlotContributions', () => {
    it('returns empty array by default and updates when slots are directly registered/unregistered', () => {
        const registry = new RendererRegistry()
        const { result } = renderHook(() =>
            useSlotContributions('test.slot', registry)
        )

        expect(result.current).toEqual([])

        const DummyComponent1: React.FC = () => null
        const DummyComponent2: React.FC = () => null

        let unreg1: (() => void) | undefined
        act(() => {
            unreg1 = registry.registerSlot('test.slot', {
                id: 'slot-1',
                pluginId: 'cpa.test.direct',
                order: 10,
                component: DummyComponent1,
            })
        })

        expect(result.current).toHaveLength(1)
        expect(result.current[0].id).toBe('slot-1')

        let unreg2: (() => void) | undefined
        act(() => {
            unreg2 = registry.registerSlot('test.slot', {
                id: 'slot-0',
                pluginId: 'cpa.test.direct',
                order: 5,
                component: DummyComponent2,
            })
        })

        expect(result.current).toHaveLength(2)
        expect(result.current[0].id).toBe('slot-0')
        expect(result.current[1].id).toBe('slot-1')

        act(() => {
            unreg2?.()
        })

        expect(result.current).toHaveLength(1)
        expect(result.current[0].id).toBe('slot-1')

        act(() => {
            unreg1?.()
        })

        expect(result.current).toHaveLength(0)
    })

    it('reacts to dynamic plugin activation and deactivation via runtime host', async () => {
        const extPackage: ResolvedPluginPackage = {
            manifest: {
                id: 'cpa.test.dynamic.slot',
                name: 'Dynamic Slot Plugin',
                version: '1.0.0',
                apiVersion: '1.0.0',
                engines: { cpa: '>=1.0.0' },
                activationPriority: 10,
                dependencies: {},
                capabilities: [],
                contributes: {
                    slot: ['dynamic-button'],
                },
                entries: { renderer: './index.ts' },
            },
            entries: { renderer: './index.ts' },
            sourceRoot: 'plugins/test/dynamic-slot',
            source: { kind: 'bundled', spec: 'bundled:cpa.test.dynamic.slot' },
        }

        const definitions: Record<string, PluginEntryDefinition> = {
            'cpa.test.dynamic.slot': {
                runtime: 'renderer',
                activate: (context: any) => {
                    context.registerSlotComponent('chat.composer.actions', {
                        id: 'dynamic-button',
                        order: 10,
                        component: () => null,
                    })
                },
            },
        }

        const host = createRendererRuntimeHost({
            bundledPackages: [extPackage],
            defaultDefinitions: definitions,
        })

        const { result } = renderHook(() =>
            useSlotContributions('chat.composer.actions', host.registry)
        )

        expect(result.current).toHaveLength(0)

        // Dynamically activate plugin
        await act(async () => {
            await host.activatePlugin('cpa.test.dynamic.slot')
        })

        expect(result.current).toHaveLength(1)
        expect(result.current[0].id).toBe('dynamic-button')

        // Dynamically deactivate plugin
        await act(async () => {
            await host.deactivatePlugin('cpa.test.dynamic.slot')
        })

        expect(result.current).toHaveLength(0)
    })
})
