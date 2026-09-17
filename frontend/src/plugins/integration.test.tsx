import type { MouseEventHandler, ReactNode } from 'react'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '@/i18n'
import { createHostServices } from '@/application/services/createHostServices'
import { setHostBridge } from '@/application/services/hostTransport'
import type { DisplayChatMessage } from '@/features/agent-runtime/session/types'
import { AppShell } from '@/components/layout/AppShell'
import { MainTitleBar } from '@/components/layout/MainTitleBar'
import { Sidebar } from '@/components/layout/Sidebar'
import { Composer, ComposerContainer } from '../../../plugins/bundled/cpa.core.composer/renderer/index'
import { MessageItem } from '../../../plugins/bundled/cpa.core.chat/renderer/components/MessageItem'
import { SettingsPanel } from '@/components/settings/SettingsPanel'
import { PluginsSection } from '../../../plugins/bundled/cpa.core.settings/renderer/index'
import { FloatingOverlayHost } from '@/plugins/registry/FloatingOverlayHost'
import { createExtensibleComponent } from '@/plugins/registry/createExtensibleComponent'
import { rendererRegistry } from '@/plugins/platform/rendererRegistry'
import { rendererPluginRuntime } from '@/plugins/platform/RendererPluginRuntimeHost'
import type { PluginManifest } from '@cpa/plugin-api'
import { definePluginEntry } from '@cpa/plugin-sdk'
import { useProjectStore } from '@/stores/projectStore'
import { useSessionStore } from '@/stores/sessionStore'
import { useSubAgentStore } from '@/stores/subAgentStore'
import { useUiStore } from '@/stores/uiStore'
import {
    createManageTodoListTool,
} from '../../../plugins/bundled/cpa.core.manage-todo-list/agent/index.js'
import {
    __resetTodoListStoreForTests,
} from '../../../plugins/bundled/cpa.core.manage-todo-list/shared/todoStore.js'

const { clipboardSetTextMock, navigateMock } = vi.hoisted(() => ({
    clipboardSetTextMock: vi.fn(),
    navigateMock: vi.fn(),
}))

let mockPathname = '/'

vi.mock('@tanstack/react-router', () => ({
    Outlet: () => <div data-testid="outlet-fallback">Outlet View</div>,
    Link: ({
        children,
        className,
        onClick,
        onContextMenu,
        params,
        title,
        to,
    }: {
        children: ReactNode
        className?: string
        onClick?: MouseEventHandler<HTMLAnchorElement>
        onContextMenu?: MouseEventHandler<HTMLAnchorElement>
        params?: { sessionId?: string }
        title?: string
        to: string
    }) => (
        <a
            className={className}
            href={params?.sessionId ? `/chat/${params.sessionId}` : to}
            onClick={onClick}
            onContextMenu={onContextMenu}
            title={title}
        >
            {children}
        </a>
    ),
    useNavigate: () => navigateMock,
    useRouterState: ({
        select,
    }: {
        select: (state: { location: { pathname: string } }) => unknown
    }) => select({ location: { pathname: mockPathname } }),
}))

vi.mock('@/features/agent/useAgentStream', () => ({
    useAgentStream: () => ({
        send: vi.fn(),
        stop: vi.fn(),
        isStreaming: false,
        runStatus: 'idle',
        supportsImages: true,
        skills: [],
        prompts: [],
        compact: vi.fn(),
    }),
}))

