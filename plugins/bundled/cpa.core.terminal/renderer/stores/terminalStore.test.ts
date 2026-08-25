import { beforeEach, describe, expect, it } from 'vitest'
import { useTerminalStore } from './terminalStore.js'

describe('terminalStore', () => {
    beforeEach(() => {
        useTerminalStore.setState({
            tabs: [],
            activeTabId: null,
            activeTabIdByLocation: { bottom: null, right: null },
        })
    })

    it('adds tabs with proper location tracking and default bottom location', () => {
        const id1 = useTerminalStore.getState().addTab({
            title: 'Terminal 1',
            cwd: '/workspace/1',
        })
        expect(useTerminalStore.getState().tabs).toHaveLength(1)
        expect(useTerminalStore.getState().tabs[0]).toMatchObject({
            id: id1,
            title: 'Terminal 1',
            cwd: '/workspace/1',
            location: 'bottom',
        })
        expect(useTerminalStore.getState().activeTabId).toBe(id1)
        expect(useTerminalStore.getState().activeTabIdByLocation.bottom).toBe(id1)

        const id2 = useTerminalStore.getState().addTab({
            title: 'Terminal Right',
            cwd: '/workspace/2',
            location: 'right',
        })
        expect(useTerminalStore.getState().tabs).toHaveLength(2)
        expect(useTerminalStore.getState().activeTabId).toBe(id2)
        expect(useTerminalStore.getState().activeTabIdByLocation.right).toBe(id2)
        expect(useTerminalStore.getState().activeTabIdByLocation.bottom).toBe(id1)
    })

    it('switches active tabs per location and globally', () => {
        const id1 = useTerminalStore.getState().addTab({ title: 'T1', cwd: '/1', location: 'bottom' })
        const id2 = useTerminalStore.getState().addTab({ title: 'T2', cwd: '/2', location: 'bottom' })

        useTerminalStore.getState().setActiveTab(id1, 'bottom')
        expect(useTerminalStore.getState().activeTabId).toBe(id1)
        expect(useTerminalStore.getState().activeTabIdByLocation.bottom).toBe(id1)

        useTerminalStore.getState().setActiveTab(id2)
        expect(useTerminalStore.getState().activeTabId).toBe(id2)
        expect(useTerminalStore.getState().activeTabIdByLocation.bottom).toBe(id2)
    })

    it('closes tabs and selects the remaining active tab for that location', () => {
        const id1 = useTerminalStore.getState().addTab({ title: 'T1', cwd: '/1', location: 'bottom' })
        const id2 = useTerminalStore.getState().addTab({ title: 'T2', cwd: '/2', location: 'bottom' })

        expect(useTerminalStore.getState().activeTabIdByLocation.bottom).toBe(id2)

        useTerminalStore.getState().closeTab(id2)
        expect(useTerminalStore.getState().tabs).toHaveLength(1)
        expect(useTerminalStore.getState().activeTabIdByLocation.bottom).toBe(id1)
        expect(useTerminalStore.getState().activeTabId).toBe(id1)

        useTerminalStore.getState().closeTab(id1)
        expect(useTerminalStore.getState().tabs).toHaveLength(0)
        expect(useTerminalStore.getState().activeTabIdByLocation.bottom).toBeNull()
        expect(useTerminalStore.getState().activeTabId).toBeNull()
    })

    it('resets state properly', () => {
        useTerminalStore.getState().addTab({ title: 'T1', cwd: '/1' })
        expect(useTerminalStore.getState().tabs).toHaveLength(1)
        useTerminalStore.getState().reset()
        expect(useTerminalStore.getState().tabs).toHaveLength(0)
        expect(useTerminalStore.getState().activeTabId).toBeNull()
    })
})
