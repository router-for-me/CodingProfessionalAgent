import {
    act,
    fireEvent,
    render,
    screen,
    waitFor,
    within,
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '@/i18n'
import { setDefaultHostServices, WorkspaceVisibilityProvider } from '@cpa/plugin-ui'
import type { AppSettings, ModelCatalogEntry, Project, SessionItem } from '@cpa/plugin-api'
import { rendererPluginRuntime } from '@/plugins/platform/RendererPluginRuntimeHost'
import manifest from '../../manifest.json'
import { composerRendererEntry } from '../index.js'
import { Composer, MAX_IMAGE_INPUT_BYTES, type ComposerSendPayload } from './Composer.js'
import { createBrowserImageProcessor, type ImageProcessor } from '../utils/image.js'

function expectComposerValue(value: string) {
    expect(screen.getByTestId('composer-input')).toHaveAttribute(
        'data-value',
        value,
    )
}

function jpegFile(name = 'photo.jpg'): File {
    const bytes = new Uint8Array([
        0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
    ])
    return new File([bytes], name, { type: 'image/jpeg' })
}

function fakeTextFile(name = 'notes.txt'): File {
    return new File([new TextEncoder().encode('hello')], name, {
        type: 'text/plain',
    })
}

function createClipboardData(): DataTransfer & { store: Record<string, string> } {
    const store: Record<string, string> = {}
    return {
        store,
        setData: (format: string, data: string) => {
            store[format] = data
        },
        getData: (format: string) => store[format] ?? '',
        clearData: (format?: string) => {
            if (format) delete store[format]
            else Object.keys(store).forEach((k) => delete store[k])
        },
        types: [],
        files: [] as unknown as FileList,
        items: [] as unknown as DataTransferItemList,
        dropEffect: 'none',
        effectAllowed: 'uninitialized',
    } as unknown as DataTransfer & { store: Record<string, string> }
}

function installImageBitmapMock(): void {
    vi.stubGlobal(
        'createImageBitmap',
        vi.fn(async () => ({
            width: 100,
            height: 80,
            close: vi.fn(),
        })),
    )
}

const visionModel: ModelCatalogEntry = {
    id: 'vision-model',
    label: 'Vision',
    supportsFast: false,
    reasoningLevels: [],
    input: ['text', 'image'],
    contextWindow: 128_000,
    maxTokens: 8_192,
}

const textModel: ModelCatalogEntry = {
    id: 'text-model',
    label: 'Text Only',
    supportsFast: false,
    reasoningLevels: [],
    input: ['text'],
    contextWindow: 128_000,
    maxTokens: 8_192,
}

let settingsState: AppSettings
let modelsState: readonly ModelCatalogEntry[]
let sessionsState: SessionItem[]
let projectsState: Project[]
let activeRunsState: Record<string, any>
let worktreeSetupsState: Record<string, any>
let composerDraftsState: Record<string, string>
let pendingSessionContextState: any
let toastsState: string[]
let usageCountsState: Record<string, number>
let currentSessionIdState: string | null
let mockServices: any
let cachedUiSnapshot: any

let settingsListeners: Set<() => void>
let sessionsListeners: Set<() => void>
let projectsListeners: Set<() => void>
let uiListeners: Set<() => void>
let runsListeners: Set<() => void>
let skillUsageListeners: Set<() => void>

function notifySettings() {
    for (const l of settingsListeners) l()
}
function notifySessions() {
    for (const l of sessionsListeners) l()
}
function notifyProjects() {
    for (const l of projectsListeners) l()
}
function notifyUi() {
    cachedUiSnapshot = {
        composerDraft: composerDraftsState['new-chat'] ?? '',
        composerDrafts: { ...composerDraftsState },
        pendingSessionContext: { ...pendingSessionContextState },
        toasts: [...toastsState],
    }
    for (const l of uiListeners) l()
}
function notifyRuns() {
    for (const l of runsListeners) l()
}
function notifySkillUsage() {
    for (const l of skillUsageListeners) l()
}

function resetTestServices() {
    settingsListeners = new Set()
    sessionsListeners = new Set()
    projectsListeners = new Set()
    uiListeners = new Set()
    runsListeners = new Set()
    skillUsageListeners = new Set()

    settingsState = {
        theme: 'dark',
        locale: 'zh-CN',
        modelId: visionModel.id,
        reasoningLevel: 'off',
        speed: 'standard',
        compactionThresholdPercent: 80,
        fastContextCompaction: true,
        showInMenuBar: true,
        showBottomPanel: true,
        terminalPosition: 'bottom',
        cliProxyApi: { baseUrl: '', apiKey: '' },
    }
    modelsState = [visionModel, textModel]
    sessionsState = []
    projectsState = [
        {
            id: 'project-1',
            name: 'Example Project',
            path: '/workspace/example',
            pinned: false,
            createdAt: 1,
            updatedAt: 1,
        },
    ]
    activeRunsState = {}
    worktreeSetupsState = {}
    composerDraftsState = {}
    pendingSessionContextState = { projectId: null, branch: null }
    toastsState = []
    usageCountsState = {}
    currentSessionIdState = null

    cachedUiSnapshot = {
        composerDraft: '',
        composerDrafts: {},
        pendingSessionContext: { projectId: null, branch: null },
        toasts: [],
    }

    mockServices = {
        settings: {
            getSnapshot: () => settingsState,
            subscribe: (listener: () => void) => {
                settingsListeners.add(listener)
                return () => settingsListeners.delete(listener)
            },
            setModelId: vi.fn((id: string) => {
                settingsState = { ...settingsState, modelId: id }
                notifySettings()
            }),
            setReasoningLevel: vi.fn((level: string) => {
                settingsState = { ...settingsState, reasoningLevel: level }
                notifySettings()
            }),
            setSpeed: vi.fn((spd: any) => {
                settingsState = { ...settingsState, speed: spd }
                notifySettings()
            }),
        },
        models: {
            getModels: () => modelsState,
            getStatus: () => 'ready',
            getError: () => null,
            subscribe: (listener: () => void) => () => {},
        },
        sessions: {
            getSnapshot: () => sessionsState,
            subscribe: (listener: () => void) => {
                sessionsListeners.add(listener)
                return () => sessionsListeners.delete(listener)
            },
            getCurrentSessionId: () => currentSessionIdState,
            setCurrentSessionId: (id: string | null) => {
                currentSessionIdState = id
                notifySessions()
            },
            getActiveRun: (sessionId: string) => activeRunsState[sessionId],
            subscribeRuns: (listener: () => void) => {
                runsListeners.add(listener)
                return () => runsListeners.delete(listener)
            },
            setProject: vi.fn((sessionId: string, projId: string | null) => {
                const s = sessionsState.find((item) => item.id === sessionId)
                if (s) s.projectId = projId ?? undefined
                notifySessions()
            }),
            setBranch: vi.fn((sessionId: string, br: string | null) => {
                const s = sessionsState.find((item) => item.id === sessionId)
                if (s) s.branch = br ?? undefined
                notifySessions()
            }),
            setSessionRuntimeSettings: vi.fn(
                (
                    sessionId: string,
                    patch: { modelId?: string; reasoningEffort?: string; speed?: any },
                ) => {
                    const session = sessionsState.find((s) => s.id === sessionId)
                    if (session) {
                        if (patch.modelId !== undefined) session.modelId = patch.modelId
                        if (patch.reasoningEffort !== undefined)
                            session.reasoningEffort = patch.reasoningEffort
                        if (patch.speed !== undefined) session.speed = patch.speed
                    }
                    notifySessions()
                },
            ),
            update: vi.fn(async (sessionId: string, patch: any) => {
                const session = sessionsState.find((s) => s.id === sessionId)
                if (session) {
                    Object.assign(session, patch)
                }
                notifySessions()
            }),
            setWorktree: vi.fn(async (sessionId: string, setup: any) => {
                const session = sessionsState.find((s) => s.id === sessionId)
                if (session) {
                    session.worktreeSetup = {
                        ...(session.worktreeSetup as any),
                        ...setup,
                    }
                }
                notifySessions()
            }),
        },
        projects: {
            getSnapshot: () => projectsState,
            subscribe: (listener: () => void) => {
                projectsListeners.add(listener)
                return () => projectsListeners.delete(listener)
            },
            save: vi.fn(async (p: Project) => {
                projectsState.push(p)
                notifyProjects()
            }),
        },
        ui: {
            getSnapshot: () => cachedUiSnapshot,
            subscribe: (listener: () => void) => {
                uiListeners.add(listener)
                return () => uiListeners.delete(listener)
            },
            getPendingSessionContext: () => pendingSessionContextState,
            setPendingSessionContext: vi.fn((ctx: any) => {
                pendingSessionContextState = { ...pendingSessionContextState, ...ctx }
                notifyUi()
            }),
            getComposerDraft: (key: string) => composerDraftsState[key],
            setComposerDraft: vi.fn((key: string, draft: string) => {
                composerDraftsState[key] = draft
                notifyUi()
            }),
            pushToast: vi.fn((msg: string) => {
                toastsState.push(msg)
                notifyUi()
            }),
        },
        chatMessages: {
            getWorktreeSetup: (sessionId: string) => worktreeSetupsState[sessionId],
            getEntries: (sessionId: string) => [],
        },
        fileSystem: {
            selectFilesAndFolders: undefined,
            readFile: vi.fn(async (path: string) => ({ dataBase64: '' })),
        },
        skillUsage: {
            fetchUsageCounts: vi.fn(async () => usageCountsState),
            recordUsage: vi.fn((skillName: string) => {
                const key = String(skillName ?? '').trim().toLowerCase()
                if (!key) return
                usageCountsState = {
                    ...usageCountsState,
                    [key]: (usageCountsState[key] || 0) + 1,
                }
                notifySkillUsage()
            }),
            getSnapshot: () => usageCountsState,
            subscribe: (listener: () => void) => {
                skillUsageListeners.add(listener)
                return () => skillUsageListeners.delete(listener)
            },
        },
    }
    setDefaultHostServices(mockServices)
}

beforeEach(async () => {
    await i18n.changeLanguage('en')
    resetTestServices()
    installImageBitmapMock()
    await rendererPluginRuntime.registerPlugin({ manifest, ...composerRendererEntry } as any)
    await rendererPluginRuntime.activatePlugin('cpa.core.composer')
})

afterEach(async () => {
    await rendererPluginRuntime.reset()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

describe('Composer model selector sizing (regression)', () => {
    it('keeps the closed model trigger compact and expands it to the menu width', async () => {
        const user = userEvent.setup()
        render(<Composer onSend={() => undefined} />)

        const trigger = screen.getByRole('button', { name: 'Model' })
        const modelSelect = trigger.parentElement
        const controlGroup = modelSelect?.parentElement

        expect(controlGroup).toHaveClass('flex-1', 'min-w-0')
        expect(modelSelect).toHaveClass('relative', 'w-max', 'shrink-0')
        expect(modelSelect).not.toHaveClass('w-[234px]')
        expect(modelSelect).not.toHaveClass('min-w-0')
        expect(trigger).toHaveClass(
            'w-max',
            'px-[10px]',
            'hover:bg-[var(--bg-sidebar-hover)]',
        )
        expect(trigger).not.toHaveClass('w-full')
        expect(trigger).not.toHaveClass('bg-[var(--bg-sidebar-hover)]')
        expect(trigger).not.toHaveStyle({ width: '234px' })
        expect(screen.getByRole('button', { name: 'Send' })).toHaveClass('shrink-0')

        await user.click(trigger)
        expect(trigger).toHaveStyle({ width: '234px' })
        expect(trigger).toHaveClass('bg-[var(--bg-sidebar-hover)]')
    })

    it('passes the active session to the locked model selector', () => {
        sessionsState = [
            {
                id: 'session-locked-model',
                title: 'Locked session',
                pinned: false,
                modelId: textModel.id,
                reasoningEffort: 'high',
                speed: 'standard',
                createdAt: 1,
                updatedAt: 1,
            },
        ]
        render(
            <Composer
                sessionId="session-locked-model"
                onSend={() => undefined}
            />,
        )

        const trigger = screen.getByRole('button', { name: 'Model' })
        expect(trigger).toHaveTextContent('Text Only')
    })

    it('does not render the voice input button', () => {
        render(<Composer onSend={() => undefined} />)
        expect(
            screen.queryByRole('button', { name: /voice/i }),
        ).not.toBeInTheDocument()
    })

    it('renders context usage ring on the left of model select', () => {
        render(<Composer onSend={() => undefined} />)
        const ring = screen.getByTestId('context-usage-ring')
        const modelBtn = screen.getByRole('button', { name: 'Model' })
        expect(ring).toBeInTheDocument()
        expect(modelBtn).toBeInTheDocument()

        const container = ring.parentElement!
        const children = Array.from(container.children)
        const ringWrapperIndex = children.findIndex((c) => c.contains(ring))
        const modelWrapperIndex = children.findIndex((c) => c.contains(modelBtn))
        expect(ringWrapperIndex).toBeLessThan(modelWrapperIndex)
    })

    it('hides context usage ring when showContextUsage is false in settings', () => {
        settingsState = {
            ...settingsState,
            editor: { showContextUsage: false, sendShortcut: 'cmdEnter', followUpMode: 'steer' },
        }
        render(<Composer onSend={() => undefined} />)
        expect(screen.queryByTestId('context-usage-ring')).not.toBeInTheDocument()
    })
})

describe('Composer pending session context', () => {
    it('shows a sidebar-selected project and sends it on the first message', async () => {
        const user = userEvent.setup()
        pendingSessionContextState = {
            projectId: 'project-1',
            branch: 'feature/login',
        }
        notifyUi()

        let sentPayload: ComposerSendPayload | null = null
        render(
            <Composer
                onSend={(payload) => {
                    sentPayload = payload
                }}
            />,
        )

        expect(screen.getByRole('button', { name: 'Change project for this chat' })).toHaveTextContent('Example Project')
        expect(screen.getByRole('button', { name: /Select branch|feature\/login/i })).toHaveTextContent(
            'feature/login',
        )

        const textarea = screen.getByTestId('composer-input')
        await user.type(textarea, 'First prompt')
        await user.click(screen.getByRole('button', { name: 'Send' }))

        expect(sentPayload).toMatchObject({
            text: 'First prompt',
            projectId: 'project-1',
            branch: 'feature/login',
        })
    })
})

describe('Composer per-session drafts', () => {
    it('keeps unsent input isolated when switching between sessions', async () => {
        const user = userEvent.setup()
        sessionsState = [
            { id: 'sess-a', title: 'A', pinned: false, createdAt: 1, updatedAt: 1 },
            { id: 'sess-b', title: 'B', pinned: false, createdAt: 2, updatedAt: 2 },
        ]

        const { rerender } = render(
            <Composer sessionId="sess-a" onSend={() => undefined} />,
        )

        const input = screen.getByTestId('composer-input')
        await user.type(input, 'Draft for session A')
        expectComposerValue('Draft for session A')

        rerender(<Composer sessionId="sess-b" onSend={() => undefined} />)
        expectComposerValue('')

        await user.type(input, 'Draft for session B')
        expectComposerValue('Draft for session B')

        rerender(<Composer sessionId="sess-a" onSend={() => undefined} />)
        expectComposerValue('Draft for session A')

        rerender(<Composer sessionId={null} onSend={() => undefined} />)
        expectComposerValue('')

        await user.type(input, 'Draft for new session')
        expectComposerValue('Draft for new session')

        rerender(<Composer sessionId="sess-b" onSend={() => undefined} />)
        expectComposerValue('Draft for session B')

        rerender(<Composer sessionId={null} onSend={() => undefined} />)
        expectComposerValue('Draft for new session')
    })
})

describe('Composer slash commands', () => {
    it('calls onCompact for /compact and never onSend', async () => {
        const user = userEvent.setup()
        const onSend = vi.fn()
        const onCompact = vi.fn(async () => undefined)

        render(<Composer onSend={onSend} onCompact={onCompact} />)

        const textarea = screen.getByTestId('composer-input')
        await user.type(textarea, '/compact focus on auth')
        await user.click(screen.getByRole('button', { name: 'Send' }))

        expect(onCompact).toHaveBeenCalledWith('focus on auth')
        expect(onSend).not.toHaveBeenCalled()
        expectComposerValue('')
    })

    it('calls onCompact for localized /压缩 and extracts focus parameter', async () => {
        const user = userEvent.setup()
        const onSend = vi.fn()
        const onCompact = vi.fn(async () => undefined)

        render(<Composer onSend={onSend} onCompact={onCompact} />)

        const textarea = screen.getByTestId('composer-input')
        await user.type(textarea, '/压缩 重点关注权限模块')
        await user.click(screen.getByRole('button', { name: 'Send' }))

        expect(onCompact).toHaveBeenCalledWith('重点关注权限模块')
        expect(onSend).not.toHaveBeenCalled()
        expectComposerValue('')
    })

    it('opens model selector and clears draft when /model is submitted', async () => {
        const user = userEvent.setup()
        const onSend = vi.fn()

        render(<Composer onSend={onSend} />)

        const textarea = screen.getByTestId('composer-input')
        await user.type(textarea, '/model')
        await user.click(screen.getByRole('button', { name: 'Send' }))

        expect(onSend).not.toHaveBeenCalled()
        expectComposerValue('')
        // Quick model picker listbox is opened
        expect(screen.getByRole('listbox', { name: /model/i })).toBeInTheDocument()
    })

    it('opens model selector and clears draft when localized /模型 is submitted', async () => {
        const user = userEvent.setup()
        const onSend = vi.fn()

        render(<Composer onSend={onSend} />)

        const textarea = screen.getByTestId('composer-input')
        await user.type(textarea, '/模型')
        await user.click(screen.getByRole('button', { name: 'Send' }))

        expect(onSend).not.toHaveBeenCalled()
        expectComposerValue('')
        expect(screen.getByRole('listbox', { name: /model/i })).toBeInTheDocument()
    })

    it('opens model selector when model suggestion is selected from slash menu', async () => {
        const user = userEvent.setup()
        const onSend = vi.fn()

        render(<Composer onSend={onSend} />)

        const textarea = screen.getByTestId('composer-input')
        await user.type(textarea, '/mod')

        // Slash menu is visible with /model option
        const modelOption = screen.getByRole('option', { name: /\/model/i })
        expect(modelOption).toBeInTheDocument()

        // Select the model option
        await user.click(modelOption)

        // Draft is cleared and model selector is opened
        expectComposerValue('')
        expect(screen.getByRole('listbox', { name: /model/i })).toBeInTheDocument()
    })

    it('clears composer input immediately before compaction completes', async () => {
        const user = userEvent.setup()
        let resolveCompact!: () => void
        const compactPromise = new Promise<void>((resolve) => {
            resolveCompact = resolve
        })
        const onCompact = vi.fn(() => compactPromise)

        render(<Composer onSend={() => undefined} onCompact={onCompact} />)

        const textarea = screen.getByTestId('composer-input')
        await user.type(textarea, '/compact focus on auth')
        await user.click(screen.getByRole('button', { name: 'Send' }))

        expect(onCompact).toHaveBeenCalledWith('focus on auth')
        // Cleared immediately upon send, before compaction finishes
        expectComposerValue('')

        resolveCompact()
        await act(async () => {
            await compactPromise
        })
        expectComposerValue('')
    })

    it('keeps draft when onCompact is missing; shows error toast when onCompact rejects', async () => {
        const user = userEvent.setup()
        const onCompact = vi.fn(async () => {
            throw new Error('compact failed')
        })

        const { rerender } = render(
            <Composer onSend={() => undefined} onCompact={onCompact} />,
        )

        const textarea = screen.getByTestId('composer-input')
        await user.type(textarea, '/compact')
        await user.click(screen.getByRole('button', { name: 'Send' }))

        expect(onCompact).toHaveBeenCalledWith('')
        // Input is cleared immediately upon send before compaction completes
        expectComposerValue('')
        expect(screen.getByText('compact failed')).toBeInTheDocument()

        rerender(<Composer onSend={() => undefined} onCompact={undefined} />)
        await user.type(textarea, '/compact')
        await user.click(screen.getByRole('button', { name: 'Send' }))
        expectComposerValue('/compact')
    })

    it('sets textarea aria-controls/expanded/activedescendant while slash menu is open', async () => {
        const user = userEvent.setup()
        render(<Composer onSend={() => undefined} />)

        const textarea = screen.getByTestId('composer-input')
        expect(textarea).not.toHaveAttribute('aria-controls')
        expect(textarea).toHaveAttribute('aria-expanded', 'false')

        await user.type(textarea, '/')
        expect(screen.getByRole('listbox')).toBeInTheDocument()
        expect(textarea).toHaveAttribute(
            'aria-controls',
            expect.stringMatching(/^slash-menu-/),
        )
        expect(textarea).toHaveAttribute('aria-expanded', 'true')
        expect(textarea).toHaveAttribute(
            'aria-activedescendant',
            expect.stringMatching(/^slash-menu-.*-opt-builtin-0-compact$/),
        )

        await user.keyboard('{ArrowDown}')
        expect(textarea).toHaveAttribute('aria-expanded', 'true')

        await user.keyboard('{Escape}')
        expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
        expect(textarea).not.toHaveAttribute('aria-controls')
    })

    it('releases slash snapshot on no-match so later prop updates can reopen', async () => {
        const user = userEvent.setup()
        const { rerender } = render(
            <Composer onSend={() => undefined} prompts={[]} />,
        )

        const textarea = screen.getByTestId('composer-input')
        await user.type(textarea, '/dyn')
        expect(screen.queryByRole('listbox')).not.toBeInTheDocument()

        rerender(
            <Composer
                onSend={() => undefined}
                prompts={[{ name: 'dynamic-template', description: 'dyn' }]}
            />,
        )

        expect(screen.getByRole('listbox')).toBeInTheDocument()
        expect(screen.getByText('/dynamic-template')).toBeInTheDocument()
    })

    it('assigns unique slash/model ARIA ids across two Composer instances', () => {
        render(
            <>
                <Composer onSend={() => undefined} />
                <Composer onSend={() => undefined} />
            </>,
        )

        const triggers = screen.getAllByRole('button', { name: 'Model' })
        expect(triggers).toHaveLength(2)
        const desc1 = triggers[0]!.getAttribute('aria-describedby')
        const desc2 = triggers[1]!.getAttribute('aria-describedby')
        expect(desc1).toBeTruthy()
        expect(desc2).toBeTruthy()
        expect(desc1).not.toBe(desc2)
    })

    it('disables compact while a run is active', async () => {
        const user = userEvent.setup()
        const onCompact = vi.fn()

        render(
            <Composer
                onSend={() => undefined}
                onCompact={onCompact}
                isStreaming={true}
            />,
        )

        const textarea = screen.getByTestId('composer-input')
        await user.type(textarea, '/compact')
        fireEvent.keyDown(textarea, { key: 'Enter' })

        expect(onCompact).not.toHaveBeenCalled()
    })

    it('keeps /skill:name folded on send instead of expanding the body', async () => {
        const user = userEvent.setup()
        let sent: ComposerSendPayload | null = null

        render(
            <Composer
                onSend={(p) => {
                    sent = p
                }}
                skills={[
                    {
                        name: 'demo',
                        description: 'demo skill',
                        body: 'EXPANDED_BODY_MUST_NOT_BE_SENT',
                    } as any,
                ]}
            />,
        )

        const textarea = screen.getByTestId('composer-input')
        await user.type(textarea, '/skill:demo extra')
        await user.click(screen.getByRole('button', { name: 'Send' }))

        expect(sent).toMatchObject({ text: '$demo extra' })
    })

    it('expands prompt templates and leaves unknown slash as plain text', async () => {
        const user = userEvent.setup()
        const sent: string[] = []

        render(
            <Composer
                onSend={(p) => {
                    sent.push(p.text)
                }}
                prompts={[
                    {
                        name: 'greet',
                        description: 'Greet',
                        content: 'Hello $1!',
                    },
                ]}
            />,
        )

        const textarea = screen.getByTestId('composer-input')
        await user.type(textarea, '/greet world')
        await user.click(screen.getByRole('button', { name: 'Send' }))
        expect(sent[0]).toBe('Hello world!')

        await user.type(textarea, '/unknown something')
        await user.click(screen.getByRole('button', { name: 'Send' }))
        expect(sent[1]).toBe('/unknown something')
    })
})

describe('Composer $ skill picker', () => {
    const testSkills = [
        { name: 'alpha', description: 'Alpha skill', filePath: '/skills/alpha/SKILL.md' },
        { name: 'beta', description: 'Beta skill', filePath: '/skills/beta/SKILL.md' },
        { name: 'gh-issue', description: 'GitHub Issue', filePath: '/skills/gh-issue/SKILL.md' },
    ]

    it('lists every loaded skill when the draft is $', async () => {
        const user = userEvent.setup()
        render(<Composer onSend={() => undefined} skills={testSkills as any} />)

        const textarea = screen.getByTestId('composer-input')
        await user.type(textarea, '$')

        const listbox = screen.getByRole('listbox', { name: 'Skills' })
        expect(listbox).toBeInTheDocument()
        expect(screen.getByText('Alpha')).toBeInTheDocument()
        expect(screen.getByText('Beta')).toBeInTheDocument()
        expect(screen.getByText('Gh Issue')).toBeInTheDocument()
    })

    it('temporarily hides an open skill menu with the workspace and restores it afterward', async () => {
        const user = userEvent.setup()
        const renderWorkspace = (visible: boolean) => (
            <WorkspaceVisibilityProvider visible={visible}>
                <div style={{ display: visible ? undefined : 'none' }} inert={!visible}>
                    <Composer onSend={() => undefined} skills={testSkills as any} />
                </div>
            </WorkspaceVisibilityProvider>
        )
        const { rerender } = render(renderWorkspace(true))

        const input = screen.getByTestId('composer-input')
        await user.type(input, '$')
        const menu = screen.getByRole('listbox', { name: 'Skills' })
        expect(menu).toBeVisible()

        rerender(renderWorkspace(false))
        expect(input).not.toBeVisible()
        expect(menu).not.toBeVisible()
        expect(input).toHaveAttribute('data-value', '$')

        rerender(renderWorkspace(true))
        expect(input).toBeVisible()
        expect(menu).toBeVisible()
    })

    it('filters the list as the user continues typing after $', async () => {
        const user = userEvent.setup()
        render(<Composer onSend={() => undefined} skills={testSkills as any} />)

        const textarea = screen.getByTestId('composer-input')
        await user.type(textarea, '$gh')

        expect(screen.getByText('Gh Issue')).toBeInTheDocument()
        expect(screen.queryByText('Alpha')).not.toBeInTheDocument()
    })

    it('inserts a skill chip on Enter and keeps the command folded on send', async () => {
        const user = userEvent.setup()
        let sent: ComposerSendPayload | null = null

        render(
            <Composer
                onSend={(p) => {
                    sent = p
                }}
                skills={testSkills as any}
            />,
        )

        const textarea = screen.getByTestId('composer-input')
        await user.type(textarea, '$')
        await user.keyboard('{Enter}')

        expect(screen.getByTestId('composer-skill-chip')).toHaveAttribute(
            'data-skill-name',
            'alpha',
        )

        await user.click(screen.getByRole('button', { name: 'Send' }))
        expect(sent).toMatchObject({ text: '$alpha' })
    })

    it('sends chip args typed after the selected skill', async () => {
        const user = userEvent.setup()
        let sent: ComposerSendPayload | null = null

        render(
            <Composer
                onSend={(p) => {
                    sent = p
                }}
                skills={testSkills as any}
            />,
        )

        const textarea = screen.getByTestId('composer-input')
        await user.type(textarea, '$')
        await user.keyboard('{Enter}')
        await user.type(textarea, '4937 please review')

        await user.click(screen.getByRole('button', { name: 'Send' }))
        expect(sent).toMatchObject({ text: '$alpha 4937 please review' })
    })

    it('removes the entire skill chip on Backspace at the start of the input', async () => {
        const user = userEvent.setup()
        render(<Composer onSend={() => undefined} skills={testSkills as any} />)

        const textarea = screen.getByTestId('composer-input')
        await user.type(textarea, '$')
        await user.keyboard('{Enter}')

        expect(screen.getByTestId('composer-skill-chip')).toBeInTheDocument()
        await user.keyboard('{Backspace}')
        expect(screen.queryByTestId('composer-skill-chip')).not.toBeInTheDocument()
    })

    it('sends $name args typed without using the picker', async () => {
        const user = userEvent.setup()
        let sent: ComposerSendPayload | null = null

        render(
            <Composer
                onSend={(p) => {
                    sent = p
                }}
                skills={testSkills as any}
            />,
        )

        const textarea = screen.getByTestId('composer-input')
        await user.type(textarea, '$beta 123')
        await user.click(screen.getByRole('button', { name: 'Send' }))

        expect(sent).toMatchObject({ text: '$beta 123' })
    })

    it('opens the skill picker when $ is typed in front of existing text', async () => {
        const user = userEvent.setup()
        render(<Composer onSend={() => undefined} skills={testSkills as any} />)

        const textarea = screen.getByTestId('composer-input')
        await user.type(textarea, 'some text')
        textarea.focus()

        // Move to start and type $
        fireEvent.input(textarea, { target: { textContent: '$some text' } })
        expect(screen.getByTestId('composer-input')).toBeInTheDocument()
    })

    it('keeps existing text after selecting a skill typed at the start', async () => {
        const user = userEvent.setup()
        let sent: ComposerSendPayload | null = null

        render(
            <Composer
                onSend={(p) => {
                    sent = p
                }}
                skills={testSkills as any}
            />,
        )

        const textarea = screen.getByTestId('composer-input')
        await user.type(textarea, '$')
        await user.keyboard('{Enter}')
        await user.type(textarea, 'followup')
        await user.click(screen.getByRole('button', { name: 'Send' }))

        expect(sent).toMatchObject({ text: '$alpha followup' })
    })

    it('sets textarea aria-controls while the skill menu is open', async () => {
        const user = userEvent.setup()
        render(<Composer onSend={() => undefined} skills={testSkills as any} />)

        const textarea = screen.getByTestId('composer-input')
        await user.type(textarea, '$')

        expect(textarea).toHaveAttribute(
            'aria-controls',
            expect.stringMatching(/^skill-menu-/),
        )
    })

    it('folds a pasted $skill command into the selected skill chip', async () => {
        render(<Composer onSend={() => undefined} skills={testSkills as any} />)

        const textarea = screen.getByTestId('composer-input')
        textarea.focus()

        fireEvent.paste(textarea, {
            clipboardData: {
                getData: (f: string) => (f === 'text/plain' ? '$alpha 4937' : ''),
            },
        })

        expect(screen.getByTestId('composer-skill-chip')).toHaveAttribute(
            'data-skill-name',
            'alpha',
        )
    })

    it('leaves pasted unknown or prefix-only $ tokens as plain text', async () => {
        render(<Composer onSend={() => undefined} skills={testSkills as any} />)

        const textarea = screen.getByTestId('composer-input')
        textarea.focus()

        fireEvent.paste(textarea, {
            clipboardData: {
                getData: (f: string) => (f === 'text/plain' ? '$unknown 4937' : ''),
            },
        })

        expect(screen.queryByTestId('composer-skill-chip')).not.toBeInTheDocument()
        expectComposerValue('$unknown 4937')
    })

    it('does not fold a $skill paste unless it replaces the whole draft', async () => {
        const user = userEvent.setup()
        render(<Composer onSend={() => undefined} skills={testSkills as any} />)

        const textarea = screen.getByTestId('composer-input')
        await user.type(textarea, 'existing')
        await userEvent.paste('$alpha')

        expect(screen.queryByTestId('composer-skill-chip')).not.toBeInTheDocument()
    })

    it('copies and cuts a selected skill chip as a $skill command', async () => {
        render(<Composer onSend={() => undefined} skills={testSkills as any} />)

        const textarea = screen.getByTestId('composer-input')
        textarea.focus()
        await userEvent.paste('$alpha 4937 describe this')

        await waitFor(() => {
            expect(screen.getByTestId('composer-skill-chip')).toHaveTextContent('Alpha')
        })

        const range = document.createRange()
        range.selectNodeContents(textarea)
        const selection = window.getSelection()
        selection?.removeAllRanges()
        selection?.addRange(range)

        const copied = createClipboardData()
        fireEvent.copy(textarea, { clipboardData: copied })
        expect(copied.store['text/plain']).toBe('$alpha 4937 describe this')

        const cut = createClipboardData()
        fireEvent.cut(textarea, { clipboardData: cut })
        expect(cut.store['text/plain']).toBe('$alpha 4937 describe this')
        expect(screen.queryByTestId('composer-skill-chip')).not.toBeInTheDocument()
        expectComposerValue('')
    })

    it('keeps an existing skill when another skill is inserted later', async () => {
        const user = userEvent.setup()
        let sent: ComposerSendPayload | null = null

        render(
            <Composer
                onSend={(p) => {
                    sent = p
                }}
                skills={testSkills as any}
            />,
        )

        const textarea = screen.getByTestId('composer-input')
        await user.type(textarea, '$')
        await user.keyboard('{Enter}')
        await user.type(textarea, 'then $beta')

        await user.click(screen.getByRole('button', { name: 'Send' }))
        expect(sent).toMatchObject({ text: '$alpha then $beta' })
    })

    it('orders skill suggestions by usage frequency then alphabetically in the composer dropdown', async () => {
        const user = userEvent.setup()
        const customSkills = [
            { name: 'zeta', description: 'Z', filePath: '/skills/zeta/SKILL.md' },
            { name: 'alpha', description: 'A', filePath: '/skills/alpha/SKILL.md' },
            { name: 'beta', description: 'B', filePath: '/skills/beta/SKILL.md' },
        ]
        const usageCounts = { beta: 50, zeta: 20 }

        render(
            <Composer
                onSend={() => undefined}
                skills={customSkills as any}
                skillUsageCounts={usageCounts}
            />,
        )

        const textarea = screen.getByTestId('composer-input')
        await user.type(textarea, '$')

        const options = screen.getAllByRole('option')
        expect(options.map((o) => o.textContent)).toEqual([
            expect.stringContaining('Beta'),
            expect.stringContaining('Zeta'),
            expect.stringContaining('Alpha'),
        ])
    })

    it('maintains usage frequency order when searching in the composer dropdown', async () => {
        const user = userEvent.setup()
        const customSkills = [
            { name: 'issue-fix', description: 'Fix', filePath: '/skills/1/SKILL.md' },
            { name: 'issue-view', description: 'View', filePath: '/skills/2/SKILL.md' },
        ]
        const usageCounts = { 'issue-view': 100, 'issue-fix': 10 }

        render(
            <Composer
                onSend={() => undefined}
                skills={customSkills as any}
                skillUsageCounts={usageCounts}
            />,
        )

        const textarea = screen.getByTestId('composer-input')
        await user.type(textarea, '$issue')

        const options = screen.getAllByRole('option')
        expect(options.map((o) => o.textContent)).toEqual([
            expect.stringContaining('Issue View'),
            expect.stringContaining('Issue Fix'),
        ])
    })

    it('orders skill suggestions from SkillUsageService snapshot when prop is omitted', async () => {
        const user = userEvent.setup()
        const customSkills = [
            { name: 'zeta', description: 'Z', filePath: '/skills/zeta/SKILL.md' },
            { name: 'alpha', description: 'A', filePath: '/skills/alpha/SKILL.md' },
            { name: 'beta', description: 'B', filePath: '/skills/beta/SKILL.md' },
        ]
        usageCountsState = { beta: 50, zeta: 20 }
        notifySkillUsage()

        render(
            <Composer
                onSend={() => undefined}
                skills={customSkills as any}
            />,
        )

        const textarea = screen.getByTestId('composer-input')
        await user.type(textarea, '$')

        const options = screen.getAllByRole('option')
        expect(options.map((o) => o.textContent)).toEqual([
            expect.stringContaining('Beta'),
            expect.stringContaining('Zeta'),
            expect.stringContaining('Alpha'),
        ])
    })
})

describe('Composer attachments', () => {
    it.each(['files', 'items'] as const)('pastes clipboard images via %s and sends them once', async (source) => {
        const onSend = vi.fn()
        render(<Composer onSend={onSend} />)
        const file = jpegFile('clipboard.jpg')
        await act(async () => {
            fireEvent.paste(screen.getByTestId('composer-input'), {
                clipboardData: {
                    files: source === 'files' ? [file] : [],
                    items: [{ kind: 'file', type: file.type, getAsFile: () => file }],
                    getData: () => 'unwanted clipboard text',
                },
            })
        })
        await waitFor(() => {
            expect(screen.getByRole('img', { name: 'clipboard.jpg' })).toBeInTheDocument()
        })
        expect(screen.getByTestId('composer-input')).not.toHaveTextContent('unwanted clipboard text')
        await userEvent.setup().click(screen.getByRole('button', { name: 'Send' }))
        expect(onSend.mock.calls[0]![0].images).toHaveLength(1)
        expect(onSend.mock.calls[0]![0].images[0].mimeType).toBe('image/jpeg')
    })

    it('does not add pasted images while running', async () => {
        render(<Composer onSend={() => undefined} isStreaming />)
        await act(async () => {
            fireEvent.paste(screen.getByTestId('composer-input'), {
                clipboardData: { files: [jpegFile('locked.jpg')], getData: () => '' },
            })
        })
        expect(screen.queryByRole('img', { name: 'locked.jpg' })).not.toBeInTheDocument()
    })

    it('allows selecting files on the file input', async () => {
        render(<Composer onSend={() => undefined} />)
        const file = jpegFile()
        const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement

        await act(async () => {
            fireEvent.change(fileInput, { target: { files: [file] } })
        })

        await waitFor(() => {
            expect(screen.getByRole('img', { name: 'photo.jpg' })).toBeInTheDocument()
        })
    })

    it('processes real file bytes into ComposerImage base64 without data-url prefix', async () => {
        let sentPayload: ComposerSendPayload | null = null
        render(
            <Composer
                onSend={(payload) => {
                    sentPayload = payload
                }}
            />,
        )

        const file = jpegFile('real.jpg')
        const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement

        await act(async () => {
            fireEvent.change(fileInput, { target: { files: [file] } })
        })

        await waitFor(() => {
            expect(screen.getByRole('img', { name: 'real.jpg' })).toBeInTheDocument()
        })

        await userEvent.setup().click(screen.getByRole('button', { name: 'Send' }))

        expect(sentPayload).not.toBeNull()
        expect(sentPayload!.images).toHaveLength(1)
        expect(sentPayload!.images[0]!.data).not.toMatch(/^data:/)
        expect(sentPayload!.images[0]!.mimeType).toBe('image/jpeg')
    })

    it('renders attached images as square thumbnails with object-cover and remove button', async () => {
        const user = userEvent.setup()
        render(<Composer onSend={() => undefined} />)

        const file = jpegFile('test.jpg')
        const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement

        await act(async () => {
            fireEvent.change(fileInput, { target: { files: [file] } })
        })

        await waitFor(() => {
            expect(screen.getByRole('img', { name: 'test.jpg' })).toBeInTheDocument()
        })

        const img = screen.getByRole('img', { name: 'test.jpg' })
        expect(img).toHaveClass('object-cover')

        const removeBtn = screen.getByRole('button', { name: /Remove test.jpg/i })
        await user.click(removeBtn)

        expect(screen.queryByRole('img', { name: 'test.jpg' })).not.toBeInTheDocument()
    })

    it('rejects pseudo-extension non-image bytes via magic detection', async () => {
        render(<Composer onSend={() => undefined} />)

        const fakeImage = new File([new TextEncoder().encode('not an image')], 'fake.jpg', {
            type: 'image/jpeg',
        })
        const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement

        await act(async () => {
            fireEvent.change(fileInput, { target: { files: [fakeImage] } })
        })

        await waitFor(() => {
            expect(mockServices.ui.pushToast).toHaveBeenCalledWith(
                expect.stringContaining('fake.jpg'),
                'error',
            )
        })
        expect(screen.queryByRole('img')).not.toBeInTheDocument()
    })

    it('blocks submit when model does not support images and marks attachments', async () => {
        settingsState = { ...settingsState, modelId: textModel.id }
        notifySettings()

        render(<Composer onSend={() => undefined} supportsImages={false} />)

        const file = jpegFile('blocked.jpg')
        const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement

        await act(async () => {
            fireEvent.change(fileInput, { target: { files: [file] } })
        })

        await waitFor(() => {
            expect(screen.getByTestId('image-unsupported')).toBeInTheDocument()
            expect(screen.getByTestId('image-unsupported-message')).toBeInTheDocument()
        })

        expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
    })

    it('allows send after switching back to a vision model', async () => {
        const { rerender } = render(
            <Composer onSend={() => undefined} supportsImages={false} />,
        )

        const file = jpegFile('vision-switch.jpg')
        const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement

        await act(async () => {
            fireEvent.change(fileInput, { target: { files: [file] } })
        })

        await waitFor(() => {
            expect(screen.getByTestId('image-unsupported')).toBeInTheDocument()
        })

        rerender(<Composer onSend={() => undefined} supportsImages={true} />)

        await waitFor(() => {
            expect(screen.queryByTestId('image-unsupported')).not.toBeInTheDocument()
            expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled()
        })
    })

    it('keeps draft and images when onSend rejects', async () => {
        const user = userEvent.setup()
        const onSend = vi.fn(async () => {
            throw new Error('Network error')
        })

        render(<Composer onSend={onSend} />)

        const file = jpegFile('keep.jpg')
        const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement

        await act(async () => {
            fireEvent.change(fileInput, { target: { files: [file] } })
        })

        await waitFor(() => {
            expect(screen.getByRole('img', { name: 'keep.jpg' })).toBeInTheDocument()
        })

        const textarea = screen.getByTestId('composer-input')
        await user.type(textarea, 'Keep me on error')
        await user.click(screen.getByRole('button', { name: 'Send' }))

        expect(screen.getByRole('img', { name: 'keep.jpg' })).toBeInTheDocument()
        expectComposerValue('Keep me on error')
    })

    it('keeps the draft without displaying an expected abort error', async () => {
        const user = userEvent.setup()
        const abortErr = new Error('aborted')
        abortErr.name = 'AbortError'
        const onSend = vi.fn(async () => {
            throw abortErr
        })

        render(<Composer onSend={onSend} />)

        const textarea = screen.getByTestId('composer-input')
        await user.type(textarea, 'Aborted prompt')
        await user.click(screen.getByRole('button', { name: 'Send' }))

        expectComposerValue('Aborted prompt')
        expect(mockServices.ui.pushToast).not.toHaveBeenCalled()
    })

    it('does not setState after unmount for late image processing', async () => {
        let finishProcessing!: (val: any) => void
        const processor: ImageProcessor = {
            process: vi.fn(
                () =>
                    new Promise((resolve) => {
                        finishProcessing = resolve
                    }),
            ),
        }

        const { unmount } = render(
            <Composer onSend={() => undefined} imageProcessor={processor} />,
        )

        const file = jpegFile('late.jpg')
        const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement

        await act(async () => {
            fireEvent.change(fileInput, { target: { files: [file] } })
        })

        unmount()

        await act(async () => {
            finishProcessing({
                ok: true,
                data: 'base64',
                mimeType: 'image/jpeg',
                width: 100,
                height: 100,
            })
        })
    })

    it('renders non-image files as attachment cards with file type description', async () => {
        render(<Composer onSend={() => undefined} />)

        const file = fakeTextFile('notes.txt')
        const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement

        await act(async () => {
            fireEvent.change(fileInput, { target: { files: [file] } })
        })

        await waitFor(() => {
            expect(screen.getByText('notes.txt')).toBeInTheDocument()
            expect(screen.getByText('TXT')).toBeInTheDocument()
        })
    })

    it('renders native files and folders via SelectFilesAndFolders', async () => {
        const user = userEvent.setup()
        setDefaultHostServices({
            ...mockServices,
            fileSystem: {
                selectFilesAndFolders: vi.fn(async () => [
                    { name: 'src-folder', path: '/workspace/src', isDirectory: true },
                ]),
                readFile: vi.fn(async () => ({ dataBase64: '' })),
            },
        })

        render(<Composer onSend={() => undefined} />)

        await user.click(screen.getByRole('button', { name: /Attach/i }))
        const filesItem = screen.getByText('Files & folders').closest('button')!
        await user.click(filesItem)

        await waitFor(() => {
            expect(screen.getByText('src-folder')).toBeInTheDocument()
            expect(screen.getByText('Folder')).toBeInTheDocument()
        })
    })

    it('does not trigger web file input click when user cancels native selectFilesAndFolders dialog', async () => {
        const user = userEvent.setup()
        const selectFilesAndFoldersMock = vi.fn(async () => [])
        setDefaultHostServices({
            ...mockServices,
            fileSystem: {
                selectFilesAndFolders: selectFilesAndFoldersMock,
                readFile: vi.fn(async () => ({ dataBase64: '' })),
            },
        })

        const clickSpy = vi.spyOn(HTMLInputElement.prototype, 'click')

        render(<Composer onSend={() => undefined} />)

        await user.click(screen.getByRole('button', { name: /Attach/i }))
        const filesItem = screen.getByText('Files & folders').closest('button')!
        await user.click(filesItem)

        await waitFor(() => {
            expect(selectFilesAndFoldersMock).toHaveBeenCalled()
        })

        expect(clickSpy).not.toHaveBeenCalled()
        clickSpy.mockRestore()
    })
})

describe('Composer run control lock', () => {
    it('keeps textarea and attach button unlocked while active, and keeps Stop enabled', () => {
        render(
            <Composer
                onSend={() => undefined}
                runStatus="streaming"
                isStreaming={true}
            />,
        )

        const textarea = screen.getByTestId('composer-input')
        expect(textarea).not.toHaveAttribute('aria-disabled', 'true')
        expect(textarea).toHaveAttribute('contenteditable', 'true')

        expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument()
        expect(screen.getByRole('button', { name: /Attach/i })).not.toBeDisabled()
    })

    it('allows clicking attach button and opening attach menu while session is active', async () => {
        const user = userEvent.setup()
        render(
            <Composer
                onSend={() => undefined}
                runStatus="streaming"
                isStreaming={true}
            />,
        )

        const attachBtn = screen.getByRole('button', { name: /Attach/i })
        expect(attachBtn).toBeEnabled()
        await user.click(attachBtn)
        expect(screen.getByRole('listbox', { name: 'Add' })).toBeInTheDocument()
        expect(screen.getByText('Files & folders')).toBeInTheDocument()
    })

    it('also renders Stop button and keeps textarea unlocked when isStreaming is true', () => {
        render(
            <Composer
                onSend={() => undefined}
                isStreaming={true}
            />,
        )

        expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument()
        expect(screen.getByTestId('composer-input')).toHaveAttribute('contenteditable', 'true')
    })

    it('renders Stop button when remote session is active in sessionRunStore', () => {
        sessionsState = [
            { id: 'remote-session', title: 'Remote', pinned: false, createdAt: 1, updatedAt: 1 },
        ]
        activeRunsState['remote-session'] = {
            sessionId: 'remote-session',
            runId: 'r1',
            status: 'running',
            clientId: 'c1',
            updatedAt: Date.now(),
        }
        notifyRuns()

        render(
            <Composer
                sessionId="remote-session"
                onSend={() => undefined}
            />,
        )

        expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument()
    })

    it('sends new prompt when user presses Enter during run without duplicating onStop', async () => {
        const user = userEvent.setup()
        const onSend = vi.fn()
        const onStop = vi.fn()

        render(
            <Composer
                onSend={onSend}
                onStop={onStop}
                isStreaming={true}
            />,
        )

        const textarea = screen.getByTestId('composer-input')
        await user.type(textarea, 'Interrupt prompt')
        fireEvent.keyDown(textarea, { key: 'Enter' })

        expect(onSend).toHaveBeenCalledWith(
            expect.objectContaining({ text: 'Interrupt prompt' }),
        )
        expect(onStop).not.toHaveBeenCalled()
    })

    it('disables send when both text and images are empty', () => {
        render(<Composer onSend={() => undefined} />)
        expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
    })

    it('renders Resume button instead of disabled Send button when canResume is true and input is empty', async () => {
        const user = userEvent.setup()
        const onResume = vi.fn()
        const onSend = vi.fn()

        render(
            <Composer
                onSend={onSend}
                onResume={onResume}
                canResume={true}
            />,
        )

        // Resume button is shown
        const resumeBtn = screen.getByRole('button', { name: 'Resume' })
        expect(resumeBtn).toBeInTheDocument()
        expect(resumeBtn).not.toBeDisabled()
        expect(screen.queryByRole('button', { name: 'Send' })).not.toBeInTheDocument()

        // Clicking resume button calls onResume
        await user.click(resumeBtn)
        expect(onResume).toHaveBeenCalledTimes(1)

        // Typing text switches resume button to send button
        const textarea = screen.getByTestId('composer-input')
        await user.type(textarea, 'New question')
        expect(screen.queryByRole('button', { name: 'Resume' })).not.toBeInTheDocument()
        const sendBtn = screen.getByRole('button', { name: 'Send' })
        expect(sendBtn).toBeInTheDocument()
        expect(sendBtn).not.toBeDisabled()

        // Clearing text switches back to resume button
        await user.clear(textarea)
        expect(screen.getByRole('button', { name: 'Resume' })).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: 'Send' })).not.toBeInTheDocument()
    })

    it('renders disabled Send button instead of Resume button when isTurnComplete is true', async () => {
        const onResume = vi.fn()
        const onSend = vi.fn()

        render(
            <Composer
                onSend={onSend}
                onResume={onResume}
                canResume={true}
                isTurnComplete={true}
            />,
        )

        // Default disabled send button is shown instead of resume button
        expect(screen.queryByRole('button', { name: 'Resume' })).not.toBeInTheDocument()
        const sendBtn = screen.getByRole('button', { name: 'Send' })
        expect(sendBtn).toBeInTheDocument()
        expect(sendBtn).toBeDisabled()
    })

    it('renders disabled Send button instead of Resume button when runStatus is done', async () => {
        const onResume = vi.fn()
        const onSend = vi.fn()

        render(
            <Composer
                onSend={onSend}
                onResume={onResume}
                canResume={true}
                runStatus="done"
            />,
        )

        // Default disabled send button is shown instead of resume button
        expect(screen.queryByRole('button', { name: 'Resume' })).not.toBeInTheDocument()
        const sendBtn = screen.getByRole('button', { name: 'Send' })
        expect(sendBtn).toBeInTheDocument()
        expect(sendBtn).toBeDisabled()
    })

    it('allows opening model menu to change reasoning while run is active, but disallows switching model or quick model picker', async () => {
        const user = userEvent.setup()
        render(
            <Composer
                onSend={() => undefined}
                isStreaming={true}
            />,
        )

        const trigger = screen.getByRole('button', { name: 'Model' })
        expect(trigger).not.toBeDisabled()

        await user.click(trigger)
        expect(screen.getByRole('menu', { name: 'Model menu' })).toBeInTheDocument()
        expect(screen.queryByText('Advanced')).not.toBeInTheDocument()

        act(() => {
            rendererPluginRuntime.eventBus.emit('composer:toggle-model-selector')
        })
        expect(screen.queryByRole('listbox', { name: 'Quick model selector' })).not.toBeInTheDocument()
    })
})