describe('Universal Plugin Architecture - End-to-End Integration', () => {
    beforeEach(async () => {
        mockPathname = '/'
        navigateMock.mockReset()
        clipboardSetTextMock.mockReset()
        clipboardSetTextMock.mockResolvedValue(undefined)

        setHostBridge({
            ClipboardSetText: clipboardSetTextMock,
        } as any)

        await i18n.changeLanguage('en')
        createHostServices()

        // Initialize core plugins
        await rendererPluginRuntime.activateAll()
        __resetTodoListStoreForTests()

        // Reset store states
        useProjectStore.setState({
            projects: [
                {
                    id: 'proj-1',
                    name: 'Test Project',
                    path: '/workspace/test',
                    pinned: false,
                    createdAt: 1,
                    updatedAt: 2,
                },
            ],
        })

        useSessionStore.setState({
            sessions: [
                {
                    id: 'sess-1',
                    title: 'Integration Test Session',
                    projectId: 'proj-1',
                    createdAt: '2026-01-01T00:00:00Z',
                    updatedAt: '2026-01-01T00:00:00Z',
                } as any,
            ],
            currentSessionId: 'sess-1',
        })

        useSubAgentStore.setState({
            agents: [],
            openTabIdsByParent: {},
            focusedIdByParent: {},
        })

        useUiStore.setState({
            sidebarCollapsed: false,
            rightSidebarCollapsed: false,
            rightSidebarWidth: 320,
            settingsOpen: false,
            toasts: [],
        })
    })

    afterEach(async () => {
        setHostBridge(null)
        __resetTodoListStoreForTests()
        await rendererPluginRuntime.reset()
        rendererRegistry.clear()
        vi.restoreAllMocks()
    })

    it('mounts external plugin contributions across multiple slots alongside core components', async () => {
        const manifest: PluginManifest = {
            id: 'external.multi-slot',
            name: 'External Multi-Slot Plugin',
            version: '1.0.0',
            apiVersion: '1.0.0',
            engines: { cpa: '>=1.0.0' },
            description: 'Tests multi-slot integration',
            entries: { renderer: './index.ts' },
            dependencies: {},
            capabilities: [],
            contributes: {
                slot: ['ext-sidebar-action', 'ext-composer-action', 'ext-msg-action', 'ext-titlebar-action'],
                settings: ['ext-settings-section'],
            },
        }

        const entry = definePluginEntry({
            runtime: 'renderer',
            activate: (context: any) => {
                // Sidebar top slot
                context.registerSlotComponent('layout.sidebar.nav.top', {
                    id: 'ext-sidebar-action',
                    pluginId: context.manifest.id,
                    order: 5,
                    component: () => (
                        <button type="button" data-testid="ext-sidebar-btn">
                            External Quick Action
                        </button>
                    ),
                })

                // Composer toolbar left slot
                context.registerSlotComponent('composer.toolbar.left', {
                    id: 'ext-composer-action',
                    pluginId: context.manifest.id,
                    order: 10,
                    component: () => (
                        <button type="button" data-testid="ext-composer-btn">
                            External Format
                        </button>
                    ),
                })

                // Chat message action slot
                context.registerSlotComponent('chat.message.actions', {
                    id: 'ext-msg-action',
                    pluginId: context.manifest.id,
                    order: 50,
                    component: () => (
                        <button type="button" data-testid="ext-msg-action-btn">
                            External Bookmark
                        </button>
                    ),
                })

                // Titlebar right slot
                context.registerSlotComponent('layout.titlebar.right', {
                    id: 'ext-titlebar-action',
                    pluginId: context.manifest.id,
                    order: 5,
                    component: () => (
                        <div data-testid="ext-titlebar-widget">
                            <span>Ext Status</span>
                        </div>
                    ),
                })

                // Settings section
                context.registerSettingsSection({
                    id: 'ext-settings-section',
                    labelKey: 'External Tools',
                    order: 60,
                    component: () => (
                        <div data-testid="ext-settings-content">
                            <h2>External Plugin Configuration</h2>
                        </div>
                    ),
                })
            },
        })

        // Load and activate external plugin
        await act(async () => {
            await rendererPluginRuntime.registerPlugin(manifest, entry, { source: { kind: 'project-config', spec: 'external.multi-slot@1.0.0' } })
            await rendererPluginRuntime.activatePlugin(manifest.id)
        })

        // 1. Verify Sidebar slot coexistence
        const { unmount: unmountSidebar } = render(<Sidebar />)
        expect(screen.getByTestId('ext-sidebar-btn')).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'New chat' })).toBeInTheDocument()
        expect(screen.getByText('Integration Test Session')).toBeInTheDocument()
        unmountSidebar()

        // 2. Verify TitleBar slot coexistence
        const { unmount: unmountTitlebar } = render(
            <MainTitleBar
                leftSidebarCollapsed={false}
                showPinnedSummaryToggle={true}
                reserveWindowToolbar={false}
                sessionTitle="Integration Test Session"
            />
        )
        expect(screen.getByTestId('ext-titlebar-widget')).toBeInTheDocument()
        expect(screen.getByText('Integration Test Session')).toBeInTheDocument()
        unmountTitlebar()

        // 3. Verify Composer slot coexistence
        const { unmount: unmountComposer } = render(
            <Composer onSend={vi.fn()} />
        )
        expect(screen.getByTestId('ext-composer-btn')).toBeInTheDocument()
        expect(screen.getByRole('textbox', { name: 'Type anything' })).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Attach files' })).toBeInTheDocument()
        unmountComposer()

        // 4. Verify MessageItem slot coexistence
        const sampleMessage: DisplayChatMessage = {
            kind: 'message',
            id: 'm-1',
            sessionId: 'sess-1',
            role: 'user',
            content: 'Hello CPA with external plugin',
            createdAt: '2026-01-01T00:00:00Z',
        } as any
        const { unmount: unmountMessage } = render(
            <MessageItem
                message={sampleMessage as any}
                onApproveTool={vi.fn()}
                onRejectTool={vi.fn()}
            />
        )
        expect(screen.getByTestId('ext-msg-action-btn')).toBeInTheDocument()
        expect(screen.getByText('Hello CPA with external plugin')).toBeInTheDocument()
        unmountMessage()

        // 5. Verify SettingsPanel dynamic section coexistence
        useUiStore.setState({ settingsOpen: true })
        const { unmount: unmountSettings } = render(<SettingsPanel />)

        const extNavButton = screen.getByRole('button', { name: 'External Tools' })
        expect(extNavButton).toBeInTheDocument()

        await act(async () => {
            fireEvent.click(extNavButton)
        })
        expect(screen.getByTestId('ext-settings-content')).toBeInTheDocument()
        expect(screen.getByText('External Plugin Configuration')).toBeInTheDocument()
        unmountSettings()
    })

    it('hot-plugs, deactivates, and reactivates external plugins cleanly without disturbing core features', async () => {
        const manifest: PluginManifest = {
            id: 'external.hotplug',
            name: 'External Hotplug Plugin',
            version: '2.0.0',
            apiVersion: '1.0.0',
            engines: { cpa: '>=1.0.0' },
            entries: { renderer: './index.ts' },
            dependencies: {},
            capabilities: [],
            contributes: {
                slot: ['hotplug-sidebar-btn', 'hotplug-composer-btn'],
            },
        }

        const entry = definePluginEntry({
            runtime: 'renderer',
            activate: (context: any) => {
                context.registerSlotComponent('layout.sidebar.nav.top', {
                    id: 'hotplug-sidebar-btn',
                    pluginId: context.manifest.id,
                    component: () => (
                        <button type="button" data-testid="hotplug-sidebar-btn">
                            Hotplug Button
                        </button>
                    ),
                })
                context.registerSlotComponent('composer.toolbar.left', {
                    id: 'hotplug-composer-btn',
                    pluginId: context.manifest.id,
                    component: () => (
                        <button type="button" data-testid="hotplug-composer-btn">
                            Hotplug Composer Action
                        </button>
                    ),
                })
            },
        })

        await rendererPluginRuntime.registerPlugin(manifest, entry, { source: { kind: 'project-config', spec: 'external.hotplug@2.0.0' } })
        await rendererPluginRuntime.activatePlugin(manifest.id)
        expect(rendererPluginRuntime.isPluginActive('external.hotplug')).toBe(true)

        // Render AppShell with active external plugin
        const { rerender } = render(<AppShell />)

        expect(screen.getByTestId('hotplug-sidebar-btn')).toBeInTheDocument()
        expect(screen.getByTestId('hotplug-composer-btn')).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'New chat' })).toBeInTheDocument()

        // Deactivate plugin
        await rendererPluginRuntime.deactivatePlugin('external.hotplug')
        expect(rendererPluginRuntime.isPluginActive('external.hotplug')).toBe(false)

        rerender(<AppShell />)

        // Custom plugin contributions should be cleanly removed
        expect(screen.queryByTestId('hotplug-sidebar-btn')).not.toBeInTheDocument()
        expect(screen.queryByTestId('hotplug-composer-btn')).not.toBeInTheDocument()

        // Core features remain fully functional
        expect(screen.getByRole('button', { name: 'New chat' })).toBeInTheDocument()
        expect(screen.getByTestId('composer-input')).toBeInTheDocument()

        // Reactivate plugin
        await rendererPluginRuntime.activatePlugin('external.hotplug')
        expect(rendererPluginRuntime.isPluginActive('external.hotplug')).toBe(true)

        rerender(<AppShell />)

        // Custom plugin contributions reappear
        expect(screen.getByTestId('hotplug-sidebar-btn')).toBeInTheDocument()
        expect(screen.getByTestId('hotplug-composer-btn')).toBeInTheDocument()
    })

    it('enforces isCore=false for external plugins and manages them in Settings PluginsSection UI', async () => {
        const user = userEvent.setup()

        const manifest: PluginManifest = {
            id: 'external.audited',
            name: 'Audited External Plugin',
            version: '1.5.0',
            apiVersion: '1.0.0',
            engines: { cpa: '>=1.0.0' },
            description: 'Verified third-party plugin',
            author: 'Open Source Community',
            criticality: 'optional',
            entries: { renderer: './index.ts' },
            dependencies: {},
            capabilities: [],
            contributes: {
                slot: ['audited-ext-tool'],
            },
        }

        const entry = definePluginEntry({
            runtime: 'renderer',
            activate: (context: any) => {
                context.registerSlotComponent('composer.toolbar.left', {
                    id: 'audited-ext-tool',
                    pluginId: context.manifest.id,
                    component: () => <span data-testid="audited-ext-tool">Audited Tool</span>,
                })
            },
        })

        await act(async () => {
            await rendererPluginRuntime.registerPlugin(manifest, entry, { source: { kind: 'project-config', spec: 'external.audited@1.5.0' } })
            await rendererPluginRuntime.activatePlugin(manifest.id)
        })

        const summary = rendererPluginRuntime
            .getPluginSummaries()
            .find((p) => p.manifest.id === 'external.audited')

        expect(summary?.isCore).toBe(false)

        render(<PluginsSection runtime={rendererPluginRuntime} />)

        const pluginRow = await screen.findByTestId('plugin-row-external.audited')
        expect(pluginRow).toBeInTheDocument()
        expect(within(pluginRow).getByText('Audited External Plugin')).toBeInTheDocument()
        expect(within(pluginRow).getByText('External')).toBeInTheDocument()
        expect(within(pluginRow).getByText('Active')).toBeInTheDocument()

        // Disable plugin via UI button
        const disableBtn = within(pluginRow).getByRole('button', { name: 'Disable' })
        await user.click(disableBtn)

        await waitFor(() => {
            expect(rendererPluginRuntime.isPluginActive('external.audited')).toBe(false)
        })

        // Enable plugin via UI button
        const enableBtn = within(pluginRow).getByRole('button', { name: 'Enable' })
        await user.click(enableBtn)

        await waitFor(() => {
            expect(rendererPluginRuntime.isPluginActive('external.audited')).toBe(true)
        })
    })

    it('isolates crashing external slot contributions using SlotErrorBoundary without breaking host views', async () => {
        const manifest: PluginManifest = {
            id: 'external.buggy',
            name: 'Buggy External Plugin',
            version: '0.0.1',
            apiVersion: '1.0.0',
            engines: { cpa: '>=1.0.0' },
            criticality: 'optional',
            entries: { renderer: './index.ts' },
            dependencies: {},
            capabilities: [],
            contributes: {
                slot: ['crashing-nav-item'],
            },
        }

        const entry = definePluginEntry({
            runtime: 'renderer',
            activate: (context: any) => {
                context.registerSlotComponent('layout.sidebar.nav.top', {
                    id: 'crashing-nav-item',
                    pluginId: context.manifest.id,
                    component: () => {
                        throw new Error('Crashing during sidebar render')
                    },
                })
            },
        })

        await rendererPluginRuntime.registerPlugin(manifest, entry, { source: { kind: 'project-config', spec: 'external.buggy@0.0.1' } })
        await rendererPluginRuntime.activatePlugin('external.buggy')

        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

        render(<Sidebar />)

        // Core Sidebar components still render safely
        expect(screen.getByRole('button', { name: 'New chat' })).toBeInTheDocument()
        expect(screen.getByText('Integration Test Session')).toBeInTheDocument()

        // Error boundary fallback captures the broken contribution
        expect(screen.getByTestId('slot-error-crashing-nav-item')).toBeInTheDocument()

        consoleSpy.mockRestore()
    })

    it('integrates manage_todo_list agent tool with live Composer UI progress bar', async () => {
        const tool = createManageTodoListTool()
        expect(tool).toBeDefined()

        const getBoundingClientRectSpy = vi
            .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
            .mockImplementation(function (this: HTMLElement) {
                if (this.getAttribute('data-element') === 'composer-container') {
                    return {
                        top: 400,
                        left: 100,
                        width: 800,
                        height: 120,
                        right: 900,
                        bottom: 520,
                        x: 100,
                        y: 400,
                        toJSON: () => {},
                    } as DOMRect
                }
                return {
                    top: 0,
                    left: 0,
                    width: 0,
                    height: 0,
                    right: 0,
                    bottom: 0,
                    x: 0,
                    y: 0,
                    toJSON: () => {},
                } as DOMRect
            })

        const { rerender } = render(
            <div data-element="composer-container">
                <ComposerContainer />
                <FloatingOverlayHost context={{ sessionId: 'sess-1' }} />
            </div>
        )

        // Initial state: no todo items, overlay should not be visible
        expect(screen.queryByTestId('todo-progress-container')).toBeNull()

        // 1. Tool execution: set initial todo list with 3 items
        await tool.execute(
            'call-1',
            {
                operation: 'write',
                todoList: [
                    { id: 1, title: 'Task 1: Setup project', status: 'completed' },
                    { id: 2, title: 'Task 2: Write tests', status: 'not-started' },
                    { id: 3, title: 'Task 3: Implement feature', status: 'not-started' },
                ],
            },
            { sessionId: 'sess-1' }
        )

        // Re-render container to reflect Zustand store updates
        rerender(
            <div data-element="composer-container">
                <ComposerContainer />
                <FloatingOverlayHost context={{ sessionId: 'sess-1' }} />
            </div>
        )

        // Progress floating bar should now appear above composer
        const progressOverlay = await screen.findByTestId('todo-progress-container')
        expect(progressOverlay).toBeInTheDocument()
        expect(screen.getByTestId('todo-progress-pill')).toBeInTheDocument()

        // Hover over progress bar to display popover
        fireEvent.mouseEnter(progressOverlay)

        expect(await screen.findByTestId('todo-progress-popover')).toBeInTheDocument()
        expect(screen.getByText('Task 1: Setup project')).toBeInTheDocument()
        expect(screen.getByText('Task 2: Write tests')).toBeInTheDocument()

        // 2. Tool execution: update task 2 to completed
        await tool.execute(
            'call-2',
            {
                operation: 'write',
                todoList: [
                    { id: 1, title: 'Task 1: Setup project', status: 'completed' },
                    { id: 2, title: 'Task 2: Write tests', status: 'completed' },
                    { id: 3, title: 'Task 3: Implement feature', status: 'not-started' },
                ],
            },
            { sessionId: 'sess-1' }
        )

        rerender(
            <div data-element="composer-container">
                <ComposerContainer />
                <FloatingOverlayHost context={{ sessionId: 'sess-1' }} />
            </div>
        )

        // 3. Tool execution: clear list
        await tool.execute('call-3', { operation: 'write', todoList: [] }, { sessionId: 'sess-1' })

        rerender(
            <div data-element="composer-container">
                <ComposerContainer />
                <FloatingOverlayHost context={{ sessionId: 'sess-1' }} />
            </div>
        )

        expect(screen.queryByTestId('todo-progress-container')).toBeNull()

        getBoundingClientRectSpy.mockRestore()
    })

    it('wraps extensible components dynamically via external plugin component wrappers', async () => {
        interface CardProps {
            title: string
            children?: ReactNode
        }

        const BaseCard = ({ title, children }: CardProps) => (
            <div data-testid="base-card">
                <h3 data-testid="base-card-title">{title}</h3>
                <div data-testid="base-card-content">{children}</div>
            </div>
        )

        const ExtensibleCard = createExtensibleComponent<CardProps>(
            'TestCard',
            BaseCard
        )

        const wrappingManifest: PluginManifest = {
            id: 'external.card-decorator',
            name: 'External Card Decorator',
            version: '1.0.0',
            apiVersion: '1.0.0',
            engines: { cpa: '>=1.0.0' },
            criticality: 'optional',
            entries: { renderer: './index.ts' },
            dependencies: {},
            capabilities: [],
            contributes: {
                'component-wrapper': ['card-border-decorator'],
            },
        }
        const wrappingEntry = definePluginEntry({
            runtime: 'renderer',
            activate: (context: any) => {
                context.registerComponentWrapper({
                    id: 'card-border-decorator',
                    pluginId: context.manifest.id,
                    targetComponent: 'TestCard',
                    order: 10,
                    wrapper: (Next: any) => (props: any) => (
                        <div
                            data-testid="decorated-card-shell"
                            className="p-4 border-2 border-indigo-500 rounded-lg shadow"
                        >
                            <span data-testid="decorator-badge">Plugin Decorated</span>
                            <Next {...props} />
                        </div>
                    ),
                })
            },
        })

        // Before plugin registration, renders raw component
        const { unmount } = render(
            <ExtensibleCard title="Vanilla Card">
                <p>Vanilla Content</p>
            </ExtensibleCard>
        )
        expect(screen.getByTestId('base-card')).toBeInTheDocument()
        expect(screen.getByTestId('base-card-title')).toHaveTextContent('Vanilla Card')
        expect(screen.getByTestId('base-card-content')).toHaveTextContent('Vanilla Content')
        expect(screen.queryByTestId('decorated-card-shell')).toBeNull()
        unmount()

        // Load and activate external plugin
        await act(async () => {
            await rendererPluginRuntime.registerPlugin(wrappingManifest, wrappingEntry, { source: { kind: 'project-config', spec: 'external.card-decorator@1.0.0' } })
            await rendererPluginRuntime.activatePlugin(wrappingManifest.id)
        })
        expect(rendererPluginRuntime.isPluginActive('external.card-decorator')).toBe(true)

        const { rerender } = render(
            <ExtensibleCard title="Decorated Card">
                <p>Card Body</p>
            </ExtensibleCard>
        )

        // Plugin wrapper surrounds the base component
        expect(screen.getByTestId('decorated-card-shell')).toBeInTheDocument()
        expect(screen.getByTestId('decorator-badge')).toHaveTextContent('Plugin Decorated')
        expect(screen.getByTestId('base-card-title')).toHaveTextContent('Decorated Card')
        expect(screen.getByTestId('base-card-content')).toHaveTextContent('Card Body')

        // Deactivate plugin
        await act(async () => {
            await rendererPluginRuntime.deactivatePlugin('external.card-decorator')
        })
        expect(rendererPluginRuntime.isPluginActive('external.card-decorator')).toBe(false)

        rerender(
            <ExtensibleCard title="Decorated Card">
                <p>Card Body</p>
            </ExtensibleCard>
        )

        // Wrapper is cleanly removed
        expect(screen.queryByTestId('decorated-card-shell')).toBeNull()
        expect(screen.queryByTestId('decorator-badge')).toBeNull()
        expect(screen.getByTestId('base-card-title')).toHaveTextContent('Decorated Card')
    })
})
