import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import {
    createPanelContext,
    createPanelOpenContext,
    createPanelCloseContext,
    selectPanels,
    selectPanel,
    type PanelContribution,
} from './panels'
import { rendererRegistry } from '../rendererRegistry'
import { RendererRegistry } from '../rendererRegistry'
import { useTerminalStore } from '../../../../../plugins/bundled/cpa.core.terminal/renderer/stores/terminalStore'
import { rendererPluginRuntime } from '../RendererPluginRuntimeHost'
import { DEFAULT_RIGHT_SIDEBAR_CONVERSATION_WIDTH, DEFAULT_RIGHT_SIDEBAR_WIDTH, useUiStore } from '@/stores/uiStore'
import { useSubAgentStore } from '@/stores/subAgentStore'
import { useProjectStore } from '@/stores/projectStore'

describe('Panel Contributions and Registry', () => {
    let registry: RendererRegistry

    beforeEach(() => {
        registry = new RendererRegistry()
    })

    it('lets each panel define width and instance lifecycle', async () => {
        const onOpen = vi.fn()
        const onClose = vi.fn()

        const mockPanel: PanelContribution = {
            id: 'custom-review',
            title: 'Custom Review',
            icon: () => null,
            component: () => null,
            order: 15,
            preferredWidth: DEFAULT_RIGHT_SIDEBAR_CONVERSATION_WIDTH,
            instancePolicy: 'single',
            onOpen,
            onClose,
            isAvailable: (ctx) => Boolean(ctx.activeSessionId),
        }

        registry.registerPanel(mockPanel)

        const panel = registry.getPanel('custom-review')
        expect(panel).toBeDefined()
        expect(panel?.preferredWidth).toBe(DEFAULT_RIGHT_SIDEBAR_CONVERSATION_WIDTH)
        expect(panel?.instancePolicy).toBe('single')

        const context = createPanelOpenContext('custom-review', 'sess-1', { mode: 'diff' })
        await panel?.onOpen?.(context)
        expect(onOpen).toHaveBeenCalledWith(context)

        const closeContext = createPanelCloseContext('custom-review', 'sess-1')
        await panel?.onClose?.(closeContext)
        expect(onClose).toHaveBeenCalledWith(closeContext)

        const availableContext = createPanelContext('sess-1')
        expect(panel?.isAvailable?.(availableContext)).toBe(true)

        const unavailableContext = createPanelContext(undefined)
        expect(panel?.isAvailable?.(unavailableContext)).toBe(false)
    })

    it('sorts panels by order ascending in selectPanels', () => {
        registry.registerPanel({
            id: 'p3',
            title: 'Panel 3',
            icon: () => null,
            component: () => null,
            order: 30,
            instancePolicy: 'single',
        })
        registry.registerPanel({
            id: 'p1',
            title: 'Panel 1',
            icon: () => null,
            component: () => null,
            order: 10,
            instancePolicy: 'single',
        })
        registry.registerPanel({
            id: 'p2',
            title: 'Panel 2',
            icon: () => null,
            component: () => null,
            order: 20,
            instancePolicy: 'multiple',
        })

        const panels = selectPanels(registry)
        expect(panels.map((p) => p.id)).toEqual(['p1', 'p2', 'p3'])
    })

    it('retrieves specific panel via selectPanel', () => {
        registry.registerPanel({
            id: 'p1',
            title: 'Panel 1',
            icon: () => null,
            component: () => null,
            order: 10,
            instancePolicy: 'single',
        })

        expect(selectPanel('p1', registry)?.title).toBe('Panel 1')
        expect(selectPanel('non-existent', registry)).toBeUndefined()
    })
})