describe('Composer image size, dimensions, and ordered batches', () => {
    it('probes dimensions from processed result.data base64, not original bytes', async () => {
        const probe = vi.fn(async () => ({ width: 640, height: 480 }))
        const processor: ImageProcessor = {
            process: vi.fn(async () => ({
                ok: true,
                data: 'QUJD',
                mimeType: 'image/jpeg',
            })),
        }

        render(
            <Composer
                onSend={() => undefined}
                imageProcessor={processor}
                dimensionProbe={probe}
            />,
        )

        const file = jpegFile('probe.jpg')
        const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement

        await act(async () => {
            fireEvent.change(fileInput, { target: { files: [file] } })
        })

        await waitFor(() => {
            expect(probe).toHaveBeenCalled()
        })
    })

    it('rejects invalid processed base64 when dimensions are missing', async () => {
        const processor: ImageProcessor = {
            process: vi.fn(async () => ({
                ok: true,
                data: 'not_valid_base64!!!',
                mimeType: 'image/jpeg',
            })),
        }

        render(
            <Composer
                onSend={() => undefined}
                imageProcessor={processor}
                dimensionProbe={async () => null}
            />,
        )

        const file = jpegFile('invalid-base64.jpg')
        const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement

        await act(async () => {
            fireEvent.change(fileInput, { target: { files: [file] } })
        })

        await waitFor(() => {
            expect(mockServices.ui.pushToast).toHaveBeenCalled()
        })
    })

    it('rejects oversized files before arrayBuffer and never stores zero dimensions', async () => {
        render(<Composer onSend={() => undefined} />)

        const hugeFile = new File([''], 'huge.jpg', { type: 'image/jpeg' })
        Object.defineProperty(hugeFile, 'size', { value: MAX_IMAGE_INPUT_BYTES + 1 })
        const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement

        await act(async () => {
            fireEvent.change(fileInput, { target: { files: [hugeFile] } })
        })

        await waitFor(() => {
            expect(mockServices.ui.pushToast).toHaveBeenCalledWith(
                expect.stringContaining('huge.jpg'),
                'error',
            )
        })
    })

    it('serializes concurrent file-change batches in selection order', async () => {
        const file1 = jpegFile('first.jpg')
        const file2 = jpegFile('second.jpg')

        const { container } = render(<Composer onSend={() => undefined} />)
        const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement

        await act(async () => {
            fireEvent.change(fileInput, { target: { files: [file1] } })
        })
        await act(async () => {
            fireEvent.change(fileInput, { target: { files: [file2] } })
        })

        await waitFor(() => {
            const images = screen.getAllByRole('img')
            expect(images.map((img) => img.getAttribute('alt'))).toEqual([
                'first.jpg',
                'second.jpg',
            ])
        })
    })
})

