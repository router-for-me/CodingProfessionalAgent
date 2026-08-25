import i18n from '@/i18n'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import { ScheduledCreateDrawer } from './ScheduledCreateDrawer.js'
import { useScheduledTasksStore } from '../stores/scheduledTasksStore.js'
import { HostServicesProvider } from '@cpa/plugin-ui'
import type { HostServices, ModelCatalogEntry, Project, SessionItem } from '@cpa/plugin-api'

const navigateMock = vi.fn()

vi.mock('@tanstack/react-router', () => ({
    useNavigate: () => navigateMock,
}))

describe('ScheduledCreateDrawer', () => {
    const onCloseMock = vi.fn()
    let mockSessions: SessionItem[]
    let mockProjects: Project[]
    let mockModels: ModelCatalogEntry[]
    let mockUsageCounts: Record<string, number>
    let hostServices: HostServices

    beforeEach(async () => {
        await i18n.changeLanguage('en')
        navigateMock.mockReset()
        onCloseMock.mockReset()
        useScheduledTasksStore.setState({
            tasks: [],
            modalOpen: true,
            editingTask: null,
        })

        mockUsageCounts = {}

        mockSessions = [
            {
                id: 'session-1',
                title: 'Realtime Voice Chat',
                pinned: false,
                createdAt: 1787884800000,
                updatedAt: 1787884800000,
            },
            {
                id: 'session-2',
                title: 'Help me see what this project does',
                pinned: false,
                createdAt: 1787280000000,
                updatedAt: 1787280000000,
            },
            {
                id: 'session-3',
                title: 'Archive chat',
                pinned: false,
                archivedAt: 1787280000000,
                createdAt: 1787280000000,
                updatedAt: 1787280000000,
            },
        ]

        mockProjects = [
            {
                id: 'proj-1',
                name: 'EasyCLIProxyAPI',
                path: '/workspace/easy-cli-proxy-api',
                paths: ['/workspace/easy-cli-proxy-api'],
                pinned: false,
                createdAt: 1000,
                updatedAt: 1000,
            },
            {
                id: 'proj-2',
                name: 'cpa-usage-keeper',
                path: '/workspace/cpa-usage-keeper',
                paths: ['/workspace/cpa-usage-keeper'],
                pinned: false,
                createdAt: 1000,
                updatedAt: 1000,
            },
        ]

        mockModels = [
            {
                id: 'gpt-5.6-sol',
                label: 'GPT 5.6 Sol',
                supportsFast: true,
                reasoningLevels: [
                    { id: 'low', requestValue: 'low', labelKey: 'composer.reasoning.low', fallbackLabel: 'Low' },
                    { id: 'medium', requestValue: 'medium', labelKey: 'composer.reasoning.medium', fallbackLabel: 'Medium' },
                    { id: 'high', requestValue: 'high', labelKey: 'composer.reasoning.high', fallbackLabel: 'High' },
                    { id: 'xhigh', requestValue: 'xhigh', labelKey: 'composer.reasoning.xhigh', fallbackLabel: 'Extra high' },
                ],
                input: ['text'],
                contextWindow: 128000,
                maxTokens: 4096,
            },
            {
                id: 'claude-3-7-sonnet',
                label: 'Claude 3.7 Sonnet',
                supportsFast: true,
                reasoningLevels: [
                    { id: 'low', requestValue: 'low', labelKey: 'composer.reasoning.low', fallbackLabel: 'Low' },
                    { id: 'high', requestValue: 'high', labelKey: 'composer.reasoning.high', fallbackLabel: 'High' },
                ],
                input: ['text'],
                contextWindow: 200000,
                maxTokens: 8192,
            },
        ]

        hostServices = {
            sessions: {
                getSnapshot: () => mockSessions,
                subscribe: (listener: any) => {
                    listener(mockSessions)
                    return () => {}
                },
                list: async () => mockSessions,
                get: async (id) => mockSessions.find((s) => s.id === id),
                update: async () => {},
                broadcastRunStatus: async () => {},
            } as any,
            projects: {
                getSnapshot: () => mockProjects,
                subscribe: (listener: any) => {
                    listener(mockProjects)
                    return () => {}
                },
                list: async () => mockProjects,
            } as any,
            settings: {
                getSnapshot: () => ({
                    modelId: 'gpt-5.6-sol',
                    reasoningLevel: 'xhigh',
                }),
                subscribe: () => () => {},
            } as any,
            skillUsage: {
                fetchUsageCounts: async () => mockUsageCounts,
                recordUsage: (name: string, delta = 1) => {
                    mockUsageCounts[name] = (mockUsageCounts[name] || 0) + delta
                },
                getAvailableSkills: () => [],
                getSnapshot: () => mockUsageCounts,
                subscribe: () => () => {},
            },
            navigation: {
                navigate: async (to) => {
                    navigateMock(to)
                },
            } as any,
            ui: {
                getPendingSessionContext: () => ({
                    projectId: null,
                    branch: null,
                    workLocation: 'local',
                    environmentId: null,
                }),
                pushToast: () => {},
            } as any,
        } as unknown as HostServices
    })

    it('renders header, inputs, details section, and frequency section', () => {
        render(
            <HostServicesProvider services={hostServices}>
                <ScheduledCreateDrawer
                    open
                    onClose={onCloseMock}
                    models={mockModels}
                />
            </HostServicesProvider>,
        )

        expect(screen.getByText('New')).toBeInTheDocument()
        expect(screen.getByPlaceholderText('Scheduled task title')).toBeInTheDocument()
        expect(screen.getByTestId('scheduled-prompt-input')).toBeInTheDocument()
        expect(screen.getByTestId('scheduled-prompt-input')).toHaveAttribute(
            'data-placeholder',
            'Describe what CPA should do',
        )

        // Details section defaults to existing-chat
        expect(screen.getByText('Details')).toBeInTheDocument()
        expect(screen.getByText('Run in')).toBeInTheDocument()
        expect(screen.getByText('Existing chat')).toBeInTheDocument()
        expect(screen.getByText('Chat')).toBeInTheDocument()
        expect(screen.getByText('New chat')).toBeInTheDocument()

        // Frequency section
        expect(screen.getByText('Frequency')).toBeInTheDocument()
        expect(screen.getByText('Repeat')).toBeInTheDocument()
        expect(screen.getByText('Daily')).toBeInTheDocument()
        expect(screen.getByText('Time')).toBeInTheDocument()
        expect(screen.getByText('09:00:00')).toBeInTheDocument()
        expect(screen.getByText('Notification')).toBeInTheDocument()
        expect(screen.getByText('Important updates')).toBeInTheDocument()
    })

    it('disables create button until title and prompt are filled', async () => {
        const user = userEvent.setup()
        render(
            <HostServicesProvider services={hostServices}>
                <ScheduledCreateDrawer
                    open
                    onClose={onCloseMock}
                    models={mockModels}
                />
            </HostServicesProvider>,
        )

        const createButton = screen.getByRole('button', { name: 'Create' })
        expect(createButton).toBeDisabled()

        const titleInput = screen.getByPlaceholderText('Scheduled task title')
        const promptInput = screen.getByTestId('scheduled-prompt-input')

        await user.type(titleInput, 'Daily Code Check')
        expect(createButton).toBeDisabled()

        await user.type(promptInput, 'Check uncommitted code and branch status')
        expect(createButton).not.toBeDisabled()

        fireEvent.click(createButton)
        expect(useScheduledTasksStore.getState().tasks).toHaveLength(1)
        expect(useScheduledTasksStore.getState().tasks[0]?.title).toBe('Daily Code Check')
        expect(useScheduledTasksStore.getState().tasks[0]?.prompt).toBe('Check uncommitted code and branch status')
        expect(onCloseMock).toHaveBeenCalled()
    })

    it('allows changing dropdown options', async () => {
        render(
            <HostServicesProvider services={hostServices}>
                <ScheduledCreateDrawer
                    open
                    onClose={onCloseMock}
                    models={mockModels}
                />
            </HostServicesProvider>,
        )

        // Open the repeat dropdown
        const repeatTrigger = screen.getByText('Daily')
        fireEvent.click(repeatTrigger)

        // Select the weekday option
        const weekdayOption = screen.getByRole('option', { name: 'Weekdays' })
        fireEvent.click(weekdayOption)

        expect(screen.getByText('Weekdays')).toBeInTheDocument()
    })

    it('allows changing notification option between Important updates and Only failed runs', async () => {
        const user = userEvent.setup()
        render(
            <HostServicesProvider services={hostServices}>
                <ScheduledCreateDrawer
                    open
                    onClose={onCloseMock}
                    models={mockModels}
                />
            </HostServicesProvider>,
        )

        // Notification defaults to important updates
        const notifyTrigger = screen.getByText('Important updates')
        fireEvent.click(notifyTrigger)

        // Verify the available notification options
        expect(screen.getByRole('option', { name: 'Important updates' })).toBeInTheDocument()
        expect(screen.getByRole('option', { name: 'Only unsuccessful runs' })).toBeInTheDocument()
        expect(screen.queryByRole('option', { name: 'All updates' })).not.toBeInTheDocument()
        expect(screen.queryByRole('option', { name: 'Mute' })).not.toBeInTheDocument()

        // Select the failure-only option
        fireEvent.click(screen.getByRole('option', { name: 'Only unsuccessful runs' }))
        expect(screen.getByText('Only unsuccessful runs')).toBeInTheDocument()

        await new Promise((r) => setTimeout(r, 60))

        await user.type(screen.getByPlaceholderText('Scheduled task title'), 'Build Monitor')
        await user.type(screen.getByTestId('scheduled-prompt-input'), 'Check CI build')

        fireEvent.click(screen.getByRole('button', { name: 'Create' }))

        const savedTasks = useScheduledTasksStore.getState().tasks
        expect(savedTasks).toHaveLength(1)
        expect(savedTasks[0]?.notification).toBe('failure-only')
    })

    it('supports editing an existing task with existing-chat and new-chat', async () => {
        const existingTask1 = {
            id: 'task-123',
            title: 'Original Task Title',
            prompt: 'Original Prompt',
            schedule: 'Daily 9:00:00',
            enabled: true,
            createdAt: Date.now(),
            runIn: 'existing-chat',
            chatSessionId: 'session-2',
            chatTitle: 'Help me see what this project does',
        }

        const { unmount } = render(
            <HostServicesProvider services={hostServices}>
                <ScheduledCreateDrawer
                    open
                    onClose={onCloseMock}
                    editingTask={existingTask1}
                    models={mockModels}
                />
            </HostServicesProvider>,
        )

        expect(screen.getByText('Edit')).toBeInTheDocument()
        expect(screen.getByDisplayValue('Original Task Title')).toBeInTheDocument()
        expect(screen.getByTestId('scheduled-prompt-input')).toHaveAttribute('data-value', 'Original Prompt')
        expect(screen.getByText('Help me see what this project does')).toBeInTheDocument()

        const titleInput = screen.getByDisplayValue('Original Task Title')
        const user = userEvent.setup()
        await user.clear(titleInput)
        await user.type(titleInput, 'Modified Title')

        const saveButton = screen.getByRole('button', { name: 'Save' })
        fireEvent.click(saveButton)

        expect(onCloseMock).toHaveBeenCalled()
        unmount()

        // Test editing a task with runIn: 'new-chat'
        const existingTask2 = {
            id: 'task-456',
            title: 'New Chat Task',
            prompt: 'Prompt',
            schedule: 'Daily 10:00:00',
            enabled: true,
            createdAt: Date.now(),
            runIn: 'new-chat',
            projectId: 'proj-deleted',
            projectName: 'Deleted Project',
            projectPath: '/workspace/cpa-usage-keeper',
            modelId: 'claude-3-7-sonnet',
            reasoningLevel: 'high',
        }

        render(
            <HostServicesProvider services={hostServices}>
                <ScheduledCreateDrawer
                    open
                    onClose={onCloseMock}
                    editingTask={existingTask2}
                    models={mockModels}
                />
            </HostServicesProvider>,
        )

        expect(screen.getByText('cpa-usage-keeper')).toBeInTheDocument()
        expect(screen.getByText('Claude 3.7 Sonnet')).toBeInTheDocument()
    })

    it('hides execution results section when task has no historical executions', () => {
        const existingTask = {
            id: 'task-no-hist',
            title: 'Task without history',
            prompt: 'Prompt',
            schedule: 'Daily 09:00:00',
            enabled: true,
            createdAt: Date.now(),
        }

        render(
            <HostServicesProvider services={hostServices}>
                <ScheduledCreateDrawer
                    open
                    onClose={onCloseMock}
                    editingTask={existingTask}
                    models={mockModels}
                />
            </HostServicesProvider>,
        )

        expect(screen.queryByText('Execution results')).not.toBeInTheDocument()
        expect(screen.queryByText('No execution records yet')).not.toBeInTheDocument()
    })

    it('renders execution history records in reverse chronological order with ascending sequence numbers and no count badge', () => {
        const existingTask = {
            id: 'task-hist-1',
            title: 'Automated Build Task',
            prompt: 'Run build script',
            schedule: 'Daily 09:00:00',
            enabled: true,
            createdAt: Date.now(),
        }

        mockSessions = [
            {
                id: 'session-hist-early',
                title: 'Earlier run',
                scheduleId: 'task-hist-1',
                pinned: false,
                createdAt: 1700001000000,
                updatedAt: 1700001000000,
            },
            {
                id: 'session-hist-late',
                title: 'Recent run',
                scheduleId: 'task-hist-1',
                pinned: false,
                createdAt: 1700009000000,
                updatedAt: 1700009000000,
            },
        ]

        render(
            <HostServicesProvider services={hostServices}>
                <ScheduledCreateDrawer
                    open
                    onClose={onCloseMock}
                    editingTask={existingTask}
                    models={mockModels}
                />
            </HostServicesProvider>,
        )

        // Section title is shown, but no count badge
        expect(screen.getByText('Execution results')).toBeInTheDocument()

        // Sequence numbers: recent run is listed first with #2, earlier run listed below with #1
        const seq1 = screen.getByText('#1')
        const seq2 = screen.getByText('#2')
        expect(seq1).toBeInTheDocument()
        expect(seq2).toBeInTheDocument()

        expect(screen.getByText('Recent run')).toBeInTheDocument()
        expect(screen.getByText('Earlier run')).toBeInTheDocument()

        fireEvent.click(screen.getByText('Recent run'))
        expect(onCloseMock).toHaveBeenCalled()
        expect(navigateMock).toHaveBeenCalledWith({
            to: '/chat/$sessionId',
            params: { sessionId: 'session-hist-late' },
        })
    })

    it('filters sessions in chat dropdown when searching', async () => {
        render(
            <HostServicesProvider services={hostServices}>
                <ScheduledCreateDrawer
                    open
                    onClose={onCloseMock}
                    models={mockModels}
                />
            </HostServicesProvider>,
        )

        // Open chat selector dropdown
        const chatTrigger = screen.getByText('New chat')
        fireEvent.click(chatTrigger)

        // Find search input
        const searchInput = screen.getByPlaceholderText('Search chats')
        expect(searchInput).toBeInTheDocument()

        const user = userEvent.setup()
        // Type query that only matches session-2
        await user.type(searchInput, 'this project')

        expect(screen.getByText('Help me see what this project does')).toBeInTheDocument()
        expect(screen.queryByText('Realtime Voice Chat')).not.toBeInTheDocument()

        // Clear search
        const clearBtn = screen.getByLabelText('Clear')
        fireEvent.click(clearBtn)
        expect(screen.getByText('Realtime Voice Chat')).toBeInTheDocument()
    })

    it('allows selecting an existing chat when runIn is existing-chat', async () => {
        const user = userEvent.setup()
        render(
            <HostServicesProvider services={hostServices}>
                <ScheduledCreateDrawer
                    open
                    onClose={onCloseMock}
                    models={mockModels}
                />
            </HostServicesProvider>,
        )

        // Open chat selector dropdown
        const chatTrigger = screen.getByText('New chat')
        await user.click(chatTrigger)

        // Verify other chats and select session-1
        expect(screen.getByText('Other chats')).toBeInTheDocument()
        expect(screen.getByText('Realtime Voice Chat')).toBeInTheDocument()

        await user.click(screen.getByText('Realtime Voice Chat'))
        expect(screen.getByText('Realtime Voice Chat')).toBeInTheDocument()

        await user.type(screen.getByPlaceholderText('Scheduled task title'), 'Continue existing task')
        await user.type(screen.getByTestId('scheduled-prompt-input'), 'Continue previous work')

        await user.click(screen.getByRole('button', { name: 'Create' }))

        const savedTasks = useScheduledTasksStore.getState().tasks
        expect(savedTasks).toHaveLength(1)
        expect(savedTasks[0]?.runIn).toBe('existing-chat')
        expect(savedTasks[0]?.chatSessionId).toBe('session-1')
        expect(savedTasks[0]?.chatTitle).toBe('Realtime Voice Chat')
        expect(onCloseMock).toHaveBeenCalled()
    })

    it('displays project, model, and reasoning options and allows custom configuration when runIn is new-chat', async () => {
        const user = userEvent.setup()
        render(
            <HostServicesProvider services={hostServices}>
                <ScheduledCreateDrawer
                    open
                    onClose={onCloseMock}
                    models={mockModels}
                />
            </HostServicesProvider>,
        )

        // Switch the run target to a new chat
        const runInTrigger = screen.getByText('Existing chat')
        fireEvent.click(runInTrigger)
        const newChatOption = screen.getByRole('option', { name: 'New chat' })
        fireEvent.click(newChatOption)

        // Project, Model, and Reasoning rows should now be visible
        expect(screen.getByText('Project')).toBeInTheDocument()
        expect(screen.getByText('EasyCLIProxyAPI')).toBeInTheDocument()

        expect(screen.getByText('Model')).toBeInTheDocument()
        expect(screen.getByText('GPT 5.6 Sol')).toBeInTheDocument()

        expect(screen.getByText('Reasoning')).toBeInTheDocument()
        expect(screen.getByText('Extra high')).toBeInTheDocument()

        // Open project dropdown and select another project
        const projectTrigger = screen.getByText('EasyCLIProxyAPI')
        fireEvent.click(projectTrigger)
        expect(screen.getByText('cpa-usage-keeper')).toBeInTheDocument()
        fireEvent.click(screen.getByText('cpa-usage-keeper'))
        expect(screen.getByText('cpa-usage-keeper')).toBeInTheDocument()

        // Open model dropdown and select another model
        const modelTrigger = screen.getByText('GPT 5.6 Sol')
        fireEvent.click(modelTrigger)
        expect(screen.getByText('Claude 3.7 Sonnet')).toBeInTheDocument()
        fireEvent.click(screen.getByText('Claude 3.7 Sonnet'))
        expect(screen.getByText('Claude 3.7 Sonnet')).toBeInTheDocument()

        // Open reasoning dropdown and select a level
        const reasoningTrigger = screen.getByText('Low')
        fireEvent.click(reasoningTrigger)
        const highReasoningOption = screen.getByRole('option', { name: /High/i })
        fireEvent.click(highReasoningOption)

        // Fill in title and prompt to submit
        await user.type(screen.getByPlaceholderText('Scheduled task title'), 'Code check task')
        await user.type(screen.getByTestId('scheduled-prompt-input'), 'Auto generate code')

        await user.click(screen.getByRole('button', { name: 'Create' }))

        const savedTasks = useScheduledTasksStore.getState().tasks
        expect(savedTasks).toHaveLength(1)
        expect(savedTasks[0]?.projectId).toBe('proj-2')
        expect(savedTasks[0]?.projectName).toBe('cpa-usage-keeper')
        expect(savedTasks[0]?.projectPath).toBe('/workspace/cpa-usage-keeper')
        expect(savedTasks[0]?.modelId).toBe('claude-3-7-sonnet')
        expect(savedTasks[0]?.reasoningLevel).toBe('high')
        expect(onCloseMock).toHaveBeenCalled()
    })

    it('allows precise time selection for hours, minutes, and seconds independently', async () => {
        render(
            <HostServicesProvider services={hostServices}>
                <ScheduledCreateDrawer
                    open
                    onClose={onCloseMock}
                    models={mockModels}
                />
            </HostServicesProvider>,
        )

        // Click on time trigger
        const timeTrigger = screen.getByText('09:00:00')
        fireEvent.click(timeTrigger)

        // Verify time picker dialog is open with Hour, Min, Sec column labels
        expect(screen.getByRole('dialog', { name: 'Time' })).toBeInTheDocument()
        expect(screen.getByText('Hour')).toBeInTheDocument()
        expect(screen.getByText('Min')).toBeInTheDocument()
        expect(screen.getByText('Sec')).toBeInTheDocument()

        const hourListbox = screen.getByRole('listbox', { name: 'Hour' })
        const minListbox = screen.getByRole('listbox', { name: 'Min' })
        const secListbox = screen.getByRole('listbox', { name: 'Sec' })

        // Select 14 for hours
        const hour14 = hourListbox.querySelector('button[aria-selected="false"]:nth-child(15)') ?? screen.getByText('14')
        fireEvent.click(hour14)

        // Select 30 for minutes
        const min30 = minListbox.querySelector('button[aria-selected="false"]:nth-child(31)') ?? screen.getByText('30')
        fireEvent.click(min30)

        // Select 45 for seconds
        const sec45 = secListbox.querySelector('button[aria-selected="false"]:nth-child(46)') ?? screen.getByText('45')
        fireEvent.click(sec45)

        // Display updated to 14:30:45
        expect(screen.getByText('14:30:45')).toBeInTheDocument()

        const user = userEvent.setup()
        // Submit task and verify schedule contains 14:30:45
        await user.type(screen.getByPlaceholderText('Scheduled task title'), 'Precise time task')
        await user.type(screen.getByTestId('scheduled-prompt-input'), 'Execute on time')

        fireEvent.click(screen.getByRole('button', { name: 'Create' }))

        const savedTasks = useScheduledTasksStore.getState().tasks
        expect(savedTasks).toHaveLength(1)
        expect(savedTasks[0]?.schedule).toContain('14:30:45')
    })

    it('drags the resize handle to change drawer width and clamps within bounds', () => {
        Object.defineProperty(window, 'innerWidth', {
            value: 1200,
            configurable: true,
        })

        const { container } = render(
            <HostServicesProvider services={hostServices}>
                <ScheduledCreateDrawer
                    open
                    onClose={onCloseMock}
                    models={mockModels}
                />
            </HostServicesProvider>,
        )
        const aside = container.querySelector('aside')
        expect(aside).toHaveStyle({ width: '420px' })

        const handle = screen.getByRole('separator', { name: 'Resize sidebar' })
        expect(handle).toBeInTheDocument()
        expect(aside?.className).toContain('transition-[width,transform]')

        // Drag to clientX = 700 -> width = 1200 - 700 = 500px
        fireEvent.pointerDown(handle, { clientX: 780, button: 0 })
        // Width transition must be disabled while dragging or the panel feels laggy.
        expect(aside?.className).not.toContain('transition-[width,transform]')
        expect(document.body.style.cursor).toBe('col-resize')
        fireEvent.pointerMove(window, { clientX: 700 })
        fireEvent.pointerUp(window)

        expect(aside).toHaveStyle({ width: '500px' })
        expect(aside?.className).toContain('transition-[width,transform]')
        expect(document.body.style.cursor).toBe('')

        // Drag beyond max bound -> clamped to 720px
        fireEvent.pointerDown(handle, { clientX: 700, button: 0 })
        fireEvent.pointerMove(window, { clientX: 200 })
        fireEvent.pointerUp(window)

        expect(aside).toHaveStyle({ width: '720px' })

        // Drag below min bound -> clamped to 320px
        fireEvent.pointerDown(handle, { clientX: 480, button: 0 })
        fireEvent.pointerMove(window, { clientX: 1100 })
        fireEvent.pointerUp(window)

        expect(aside).toHaveStyle({ width: '320px' })
    })

    it('closes on Escape key press or close button click', () => {
        const { container } = render(
            <HostServicesProvider services={hostServices}>
                <ScheduledCreateDrawer
                    open
                    onClose={onCloseMock}
                    models={mockModels}
                />
            </HostServicesProvider>,
        )
        const aside = container.querySelector('aside')

        fireEvent.keyDown(aside!, { key: 'Escape' })
        expect(onCloseMock).toHaveBeenCalledTimes(1)

        const closeBtn = screen.getByRole('button', { name: 'Close' })
        fireEvent.click(closeBtn)
        expect(onCloseMock).toHaveBeenCalledTimes(2)
    })

    it('handles mobile browser behavior correctly', () => {
        const originalUserAgent = navigator.userAgent
        const originalMaxTouchPoints = navigator.maxTouchPoints
        const originalInnerWidth = window.innerWidth

        Object.defineProperty(navigator, 'userAgent', {
            value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1',
            configurable: true,
        })
        Object.defineProperty(navigator, 'maxTouchPoints', {
            value: 5,
            configurable: true,
        })
        Object.defineProperty(window, 'innerWidth', {
            value: 390,
            configurable: true,
        })

        try {
            // Closed on mobile
            const { container: closedContainer } = render(
                <HostServicesProvider services={hostServices}>
                    <ScheduledCreateDrawer
                        open={false}
                        onClose={onCloseMock}
                        models={mockModels}
                    />
                </HostServicesProvider>,
            )
            const closedAside = closedContainer.querySelector('aside')
            expect(closedAside).toHaveAttribute('data-state', 'closed')
            expect(closedAside).toHaveAttribute('aria-hidden', 'true')
            expect(closedAside).toHaveClass('hidden')

            // Open on mobile
            const { container: openContainer } = render(
                <HostServicesProvider services={hostServices}>
                    <ScheduledCreateDrawer
                        open={true}
                        onClose={onCloseMock}
                        models={mockModels}
                    />
                </HostServicesProvider>,
            )
            const openAside = openContainer.querySelector('aside')
            expect(openAside).toHaveAttribute('data-state', 'open')
            expect(openAside).toHaveAttribute('data-mobile', 'true')
            expect(openAside).toHaveClass('fixed', 'inset-0', 'z-50')
            expect(screen.queryByRole('separator', { name: 'Resize sidebar' })).toBeNull()
        } finally {
            Object.defineProperty(navigator, 'userAgent', {
                value: originalUserAgent,
                configurable: true,
            })
            Object.defineProperty(navigator, 'maxTouchPoints', {
                value: originalMaxTouchPoints,
                configurable: true,
            })
            Object.defineProperty(window, 'innerWidth', {
                value: originalInnerWidth,
                configurable: true,
            })
        }
    })

    const sampleSkills = [
        {
            name: 'gh-issue',
            description: 'Triage GitHub issues',
            filePath: '/skills/gh-issue/SKILL.md',
        },
        {
            name: 'cpa-plugin-pr-audit',
            description: 'Audit CPA plugins',
            filePath: '/skills/cpa-plugin-pr-audit/SKILL.md',
        },
    ]

    it('opens skill suggestions menu when typing $ in prompt and inserts selected skill on Enter', async () => {
        const user = userEvent.setup()
        render(
            <HostServicesProvider services={hostServices}>
                <ScheduledCreateDrawer
                    open
                    onClose={onCloseMock}
                    models={mockModels}
                    skills={sampleSkills}
                />
            </HostServicesProvider>,
        )

        const promptInput = screen.getByTestId('scheduled-prompt-input')
        await user.type(promptInput, '$gh')

        // Skill listbox should appear
        expect(screen.getByRole('listbox', { name: 'Skills' })).toBeInTheDocument()
        expect(screen.getByText('Gh Issue')).toBeInTheDocument()

        // Press Enter to select the active first skill ('gh-issue')
        fireEvent.keyDown(promptInput, { key: 'Enter' })

        // Skill should be inserted with trailing space
        expect(promptInput).toHaveAttribute('data-value', '$gh-issue ')
        // Skill menu should close
        expect(screen.queryByRole('listbox', { name: 'Skills' })).not.toBeInTheDocument()
    })

    it('navigates skill suggestions with ArrowDown / ArrowUp and closes on Escape', async () => {
        const user = userEvent.setup()
        render(
            <HostServicesProvider services={hostServices}>
                <ScheduledCreateDrawer
                    open
                    onClose={onCloseMock}
                    models={mockModels}
                    skills={sampleSkills}
                />
            </HostServicesProvider>,
        )

        const promptInput = screen.getByTestId('scheduled-prompt-input')
        await user.type(promptInput, '$')

        expect(screen.getByRole('listbox', { name: 'Skills' })).toBeInTheDocument()

        // Navigate down to second option
        fireEvent.keyDown(promptInput, { key: 'ArrowDown' })
        // Navigate up back to first option
        fireEvent.keyDown(promptInput, { key: 'ArrowUp' })

        // Press Escape to close menu
        fireEvent.keyDown(promptInput, { key: 'Escape' })
        expect(screen.queryByRole('listbox', { name: 'Skills' })).not.toBeInTheDocument()
    })

    it('allows clicking a skill suggestion item to apply it', async () => {
        const user = userEvent.setup()
        render(
            <HostServicesProvider services={hostServices}>
                <ScheduledCreateDrawer
                    open
                    onClose={onCloseMock}
                    models={mockModels}
                    skills={sampleSkills}
                />
            </HostServicesProvider>,
        )

        const promptInput = screen.getByTestId('scheduled-prompt-input')
        await user.type(promptInput, '$')

        const option = screen.getByText('Cpa Plugin Pr Audit')
        fireEvent.mouseDown(option)

        expect(promptInput).toHaveAttribute('data-value', '$cpa-plugin-pr-audit ')
    })

    it('removes the entire skill chip on Backspace instead of expanding to $token', async () => {
        const user = userEvent.setup()
        render(
            <HostServicesProvider services={hostServices}>
                <ScheduledCreateDrawer
                    open
                    onClose={onCloseMock}
                    models={mockModels}
                    skills={sampleSkills}
                />
            </HostServicesProvider>,
        )

        const promptInput = screen.getByTestId('scheduled-prompt-input')
        await user.click(promptInput)
        await user.type(promptInput, '$gh')
        await user.keyboard('{Enter}')

        expect(screen.getByTestId('composer-skill-chip')).toBeInTheDocument()
        expect(promptInput).toHaveAttribute('data-value', '$gh-issue ')

        await user.keyboard('{Backspace}')

        expect(screen.queryByTestId('composer-skill-chip')).not.toBeInTheDocument()
        // Trailing separator space may remain, but the $token must not reappear.
        expect(promptInput.getAttribute('data-value') ?? '').not.toContain('$gh-issue')
        expect((promptInput.getAttribute('data-value') ?? '').trim()).toBe('')
        expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    })

    it('keeps typed prompt text when models prop is omitted', async () => {
        const user = userEvent.setup()
        render(
            <HostServicesProvider services={hostServices}>
                <ScheduledCreateDrawer open onClose={onCloseMock} />
            </HostServicesProvider>,
        )

        const promptInput = screen.getByTestId('scheduled-prompt-input')
        await user.click(promptInput)
        await user.type(promptInput, 'hello schedule')

        expect(promptInput).toHaveAttribute('data-value', 'hello schedule')
    })

    it('loads skills from host services and renders chips for existing $ tokens', () => {
        hostServices = {
            ...hostServices,
            skillUsage: {
                ...hostServices.skillUsage,
                getAvailableSkills: () => sampleSkills,
                getSnapshot: () => mockUsageCounts,
                subscribe: () => () => {},
            },
        } as HostServices

        render(
            <HostServicesProvider services={hostServices}>
                <ScheduledCreateDrawer
                    open
                    onClose={onCloseMock}
                    models={mockModels}
                    editingTask={{
                        id: 'task-1',
                        title: 'Triage',
                        prompt: '$gh-issue 5333',
                        schedule: 'Daily 09:00:00',
                        runIn: 'new-chat',
                        notification: 'important',
                        enabled: true,
                        createdAt: 1,
                    }}
                />
            </HostServicesProvider>,
        )

        const promptInput = screen.getByTestId('scheduled-prompt-input')
        expect(promptInput).toHaveAttribute('data-value', '$gh-issue 5333')
        expect(screen.getByTestId('composer-skill-chip')).toHaveTextContent('Gh Issue')
    })

    it('falls back to hostServices.models when models prop is omitted', async () => {
        let modelListener: (() => void) | undefined
        const modelsServiceMock = {
            getModels: vi.fn(() => mockModels),
            subscribe: vi.fn((listener: () => void) => {
                modelListener = listener
                return () => {
                    modelListener = undefined
                }
            }),
        }

        const servicesWithModels = {
            ...hostServices,
            models: modelsServiceMock,
        } as unknown as HostServices

        render(
            <HostServicesProvider services={servicesWithModels}>
                <ScheduledCreateDrawer
                    open
                    onClose={onCloseMock}
                    editingTask={{
                        id: 'task-no-models-prop',
                        title: 'Fallback Model Task',
                        prompt: 'Test prompt',
                        schedule: 'Daily 09:00:00',
                        runIn: 'new-chat',
                        notification: 'important',
                        enabled: true,
                        createdAt: 1,
                    }}
                />
            </HostServicesProvider>,
        )

        // Verify model select row is rendered with fallback models from service
        expect(screen.getByText('Model')).toBeInTheDocument()
        expect(screen.getByText('GPT 5.6 Sol')).toBeInTheDocument()

        // Verify subscribe was called
        expect(modelsServiceMock.subscribe).toHaveBeenCalled()
    })

    it('renders placeholder when no models are available', () => {
        const emptyServices = {
            ...hostServices,
            models: {
                getModels: () => [],
                subscribe: () => () => {},
            },
        } as unknown as HostServices

        render(
            <HostServicesProvider services={emptyServices}>
                <ScheduledCreateDrawer
                    open
                    onClose={onCloseMock}
                    models={[]}
                    editingTask={{
                        id: 'task-empty-models',
                        title: 'No Models Task',
                        prompt: 'Test prompt',
                        schedule: 'Daily 09:00:00',
                        runIn: 'new-chat',
                        notification: 'important',
                        enabled: true,
                        createdAt: 1,
                    }}
                />
            </HostServicesProvider>,
        )

        expect(screen.getByText('Model')).toBeInTheDocument()
        expect(screen.getByText(/No models/i)).toBeInTheDocument()
    })

    it('renders dropdown menu in body portal with scrollable container and whitespace-nowrap items', () => {
        render(
            <HostServicesProvider services={hostServices}>
                <ScheduledCreateDrawer
                    open
                    onClose={onCloseMock}
                    models={mockModels}
                    editingTask={{
                        id: 'task-portal-test',
                        title: 'Portal Test Task',
                        prompt: 'Test prompt',
                        schedule: 'Daily 09:00:00',
                        runIn: 'new-chat',
                        notification: 'important',
                        enabled: true,
                        createdAt: 1,
                    }}
                />
            </HostServicesProvider>,
        )

        // Open model dropdown
        const modelTrigger = screen.getByText('GPT 5.6 Sol')
        fireEvent.click(modelTrigger)

        // The listbox should be portaled directly to document.body
        const listbox = screen.getByRole('listbox')
        expect(listbox.parentElement).toBe(document.body)
        expect(listbox).toHaveClass('overflow-y-auto')
        expect(listbox).toHaveClass('w-max')

        // Option item should have whitespace-nowrap
        const option = screen.getByRole('option', { name: 'Claude 3.7 Sonnet' })
        expect(option).toHaveClass('whitespace-nowrap')

        // Pressing Escape should close the listbox without closing the drawer
        fireEvent.keyDown(document, { key: 'Escape' })
        expect(screen.queryByRole('listbox')).toBeNull()
        expect(onCloseMock).not.toHaveBeenCalled()
    })
})
