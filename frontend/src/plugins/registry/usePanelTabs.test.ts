import React from 'react'
import { renderHook, act } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { RendererRegistry } from '../platform/rendererRegistry'
import { usePanelTabs } from './usePanelTabs'

describe('usePanelTabs', () => {
    it('returns empty array by default and updates when panel tabs are registered/unregistered', () => {
        const registry = new RendererRegistry()
        const { result } = renderHook(() => usePanelTabs(registry))

        expect(result.current).toEqual([])

        const DummyIcon: React.FC = () => null
        const DummyComponent: React.FC = () => null

        act(() => {
            registry.registerPanelTab({
                id: 'tab-1',
                pluginId: 'plugin-1',
                title: 'Tab 1',
                icon: DummyIcon,
                order: 10,
                component: DummyComponent,
            })
        })

        expect(result.current).toHaveLength(1)
        expect(result.current[0].id).toBe('tab-1')

        act(() => {
            registry.registerPanelTab({
                id: 'tab-0',
                pluginId: 'plugin-0',
                title: 'Tab 0',
                icon: DummyIcon,
                order: 5,
                component: DummyComponent,
            })
        })

        expect(result.current).toHaveLength(2)
        expect(result.current[0].id).toBe('tab-0')
        expect(result.current[1].id).toBe('tab-1')

        act(() => {
            registry.unregisterPanelTab('tab-0')
        })

        expect(result.current).toHaveLength(1)
        expect(result.current[0].id).toBe('tab-1')
    })
})