describe('Composer extension slots', () => {
    it('renders contributions in composer.bar.left, composer.bar.right, composer.toolbar.left, composer.toolbar.actions, and composer.menus', () => {
        render(<Composer onSend={() => undefined} />)
        expect(screen.getByTestId('context-usage-ring')).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Model' })).toBeInTheDocument()
    })
})

describe('QuickModelPicker in Composer', () => {
    it('ignores and restores the existing draft while filtering and selecting a model', async () => {
        const user = userEvent.setup()
        render(<Composer onSend={() => undefined} />)

        const textarea = screen.getByTestId('composer-input')
        await user.type(textarea, 'Unsent message draft')
        expectComposerValue('Unsent message draft')

        act(() => {
            rendererPluginRuntime.eventBus.emit('composer:toggle-model-selector')
        })

        expectComposerValue('')
        expect(textarea).toHaveAttribute('data-placeholder', 'Type or select a model')

        await user.type(textarea, 'vision')
        await user.keyboard('{Enter}')

        expect(mockServices.settings.setModelId).toHaveBeenCalledWith('vision-model')
        expectComposerValue('Unsent message draft')
        expect(textarea).toHaveAttribute('data-placeholder', 'Type anything')
    })

    it('restores the existing draft when closing quick model picker with Escape', async () => {
        const user = userEvent.setup()
        render(<Composer onSend={() => undefined} />)

        const textarea = screen.getByTestId('composer-input')
        await user.type(textarea, 'Draft before picker')
        expectComposerValue('Draft before picker')

        act(() => {
            rendererPluginRuntime.eventBus.emit('composer:toggle-model-selector')
        })

        expectComposerValue('')
        await user.keyboard('{Escape}')
        expectComposerValue('Draft before picker')
    })

    it('updates session runtime settings when selecting model in an active session', async () => {
        const user = userEvent.setup()
        sessionsState = [
            { id: 'session-live', title: 'Live', pinned: false, createdAt: 1, updatedAt: 1 },
        ]

        render(
            <Composer sessionId="session-live" onSend={() => undefined} />,
        )

        act(() => {
            rendererPluginRuntime.eventBus.emit('composer:toggle-model-selector')
        })

        const textarea = screen.getByTestId('composer-input')
        await user.type(textarea, 'vision')
        await user.keyboard('{Enter}')

        expect(mockServices.sessions.setSessionRuntimeSettings).toHaveBeenCalledWith(
            'session-live',
            expect.objectContaining({ modelId: 'vision-model' }),
        )
    })
})

