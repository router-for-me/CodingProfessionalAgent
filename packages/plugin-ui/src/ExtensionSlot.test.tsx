import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import React, { useState } from 'react'
import { render, screen, act } from '@testing-library/react'
import { ExtensionSlot, type SlotContributionItem } from './ExtensionSlot.js'
import { HostServicesProvider } from './HostServicesContext.js'
import type { HostServices, RendererContributionsService } from '@cpa/plugin-api'

describe('ExtensionSlot component', () => {
    beforeEach(() => {
        delete (globalThis as any).__cpaRendererRegistry
    })

    afterEach(() => {
        delete (globalThis as any).__cpaRendererRegistry
    })

    it('renders contributions from HostServices without relying on globalThis.__cpaRendererRegistry', () => {
        const items: SlotContributionItem<{ message: string }>[] = [
            {
                id: 'slot-item-1',
                pluginId: 'test.plugin',
                component: ({ message }) => <div data-testid="custom-slot-item">{message}</div>,
            },
        ]

        const rendererContributions: RendererContributionsService = {
            getSlotContributions: (slotName: string) => {
                if (slotName === 'test.slot') return items
                return []
            },
            subscribeSlot: (_slotName: string, _listener: () => void) => {
                return () => {}
            },
        }

        const hostServices: Partial<HostServices> = {
            rendererContributions,
        }

        render(
            <HostServicesProvider services={hostServices as HostServices}>
                <ExtensionSlot name="test.slot" props={{ message: 'Hello from slot!' }} />
            </HostServicesProvider>
        )

        expect(screen.getByTestId('custom-slot-item')).toHaveTextContent('Hello from slot!')
        expect((globalThis as any).__cpaRendererRegistry).toBeUndefined()
    })

    it('reacts dynamically to registration and unregistration of slot contributions', () => {
        let currentItems: SlotContributionItem<any>[] = [
            {
                id: 'dynamic-1',
                pluginId: 'test.plugin',
                component: () => <div data-testid="item-1">Item 1</div>,
            },
        ]

        const listeners = new Set<() => void>()

        const rendererContributions: RendererContributionsService = {
            getSlotContributions: (slotName: string) => {
                if (slotName === 'dynamic.slot') return currentItems
                return []
            },
            subscribeSlot: (slotName: string, listener: () => void) => {
                if (slotName === 'dynamic.slot') {
                    listeners.add(listener)
                    return () => listeners.delete(listener)
                }
                return () => {}
            },
        }

        const hostServices: Partial<HostServices> = {
            rendererContributions,
        }

        const { unmount } = render(
            <HostServicesProvider services={hostServices as HostServices}>
                <ExtensionSlot name="dynamic.slot" />
            </HostServicesProvider>
        )

        expect(screen.getByTestId('item-1')).toBeInTheDocument()

        // Register a second item
        act(() => {
            currentItems = [
                ...currentItems,
                {
                    id: 'dynamic-2',
                    pluginId: 'test.plugin',
                    component: () => <div data-testid="item-2">Item 2</div>,
                },
            ]
            listeners.forEach((l) => l())
        })

        expect(screen.getByTestId('item-1')).toBeInTheDocument()
        expect(screen.getByTestId('item-2')).toBeInTheDocument()

        // Unregister first item
        act(() => {
            currentItems = currentItems.filter((i) => i.id !== 'dynamic-1')
            listeners.forEach((l) => l())
        })

        expect(screen.queryByTestId('item-1')).not.toBeInTheDocument()
        expect(screen.getByTestId('item-2')).toBeInTheDocument()

        unmount()
        expect(listeners.size).toBe(0)
    })

    it('isolates errors with SlotErrorBoundary and renders remaining items', () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

        const BuggyComponent = () => {
            throw new Error('Exploded in slot!')
        }

        const items: SlotContributionItem<any>[] = [
            {
                id: 'buggy-item',
                pluginId: 'buggy.plugin',
                component: BuggyComponent,
            },
            {
                id: 'healthy-item',
                pluginId: 'healthy.plugin',
                component: () => <div data-testid="healthy">Healthy</div>,
            },
        ]

        const rendererContributions: RendererContributionsService = {
            getSlotContributions: () => items,
            subscribeSlot: () => () => {},
        }

        render(
            <HostServicesProvider services={{ rendererContributions } as any}>
                <ExtensionSlot name="test.error.slot" />
            </HostServicesProvider>
        )

        expect(screen.getByTestId('healthy')).toBeInTheDocument()
        expect(consoleError).toHaveBeenCalled()
        consoleError.mockRestore()
    })
})
