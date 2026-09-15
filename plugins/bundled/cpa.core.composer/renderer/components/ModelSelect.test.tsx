import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '@/i18n'
import { setDefaultHostServices } from '@cpa/plugin-ui'
import type { AppSettings, ModelCatalogEntry, SessionItem } from '@cpa/plugin-api'
import { ModelSelect } from './ModelSelect.js'

const testModels: readonly ModelCatalogEntry[] = [
    {
        id: 'model-primary',
        label: 'Primary Model',
        supportsFast: false,
        reasoningLevels: [
            { id: 'low', requestValue: 'low', labelKey: 'composer.reasoning.low' },
            { id: 'medium', requestValue: 'medium', labelKey: 'composer.reasoning.medium' },
            { id: 'high', requestValue: 'high', labelKey: 'composer.reasoning.high' },
            { id: 'xhigh', requestValue: 'xhigh', labelKey: 'composer.reasoning.xhigh' },
            { id: 'max', requestValue: 'max', labelKey: 'composer.reasoning.max' },
        ],
        input: ['text'],
        contextWindow: 128_000,
        maxTokens: 16_384,
    },
    {
        id: 'model-fast',
        label: 'Fast Model',
        supportsFast: true,
        reasoningLevels: [
            { id: 'low', requestValue: 'low', labelKey: 'composer.reasoning.low' },
            { id: 'high', requestValue: 'high', labelKey: 'composer.reasoning.high' },
        ],
        input: ['text'],
        contextWindow: 128_000,
        maxTokens: 16_384,
    },
    {
        id: 'model-even-reasoning',
        label: 'Even Reasoning Model',
        supportsFast: false,
        reasoningLevels: [
            { id: 'low', requestValue: 'low', labelKey: 'composer.reasoning.low' },
            { id: 'medium', requestValue: 'medium', labelKey: 'composer.reasoning.medium' },
            { id: 'high', requestValue: 'high', labelKey: 'composer.reasoning.high' },
            { id: 'max', requestValue: 'max', labelKey: 'composer.reasoning.max' },
        ],
        input: ['text'],
        contextWindow: 128_000,
        maxTokens: 16_384,
    },
]

let settingsState: AppSettings
let modelsState: readonly ModelCatalogEntry[]
let sessionsState: SessionItem[]
let activeRunsState: Record<string, any>
let mockServices: any
let settingsListeners: Set<() => void>
let sessionsListeners: Set<() => void>
let runsListeners: Set<() => void>

function notifySettings() {
    for (const l of settingsListeners) l()
}
function notifySessions() {
    for (const l of sessionsListeners) l()
}
function notifyRuns() {
    for (const l of runsListeners) l()
}

function resetState(): void {
    settingsListeners = new Set()
    sessionsListeners = new Set()
    runsListeners = new Set()

    settingsState = {
        theme: 'dark',
        locale: 'zh-CN',
        modelId: '',
        reasoningLevel: 'off',
        speed: 'standard',
        requestApproval: false,
        compactionThresholdPercent: 80,
        fastContextCompaction: true,
        showInMenuBar: true,
        showBottomPanel: true,
        terminalPosition: 'bottom',
        cliProxyApi: { baseUrl: '', apiKey: '' },
    }
    modelsState = []
    sessionsState = []
    activeRunsState = {}

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
            getActiveRun: (sessionId: string) => activeRunsState[sessionId],
            subscribeRuns: (listener: () => void) => {
                runsListeners.add(listener)
                return () => runsListeners.delete(listener)
            },
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
        },
        ui: {
            pushToast: vi.fn(),
        },
    }
    setDefaultHostServices(mockServices)
}

function renderModelSelect(className?: string): void {
    render(<ModelSelect className={className} />)
}