describe('Core Plugins Panel Contributions', () => {
    beforeEach(async () => {
        await rendererPluginRuntime.reset()
        useTerminalStore.setState({ tabs: [], activeTabId: null })
        useProjectStore.setState({ projects: [{ id: 'proj-1', name: 'TestProj', path: '/test', pinned: false, createdAt: 1, updatedAt: 1 }] })
        useUiStore.setState({ pendingSessionContext: { projectId: 'proj-1', branch: null } })
    })

    it('registers review panel with preferred width 420 and single instance policy', async () => {
        await rendererPluginRuntime.activatePlugin('cpa.core.review')

        const review = rendererRegistry.getPanel('review')
        expect(review).toBeDefined()
        expect(review?.preferredWidth).toBe(DEFAULT_RIGHT_SIDEBAR_CONVERSATION_WIDTH)
        expect(review?.instancePolicy).toBe('single')
        expect(review?.isAvailable?.(createPanelContext('sess-1'))).toBe(true)
    })

    it('registers terminal panel with multiple instance policy and onOpen tab creation', async () => {
        await rendererPluginRuntime.activatePlugin('cpa.core.terminal')

        const terminal = rendererRegistry.getPanel('terminal')
        expect(terminal).toBeDefined()
        expect(terminal?.preferredWidth).toBe(DEFAULT_RIGHT_SIDEBAR_WIDTH)
        expect(terminal?.instancePolicy).toBe('multiple')

        expect(useTerminalStore.getState().tabs).toHaveLength(0)
        await terminal?.onOpen?.(createPanelOpenContext('terminal', 'sess-1'))
        expect(useTerminalStore.getState().tabs).toHaveLength(1)
        expect(useTerminalStore.getState().tabs[0].location).toBe('right')
    })

    it('registers subagent panel with preferred width 420 when conversation is open', async () => {
        await rendererPluginRuntime.activatePlugin('cpa.core.subagent')

        useSubAgentStore.setState({ focusedIdByParent: { 'sess-1': 'ag-1' } })

        const subagent = rendererRegistry.getPanel('subagent')
        expect(subagent).toBeDefined()
        const width = typeof subagent?.preferredWidth === 'function'
            ? subagent.preferredWidth(createPanelContext('sess-1'))
            : subagent?.preferredWidth
        expect(width).toBe(DEFAULT_RIGHT_SIDEBAR_CONVERSATION_WIDTH)
        expect(subagent?.instancePolicy).toBe('multiple')
    })

    it('registers browser and file-manager panels with single instance policy', async () => {
        await rendererPluginRuntime.activatePlugin('cpa.core.browser')
        await rendererPluginRuntime.activatePlugin('cpa.core.file-manager')

        const browser = rendererRegistry.getPanel('browser')
        expect(browser).toBeDefined()
        expect(browser?.instancePolicy).toBe('single')

        const fileManager = rendererRegistry.getPanel('file-manager')
        expect(fileManager).toBeDefined()
        expect(fileManager?.instancePolicy).toBe('single')
        expect(fileManager?.isAvailable?.(createPanelContext('sess-1'))).toBe(true)
    })
})

describe('Architectural decoupling assertions', () => {
    it('ensures SubAgentPanel.tsx does not contain hardcoded panel IDs or core plugin identifiers', () => {
        const filePath = path.resolve(__dirname, '../../../components/subagent/SubAgentPanel.tsx')
        const content = fs.readFileSync(filePath, 'utf-8')

        // Must not contain hardcoded string literals: 'terminal', 'subagent', 'review', or 'cpa.core.*'
        const forbiddenPatterns = [
            /'terminal'/,
            /"terminal"/,
            /'subagent'/,
            /"subagent"/,
            /'review'/,
            /"review"/,
            /cpa\.core\./,
        ]

        for (const pattern of forbiddenPatterns) {
            expect(content).not.toMatch(pattern)
        }
    })

    it('ensures RightSidebarSelectionView.tsx does not contain hardcoded terminal branch', () => {
        const filePath = path.resolve(__dirname, '../../../components/subagent/RightSidebarSelectionView.tsx')
        const content = fs.readFileSync(filePath, 'utf-8')

        const forbiddenPatterns = [
            /=== 'terminal'/,
            /=== "terminal"/,
        ]

        for (const pattern of forbiddenPatterns) {
            expect(content).not.toMatch(pattern)
        }
    })
})
