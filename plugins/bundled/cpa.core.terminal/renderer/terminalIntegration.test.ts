import { describe, expect, it, vi } from 'vitest'
import { PluginCapabilityError } from '@cpa/plugin-api'
import { terminalRendererEntry, useTerminalStore } from './index.js'
import { createDefaultPtyBindings } from './utils/ptyHost.js'

describe('terminal plugin integration and capability tests', () => {
    it('throws PluginCapabilityError or handles denied capability gracefully when capability is missing', async () => {
        const deniedCapabilityClient = {
            has: () => false,
            invoke: vi.fn(async () => {
                throw new PluginCapabilityError('Capability "pty.spawn" is not granted')
            }),
            subscribe: vi.fn(() => () => {}),
        }

        const bindings = createDefaultPtyBindings(deniedCapabilityClient as any)

        await expect(
            bindings.StartPty({
                operationId: 'op-denied',
                cwd: '/workspace',
                cols: 80,
                rows: 24,
            }),
        ).rejects.toThrow('Capability "pty.spawn" is not granted')
    })

    it('cleans up all state and unregisters contributions on plugin deactivation / generation cleanup', () => {
        useTerminalStore.getState().addTab({
            title: 'Test Tab 1',
            cwd: '/workspace/1',
            location: 'bottom',
        })
        useTerminalStore.getState().addTab({
            title: 'Test Tab 2',
            cwd: '/workspace/2',
            location: 'right',
        })

        expect(useTerminalStore.getState().tabs).toHaveLength(2)

        terminalRendererEntry.deactivate?.({} as any)

        expect(useTerminalStore.getState().tabs).toHaveLength(0)
        expect(useTerminalStore.getState().activeTabId).toBeNull()
    })
})