describe('Focus, context bar, and attach menu integration', () => {
    it('focuses composer input when composer:focus event is emitted on defaultEventBus', () => {
        render(<Composer onSend={() => undefined} />)
        const textarea = screen.getByTestId('composer-input')
        const focusSpy = vi.spyOn(textarea, 'focus')

        act(() => {
            rendererPluginRuntime.eventBus.emit('composer:focus')
        })

        expect(focusSpy).toHaveBeenCalled()
    })

    it('focuses composer input when switching from existing session to new session (null)', async () => {
        const { rerender } = render(<Composer sessionId="session-1" onSend={() => undefined} />)
        const textarea = screen.getByTestId('composer-input')
        const focusSpy = vi.spyOn(textarea, 'focus')

        act(() => {
            rerender(<Composer sessionId={null} onSend={() => undefined} />)
        })

        expect(focusSpy).toHaveBeenCalled()
    })

    it('shows environment picker when work location is switched to new worktree', async () => {
        const user = userEvent.setup()
        render(<Composer onSend={() => undefined} />)

        expect(screen.queryByRole('button', { name: /Environment/i })).not.toBeInTheDocument()

        await user.click(screen.getByRole('button', { name: 'Work location' }))
        await user.click(screen.getByRole('menuitem', { name: /New local worktree/i }))

        expect(screen.getByRole('button', { name: /Environment/i })).toBeInTheDocument()
    })

    it('inherits worktree and environment settings when pending context has them', () => {
        pendingSessionContextState = {
            projectId: 'project-1',
            branch: 'dev',
            workLocation: 'worktree',
            environmentId: 'env-node',
        }
        notifyUi()

        render(<Composer onSend={() => undefined} />)

        expect(screen.getByRole('button', { name: 'Work location' })).toHaveTextContent('New local worktree')
        expect(screen.getByRole('button', { name: /Environment/i })).toBeInTheDocument()
    })

    it('disables composer and stays at failed position when worktree setup fails', () => {
        sessionsState = [
            {
                id: 'sess-failed',
                title: 'Failed',
                pinned: false,
                workLocation: 'worktree',
                createdAt: 1,
                updatedAt: 1,
            },
        ]
        worktreeSetupsState['sess-failed'] = { status: 'error' }

        render(<Composer sessionId="sess-failed" onSend={() => undefined} />)

        expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
        expect(screen.getByTestId('composer-input')).toHaveAttribute(
            'data-placeholder',
            'Worktree setup failed. Please retry or continue anyway.',
        )
    })

    it('opens attach menu on clicking attach button and hides context bar, closes on escape', async () => {
        const user = userEvent.setup()
        render(<Composer onSend={() => undefined} />)

        await user.click(screen.getByRole('button', { name: /Attach/i }))
        expect(screen.getByRole('listbox', { name: 'Add' })).toBeInTheDocument()

        await user.keyboard('{Escape}')
        expect(screen.queryByRole('listbox', { name: 'Add' })).not.toBeInTheDocument()
    })

    it('triggers file input click when selecting files and folders in attach menu', async () => {
        const user = userEvent.setup()
        render(<Composer onSend={() => undefined} />)

        const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement
        const clickSpy = vi.spyOn(fileInput, 'click')

        await user.click(screen.getByRole('button', { name: /Attach/i }))
        const filesItem = screen.getByText('Files & folders').closest('button')!
        fireEvent.mouseDown(filesItem)

        expect(clickSpy).toHaveBeenCalled()
    })

    it('navigates and selects in attach menu with keyboard', async () => {
        const user = userEvent.setup()
        render(<Composer onSend={() => undefined} />)

        const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement
        const clickSpy = vi.spyOn(fileInput, 'click')

        await user.click(screen.getByRole('button', { name: /Attach/i }))
        const textarea = screen.getByTestId('composer-input')

        fireEvent.keyDown(textarea, { key: 'ArrowDown' })
        fireEvent.keyDown(textarea, { key: 'ArrowUp' })
        fireEvent.keyDown(textarea, { key: 'Enter' })

        expect(clickSpy).toHaveBeenCalled()
    })

    it('hides context bar when skill menu is opened', async () => {
        const user = userEvent.setup()
        render(
            <Composer
                onSend={() => undefined}
                skills={[{ name: 'review', description: 'desc', filePath: '/s.md' }] as any}
            />,
        )

        const textarea = screen.getByTestId('composer-input')
        await user.type(textarea, '$')

        expect(screen.getByRole('listbox', { name: 'Skills' })).toBeInTheDocument()
    })

    it('shows context bar and input when on new session page (sessionId is null) even if store has old currentSessionId', () => {
        currentSessionIdState = 'old-session'
        sessionsState = [
            { id: 'old-session', title: 'Old', pinned: false, createdAt: 1, updatedAt: 1 },
        ]

        render(<Composer sessionId={null} onSend={() => undefined} />)

        expect(screen.getByRole('button', { name: 'Work location' })).toBeInTheDocument()
        expect(screen.getByTestId('composer-input')).toBeInTheDocument()
    })

    it('hides context bar when session has started and worktree/environment are fine', () => {
        sessionsState = [
            {
                id: 'started-session',
                title: 'Started',
                pinned: false,
                workLocation: 'local',
                createdAt: 1,
                updatedAt: 1,
            },
        ]

        const { container } = render(
            <Composer sessionId="started-session" onSend={() => undefined} />,
        )

        const bar = container.querySelector('.bg-\\[var\\(--bg-composer-bar\\)\\]')
        expect(bar).toHaveClass('hidden')
    })

    it('shows context bar when session is active but worktree setup has an error', () => {
        sessionsState = [
            {
                id: 'error-session',
                title: 'Error Session',
                pinned: false,
                workLocation: 'worktree',
                createdAt: 1,
                updatedAt: 1,
            },
        ]
        worktreeSetupsState['error-session'] = { status: 'error' }

        const { container } = render(
            <Composer sessionId="error-session" onSend={() => undefined} />,
        )

        const bar = container.querySelector('.bg-\\[var\\(--bg-composer-bar\\)\\]')
        expect(bar).not.toHaveClass('hidden')
    })
})