describe('ModelSelect', () => {
    beforeEach(async () => {
        await i18n.changeLanguage('en')
        resetState()
    })

    it('renders no mock data and disables trigger when model catalog is empty', () => {
        renderModelSelect()

        const trigger = screen.getByRole('button', { name: 'Model' })
        expect(trigger).toBeDisabled()
        expect(trigger).toHaveTextContent('No models available')
        expect(screen.queryByText(/GPT 5.6/i)).not.toBeInTheDocument()
        expect(screen.queryByText(/mock/i)).not.toBeInTheDocument()
    })

    it('defaults to first model in catalog and middle reasoning level (odd: 5 levels -> high)', () => {
        modelsState = testModels
        renderModelSelect()

        expect(settingsState.modelId).toBe('model-primary')
        expect(settingsState.reasoningLevel).toBe('high')

        const trigger = screen.getByRole('button', { name: 'Model' })
        expect(trigger).toHaveTextContent('Primary Model')
        expect(trigger).toHaveTextContent('High')
    })

    it('defaults to upper-middle reasoning level when reasoning options count is even (4 levels -> high)', () => {
        modelsState = [testModels[2]!]
        renderModelSelect()

        expect(settingsState.modelId).toBe('model-even-reasoning')
        expect(settingsState.reasoningLevel).toBe('high')

        const trigger = screen.getByRole('button', { name: 'Model' })
        expect(trigger).toHaveTextContent('Even Reasoning Model')
        expect(trigger).toHaveTextContent('High')
    })

    it('defaults to upper-middle reasoning level for 2 levels (low, high -> high)', () => {
        modelsState = [testModels[1]!]
        renderModelSelect()

        expect(settingsState.modelId).toBe('model-fast')
        expect(settingsState.reasoningLevel).toBe('high')
    })

    it('shows all dynamic models in advanced menu', async () => {
        const user = userEvent.setup()
        modelsState = testModels
        renderModelSelect()

        await user.click(screen.getByRole('button', { name: 'Model' }))
        await user.click(screen.getByRole('menuitem', { name: 'Advanced' }))
        await user.click(screen.getByRole('menuitem', { name: /Model/i }))

        expect(screen.getByRole('menuitemradio', { name: /Primary Model/ })).toBeVisible()
        expect(screen.getByRole('menuitemradio', { name: /Fast Model/ })).toBeVisible()
        expect(screen.getByRole('menuitemradio', { name: /Even Reasoning Model/ })).toBeVisible()
    })

    it('hides the speed submenu for standard-only models', async () => {
        const user = userEvent.setup()
        modelsState = testModels
        renderModelSelect()

        await user.click(screen.getByRole('button', { name: 'Model' }))
        await user.click(screen.getByRole('menuitem', { name: 'Advanced' }))
        expect(screen.queryByRole('menuitem', { name: /Speed/i })).not.toBeInTheDocument()
    })

    it('shows speed options when switching to a fast-supporting model', async () => {
        const user = userEvent.setup()
        modelsState = testModels
        renderModelSelect()

        await user.click(screen.getByRole('button', { name: 'Model' }))
        await user.click(screen.getByRole('menuitem', { name: 'Advanced' }))
        await user.click(screen.getByRole('menuitem', { name: /Model/i }))
        await user.click(screen.getByRole('menuitemradio', { name: /Fast Model/ }))

        expect(settingsState.modelId).toBe('model-fast')
        expect(screen.getByRole('menuitem', { name: /Speed/i })).toBeVisible()
    })

    it('normalizes reasoning level to default middle when switching to a model that does not support current level', async () => {
        const user = userEvent.setup()
        modelsState = testModels
        settingsState = { ...settingsState, modelId: 'model-primary', reasoningLevel: 'xhigh' }
        renderModelSelect()

        await user.click(screen.getByRole('button', { name: 'Model' }))
        await user.click(screen.getByRole('menuitem', { name: 'Advanced' }))
        await user.click(screen.getByRole('menuitem', { name: /Model/i }))
        // Switch to Fast Model which only has [low, high]
        await user.click(screen.getByRole('menuitemradio', { name: /Fast Model/ }))

        // 'xhigh' not supported on Fast Model -> defaults to upper-middle (high)
        expect(settingsState.reasoningLevel).toBe('high')
    })

    it('shows an unavailable state for models without reasoning capability', async () => {
        const user = userEvent.setup()
        const modelWithoutReasoning: readonly ModelCatalogEntry[] = [
            {
                id: 'no-reason-model',
                label: 'No Reason Model',
                supportsFast: false,
                reasoningLevels: [],
                input: ['text'],
                contextWindow: 128_000,
                maxTokens: 16_384,
            },
        ]
        modelsState = modelWithoutReasoning
        renderModelSelect()

        expect(settingsState.reasoningLevel).toBe('off')
        await user.click(screen.getByRole('button', { name: 'Model' }))
        expect(screen.queryByRole('slider', { name: 'Reasoning strength' })).not.toBeInTheDocument()
        await user.click(screen.getByRole('menuitem', { name: 'Advanced' }))
        await user.hover(screen.getByRole('menuitem', { name: /Reasoning strength/i }))
        const unavailableMessages = screen.getAllByText('Not supported')
        expect(unavailableMessages[unavailableMessages.length - 1]).toBeVisible()
    })

    it('opens the quick menu with a reasoning slider and advanced action', async () => {
        const user = userEvent.setup()
        modelsState = testModels
        renderModelSelect()

        await user.click(screen.getByRole('button', { name: 'Model' }))

        expect(screen.getByRole('slider', { name: 'Reasoning strength' })).toBeVisible()
        expect(screen.getByRole('menuitem', { name: 'Advanced' })).toBeVisible()
    })

    it('toggles the lightning speed button between gray and blue for fast model', async () => {
        const user = userEvent.setup()
        modelsState = [testModels[1]!]
        renderModelSelect()

        await user.click(screen.getByRole('button', { name: 'Model' }))

        const speedToggle = screen.getByRole('menuitemcheckbox', { name: 'Fast' })
        const zapIcon = speedToggle.querySelector('.lucide-zap')

        expect(speedToggle).toHaveAttribute('aria-checked', 'false')
        expect(zapIcon).toHaveClass('text-[var(--text-muted)]')
        expect(settingsState.speed).toBe('standard')

        await user.click(speedToggle)
        expect(settingsState.speed).toBe('fast')
        expect(speedToggle).toHaveAttribute('aria-checked', 'true')
        expect(zapIcon).toHaveClass('text-[var(--accent-blue)]')

        await user.click(speedToggle)
        expect(settingsState.speed).toBe('standard')
        expect(speedToggle).toHaveAttribute('aria-checked', 'false')
        expect(zapIcon).toHaveClass('text-[var(--text-muted)]')
    })

    it('updates reasoning from the slider and writes selected option values back', async () => {
        const user = userEvent.setup()
        modelsState = testModels
        renderModelSelect()

        await user.click(screen.getByRole('button', { name: 'Model' }))
        const slider = screen.getByRole('slider', { name: 'Reasoning strength' })

        fireEvent.change(slider, { target: { value: '0' } })
        expect(settingsState.reasoningLevel).toBe('low')
        expect(slider).toHaveValue('0')

        await user.click(screen.getByRole('menuitem', { name: 'Advanced' }))
        await user.hover(screen.getByRole('menuitem', { name: /Reasoning strength/i }))
        await user.click(screen.getByRole('menuitemradio', { name: 'Medium' }))
        expect(settingsState.reasoningLevel).toBe('medium')
    })

    it('forwards extra class names onto the root without forcing a 234px shell', () => {
        modelsState = testModels
        renderModelSelect('min-w-0 flex-[1_1_234px]')

        const trigger = screen.getByRole('button', { name: 'Model' })
        const modelSelect = trigger.parentElement
        expect(modelSelect).toHaveClass(
            'relative',
            'w-max',
            'min-w-0',
            'flex-[1_1_234px]',
        )
        expect(modelSelect).not.toHaveClass('w-[234px]')
    })

    it('shows the recorded runtime settings for a locked restored session', () => {
        modelsState = testModels
        settingsState = {
            ...settingsState,
            modelId: 'model-fast',
            reasoningLevel: 'high',
            speed: 'fast',
        }
        sessionsState = [
            {
                id: 'restored-session',
                title: 'Restored',
                pinned: false,
                modelId: 'model-primary',
                reasoningEffort: 'xhigh',
                speed: 'standard',
                createdAt: 1,
                updatedAt: 1,
            },
        ]

        render(<ModelSelect disabled sessionId="restored-session" />)

        const trigger = screen.getByRole('button', { name: 'Model' })
        expect(trigger).toBeDisabled()
        expect(trigger).toHaveTextContent('Primary Model')
        expect(trigger).toHaveTextContent('Extra high')
        expect(settingsState).toMatchObject({
            modelId: 'model-fast',
            reasoningLevel: 'high',
            speed: 'fast',
        })
    })

    it('closes on outside click or Escape and does not open when disabled', async () => {
        const user = userEvent.setup()
        modelsState = testModels
        const { rerender } = render(<ModelSelect />)

        await user.click(screen.getByRole('button', { name: 'Model' }))
        expect(screen.getByRole('slider', { name: 'Reasoning strength' })).toBeVisible()

        fireEvent.mouseDown(document.body)
        expect(screen.queryByRole('slider', { name: 'Reasoning strength' })).not.toBeInTheDocument()

        await user.click(screen.getByRole('button', { name: 'Model' }))
        await user.keyboard('{Escape}')
        expect(screen.queryByRole('slider', { name: 'Reasoning strength' })).not.toBeInTheDocument()

        rerender(<ModelSelect disabled />)
        expect(screen.getByRole('button', { name: 'Model' })).toBeDisabled()
        expect(screen.queryByRole('slider', { name: 'Reasoning strength' })).not.toBeInTheDocument()
    })

    it('filters out disabled models when enableAll is false', async () => {
        const user = userEvent.setup()
        modelsState = testModels
        settingsState = {
            ...settingsState,
            modelSettings: {
                enableAll: false,
                models: {
                    'model-fast': { enabled: false },
                },
            },
        }

        renderModelSelect()

        await user.click(screen.getByRole('button', { name: 'Model' }))
        await user.click(screen.getByRole('menuitem', { name: 'Advanced' }))
        await user.click(screen.getByRole('menuitem', { name: /Model/i }))

        expect(screen.getByRole('menuitemradio', { name: 'Primary Model' })).toBeInTheDocument()
        expect(screen.queryByRole('menuitemradio', { name: 'Fast Model' })).not.toBeInTheDocument()
        expect(screen.getByRole('menuitemradio', { name: 'Even Reasoning Model' })).toBeInTheDocument()
    })

    it('preserves independent model selections per session when switching between sessions', async () => {
        const user = userEvent.setup()
        modelsState = testModels
        sessionsState = [
            {
                id: 'session-1',
                title: 'Session 1',
                pinned: false,
                modelId: 'model-primary',
                reasoningEffort: 'xhigh',
                speed: 'standard',
                createdAt: 1,
                updatedAt: 1,
            },
            {
                id: 'session-2',
                title: 'Session 2',
                pinned: false,
                modelId: 'model-fast',
                reasoningEffort: 'low',
                speed: 'fast',
                createdAt: 2,
                updatedAt: 2,
            },
        ]

        // Render session-1
        const { rerender } = render(<ModelSelect sessionId="session-1" />)
        let trigger = screen.getByRole('button', { name: 'Model' })
        expect(trigger).toHaveTextContent('Primary Model')
        expect(trigger).toHaveTextContent('Extra high')

        // Switch to session-2
        rerender(<ModelSelect sessionId="session-2" />)
        trigger = screen.getByRole('button', { name: 'Model' })
        expect(trigger).toHaveTextContent('Fast Model')
        expect(trigger).toHaveTextContent('Low')

        // Change model in session-2 to Even Reasoning Model with high reasoning
        await user.click(trigger)
        await user.click(screen.getByRole('menuitem', { name: 'Advanced' }))
        await user.click(screen.getByRole('menuitem', { name: /Model/i }))
        await user.click(screen.getByRole('menuitemradio', { name: /Even Reasoning Model/ }))

        // Session 2 state is updated
        const session2 = sessionsState.find((s) => s.id === 'session-2')
        expect(session2?.modelId).toBe('model-even-reasoning')

        // Switch back to session-1: must retain Primary Model and xhigh reasoning
        rerender(<ModelSelect sessionId="session-1" />)
        trigger = screen.getByRole('button', { name: 'Model' })
        expect(trigger).toHaveTextContent('Primary Model')
        expect(trigger).toHaveTextContent('Extra high')

        const session1 = sessionsState.find((s) => s.id === 'session-1')
        expect(session1?.modelId).toBe('model-primary')
        expect(session1?.reasoningEffort).toBe('xhigh')
    })

    it('updates session runtime settings immediately when changing reasoning slider or speed in active session', async () => {
        const user = userEvent.setup()
        modelsState = testModels
        sessionsState = [
            {
                id: 'session-active',
                title: 'Active Session',
                pinned: false,
                modelId: 'model-fast',
                reasoningEffort: 'low',
                speed: 'standard',
                createdAt: 1,
                updatedAt: 1,
            },
        ]

        render(<ModelSelect sessionId="session-active" />)

        const trigger = screen.getByRole('button', { name: 'Model' })
        await user.click(trigger)

        // Toggle speed
        const speedToggle = screen.getByRole('menuitemcheckbox', { name: 'Fast' })
        await user.click(speedToggle)

        let updatedSession = sessionsState.find((s) => s.id === 'session-active')
        expect(updatedSession?.speed).toBe('fast')

        // Change reasoning via slider
        const slider = screen.getByRole('slider', { name: 'Reasoning strength' })
        fireEvent.change(slider, { target: { value: '1' } }) // index 1 for model-fast is 'high'

        updatedSession = sessionsState.find((s) => s.id === 'session-active')
        expect(updatedSession?.reasoningEffort).toBe('high')
    })

    it('allows opening menu and changing reasoning during active session run, but disallows switching model', async () => {
        const user = userEvent.setup()
        modelsState = testModels
        sessionsState = [
            {
                id: 'session-running-1',
                title: 'Running Session',
                pinned: false,
                modelId: 'model-primary',
                reasoningEffort: 'low',
                speed: 'standard',
                createdAt: 1,
                updatedAt: 1,
            },
        ]
        activeRunsState['session-running-1'] = {
            sessionId: 'session-running-1',
            runId: 'run-1',
            status: 'running',
            clientId: 'c1',
            updatedAt: Date.now(),
        }

        render(<ModelSelect sessionId="session-running-1" />)

        const trigger = screen.getByRole('button', { name: 'Model' })
        expect(trigger).not.toBeDisabled()
        await user.click(trigger)

        // Menu is opened
        expect(screen.getByRole('menu', { name: 'Model menu' })).toBeVisible()

        // Menuitem for Advanced / model change is NOT in document
        expect(screen.queryByRole('menuitem')).not.toBeInTheDocument()
        expect(screen.queryByText('Advanced')).not.toBeInTheDocument()

        // Slider is present and functional
        const slider = screen.getByRole('slider', { name: 'Reasoning strength' })
        expect(slider).toBeVisible()
        expect(slider).not.toBeDisabled()

        fireEvent.change(slider, { target: { value: '2' } }) // index 2 is 'high'
        const updatedSession = sessionsState.find((s) => s.id === 'session-running-1')
        expect(updatedSession?.reasoningEffort).toBe('high')
    })

    it('measures compact width via offscreen element and preserves width transition style when folding back on outside click', async () => {
        const user = userEvent.setup()
        modelsState = testModels

        const { container } = render(<ModelSelect />)
        const trigger = screen.getByRole('button', { name: 'Model' })

        // Find the hidden measurement element
        const hiddenMeasure = container.querySelector('[aria-hidden="true"].invisible')
        expect(hiddenMeasure).toBeInTheDocument()
        expect(hiddenMeasure).toHaveClass('pointer-events-none', 'invisible', 'absolute', '-z-50')

        // Click trigger to open
        await user.click(trigger)
        expect(trigger).toHaveStyle({ width: '234px' })
        expect(trigger).toHaveClass('transition-[width,background-color,color]')

        // Click outside to fold back
        fireEvent.mouseDown(document.body)

        // Should close and fold back without inline style corruption
        expect(screen.queryByRole('menu', { name: 'Model menu' })).not.toBeInTheDocument()
        expect(trigger).not.toHaveStyle({ width: '234px' })
        expect(trigger).toHaveClass('transition-[width,background-color,color]')
    })

    it('renders model menu inside a portal with z-[70] to prevent being covered by floating overlays', async () => {
        const user = userEvent.setup()
        modelsState = testModels

        const { container } = render(<ModelSelect />)
        const trigger = screen.getByRole('button', { name: 'Model' })

        await user.click(trigger)

        const menu = screen.getByRole('menu', { name: 'Model menu' })
        expect(menu).toBeInTheDocument()

        const portalContainer = menu.closest('[data-model-menu-portal]')
        expect(portalContainer).toBeInTheDocument()
        expect(portalContainer).toHaveClass('fixed', 'z-[70]')
        expect(portalContainer?.parentElement).toBe(document.body)
        expect(container.contains(portalContainer)).toBe(false)
    })

    it('keeps inline width unset in closed state across reasoning effort changes so trigger expands directly without ellipsis', async () => {
        modelsState = testModels
        settingsState = {
            ...settingsState,
            modelId: 'model-primary',
            reasoningLevel: 'high',
        }

        const { rerender } = render(<ModelSelect />)
        const trigger = screen.getByRole('button', { name: 'Model' })

        // When closed in steady state, inline width must not be locked to a fixed pixel value
        expect(trigger.style.width).toBe('')
        expect(trigger).toHaveTextContent('Primary Model')

        // Simulate reasoning effort changing to xhigh (e.g. via Shift+Tab)
        settingsState = {
            ...settingsState,
            reasoningLevel: 'xhigh',
        }
        await act(async () => {
            notifySettings()
        })
        rerender(<ModelSelect />)

        // Trigger text updates immediately and inline width remains unset for instant natural expansion
        expect(trigger).toHaveTextContent('Primary Model')
        expect(trigger.style.width).toBe('')
    })
})