describe('Composer sendShortcut setting', () => {
    it('requires Cmd+Enter or Ctrl+Enter to send when sendShortcut is cmdEnter', async () => {
        const user = userEvent.setup()
        const onSend = vi.fn()
        settingsState = {
            ...settingsState,
            editor: { showContextUsage: true, sendShortcut: 'cmdEnter', followUpMode: 'steer' },
        }
        notifySettings()

        render(<Composer onSend={onSend} />)
        const textarea = screen.getByTestId('composer-input')
        await user.type(textarea, 'Draft message')

        // Normal Enter should not trigger onSend
        fireEvent.keyDown(textarea, { key: 'Enter' })
        expect(onSend).not.toHaveBeenCalled()

        // Cmd+Enter triggers onSend
        fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true })
        expect(onSend).toHaveBeenCalledTimes(1)
        expect(onSend).toHaveBeenCalledWith(
            expect.objectContaining({ text: 'Draft message' }),
        )
    })

    it('sends with Ctrl+Enter when sendShortcut is cmdEnter', async () => {
        const user = userEvent.setup()
        const onSend = vi.fn()
        settingsState = {
            ...settingsState,
            editor: { showContextUsage: true, sendShortcut: 'cmdEnter', followUpMode: 'steer' },
        }
        notifySettings()

        render(<Composer onSend={onSend} />)
        const textarea = screen.getByTestId('composer-input')
        await user.type(textarea, 'Draft message 2')

        // Ctrl+Enter triggers onSend
        fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true })
        expect(onSend).toHaveBeenCalledTimes(1)
        expect(onSend).toHaveBeenCalledWith(
            expect.objectContaining({ text: 'Draft message 2' }),
        )
    })

    it('sends with plain Enter and does not send with Shift+Enter when sendShortcut is enter', async () => {
        const user = userEvent.setup()
        const onSend = vi.fn()
        settingsState = {
            ...settingsState,
            editor: { showContextUsage: true, sendShortcut: 'enter', followUpMode: 'steer' },
        }
        notifySettings()

        render(<Composer onSend={onSend} />)
        const textarea = screen.getByTestId('composer-input')
        await user.type(textarea, 'Draft for enter')

        // Shift+Enter should not trigger onSend
        fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true })
        expect(onSend).not.toHaveBeenCalled()

        // Plain Enter triggers onSend
        fireEvent.keyDown(textarea, { key: 'Enter' })
        expect(onSend).toHaveBeenCalledTimes(1)
        expect(onSend).toHaveBeenCalledWith(
            expect.objectContaining({ text: 'Draft for enter' }),
        )
    })
})
