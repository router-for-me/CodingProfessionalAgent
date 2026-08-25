import i18n from '@/i18n'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import { ScheduledView } from './ScheduledView.js'
import { useScheduledTasksStore } from '../stores/scheduledTasksStore.js'
import { HostServicesProvider } from '@cpa/plugin-ui'
import type { HostServices } from '@cpa/plugin-api'

const navigateMock = vi.fn()
const sendMock = vi.fn().mockResolvedValue('mock-session-123')

vi.mock('@tanstack/react-router', () => ({
    useNavigate: () => navigateMock,
    useRouterState: ({
        select,
    }: {
        select: (state: { location: { pathname: string } }) => unknown
    }) => select({ location: { pathname: '/scheduled' } }),
}))

describe('ScheduledView', () => {
    let mockServices: HostServices

    beforeEach(async () => {
        await i18n.changeLanguage('en')
        navigateMock.mockReset()
        sendMock.mockClear()
        useScheduledTasksStore.setState({
            tasks: [],
            modalOpen: false,
            editingTask: null,
            historyDrawerOpen: false,
            historyTask: null,
        })

        mockServices = {
            sessions: {
                getSnapshot: () => [],
                subscribe: () => () => {},
                list: async () => [],
                get: async () => undefined,
                update: async () => {},
                broadcastRunStatus: async () => {},
            } as any,
            projects: {
                getSnapshot: () => [],
                subscribe: () => () => {},
                list: async () => [],
            } as any,
            settings: {
                getSnapshot: () => ({}),
                subscribe: () => () => {},
            } as any,
            skillUsage: {
                fetchUsageCounts: async () => ({}),
                recordUsage: () => {},
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
            agent: {
                send: sendMock,
                isStreaming: false,
            } as any,
        } as unknown as HostServices
    })

    it('renders header, search bar, and suggestions list when no tasks exist (hiding filter tabs)', () => {
        render(
            <HostServicesProvider services={mockServices}>
                <ScheduledView />
            </HostServicesProvider>,
        )

        expect(screen.getByText('Scheduled tasks')).toBeInTheDocument()
        expect(
            screen.getByText('Have CPA schedule tasks, set reminders, or monitor updates'),
        ).toBeInTheDocument()
        expect(
            screen.getByPlaceholderText('Search scheduled tasks'),
        ).toBeInTheDocument()
        expect(screen.getByText('Suggestions')).toBeInTheDocument()
        expect(screen.getByText('Daily briefing')).toBeInTheDocument()
        expect(screen.getByText('Weekly review')).toBeInTheDocument()
        expect(screen.getByText('Follow-up monitoring')).toBeInTheDocument()

        // Filter bar and mark all as read should be hidden when tasks is empty
        expect(screen.queryByText('All')).not.toBeInTheDocument()
        expect(screen.queryByText('Active')).not.toBeInTheDocument()
        expect(screen.queryByText('Mark all as read')).not.toBeInTheDocument()
    })

    it('opens create modal directly when clicking "Create" button without dropdown menu', () => {
        render(
            <HostServicesProvider services={mockServices}>
                <ScheduledView />
            </HostServicesProvider>,
        )

        const createButton = screen.getByRole('button', { name: /Create/i })
        expect(screen.queryByText('Create with CPA')).not.toBeInTheDocument()
        expect(screen.queryByText('Set up manually')).not.toBeInTheDocument()

        fireEvent.click(createButton)

        expect(useScheduledTasksStore.getState().modalOpen).toBe(true)
        expect(screen.queryByText('Create with CPA')).not.toBeInTheDocument()
        expect(screen.queryByText('Set up manually')).not.toBeInTheDocument()
    })

    it('hides create button when modalOpen is true', () => {
        const { rerender } = render(
            <HostServicesProvider services={mockServices}>
                <ScheduledView />
            </HostServicesProvider>,
        )

        const createButton = screen.getByRole('button', { name: /Create/i })
        fireEvent.click(createButton)

        expect(useScheduledTasksStore.getState().modalOpen).toBe(true)

        rerender(
            <HostServicesProvider services={mockServices}>
                <ScheduledView />
            </HostServicesProvider>,
        )
        expect(screen.queryByRole('button', { name: /Create/i })).not.toBeInTheDocument()
    })

    it('filters suggestions when searching', async () => {
        render(
            <HostServicesProvider services={mockServices}>
                <ScheduledView />
            </HostServicesProvider>,
        )

        const searchInput = screen.getByPlaceholderText('Search scheduled tasks')
        await userEvent.type(searchInput, 'briefing')

        expect(screen.getByText('Daily briefing')).toBeInTheDocument()
        expect(screen.queryByText('Weekly review')).not.toBeInTheDocument()
        expect(screen.queryByText('Follow-up monitoring')).not.toBeInTheDocument()
    })

    it('renders filter tabs and manages user created scheduled tasks with status filter tabs', () => {
        useScheduledTasksStore.setState({
            tasks: [
                {
                    id: 'task-1',
                    title: 'hello',
                    schedule: 'Daily 9:00',
                    prompt: 'Check status',
                    enabled: true,
                    status: 'active',
                    unread: true,
                    createdAt: Date.now(),
                },
                {
                    id: 'task-2',
                    title: 'Weekend Maintenance',
                    schedule: 'Weekly 18:00',
                    prompt: 'Weekly maintenance',
                    enabled: false,
                    status: 'paused',
                    unread: false,
                    createdAt: Date.now(),
                },
            ],
        })

        render(
            <HostServicesProvider services={mockServices}>
                <ScheduledView />
            </HostServicesProvider>,
        )

        expect(screen.getByText('All')).toBeInTheDocument()
        expect(screen.getByText('Active')).toBeInTheDocument()
        expect(screen.getByText('Paused')).toBeInTheDocument()
        expect(screen.getByText('Completed')).toBeInTheDocument()
        expect(screen.getByText('Mark all as read')).toBeInTheDocument()

        expect(screen.getByText('hello')).toBeInTheDocument()
        expect(screen.getByText('Weekend Maintenance')).toBeInTheDocument()

        // Switch to "Active" filter
        fireEvent.click(screen.getByText('Active'))
        expect(screen.getByText('hello')).toBeInTheDocument()
        expect(screen.queryByText('Weekend Maintenance')).not.toBeInTheDocument()

        // Switch to "Paused" filter
        fireEvent.click(screen.getByText('Paused'))
        expect(screen.queryByText('hello')).not.toBeInTheDocument()
        expect(screen.getByText('Weekend Maintenance')).toBeInTheDocument()
    })

    it('marks all tasks as read when clicking "Mark all as read"', () => {
        useScheduledTasksStore.setState({
            tasks: [
                {
                    id: 'task-1',
                    title: 'hello',
                    schedule: 'Daily 9:00',
                    prompt: 'Check status',
                    enabled: true,
                    unread: true,
                    createdAt: Date.now(),
                },
            ],
        })

        render(
            <HostServicesProvider services={mockServices}>
                <ScheduledView />
            </HostServicesProvider>,
        )
        const markAllButton = screen.getByText('Mark all as read')
        fireEvent.click(markAllButton)

        expect(useScheduledTasksStore.getState().tasks[0]?.unread).toBe(false)
    })

    it('opens history drawer and marks task as read when clicking a task row', () => {
        const task = {
            id: 'task-1',
            title: 'hello',
            schedule: 'Daily 9:00',
            prompt: 'Check status',
            enabled: true,
            unread: true,
            createdAt: Date.now(),
        }
        useScheduledTasksStore.setState({
            tasks: [task],
        })

        render(
            <HostServicesProvider services={mockServices}>
                <ScheduledView />
            </HostServicesProvider>,
        )

        const taskRow = screen.getByText('hello').closest('div[class*="group"]')
        expect(taskRow).toBeTruthy()
        if (taskRow) {
            fireEvent.click(taskRow)
            expect(useScheduledTasksStore.getState().modalOpen).toBe(true)
            expect(useScheduledTasksStore.getState().editingTask?.id).toBe('task-1')
            expect(useScheduledTasksStore.getState().tasks[0]?.unread).toBe(false)
        }
    })

    it('handles pagination with 5 items per page and hides pagination when <= 5', () => {
        const createTasks = (count: number) =>
            Array.from({ length: count }, (_, i) => ({
                id: `task-${i + 1}`,
                title: `Task #${i + 1}`,
                schedule: 'Daily 9:00',
                prompt: `Prompt ${i + 1}`,
                enabled: true,
                status: 'active' as const,
                createdAt: Date.now() - i * 1000,
            }))

        // Test with 3 tasks (<= 5)
        useScheduledTasksStore.setState({
            tasks: createTasks(3),
        })
        const { unmount } = render(
            <HostServicesProvider services={mockServices}>
                <ScheduledView />
            </HostServicesProvider>,
        )
        expect(screen.getByText('Task #1')).toBeInTheDocument()
        expect(screen.getByText('Task #3')).toBeInTheDocument()
        expect(screen.queryByLabelText('Previous page')).not.toBeInTheDocument()
        expect(screen.queryByLabelText('Next page')).not.toBeInTheDocument()
        unmount()

        // Test with 7 tasks (> 5)
        useScheduledTasksStore.setState({
            tasks: createTasks(7),
        })
        render(
            <HostServicesProvider services={mockServices}>
                <ScheduledView />
            </HostServicesProvider>,
        )

        expect(screen.getByText('Task #1')).toBeInTheDocument()
        expect(screen.getByText('Task #5')).toBeInTheDocument()
        expect(screen.queryByText('Task #6')).not.toBeInTheDocument()

        expect(screen.getByText('Page 1 of 2')).toBeInTheDocument()
        const nextPageBtn = screen.getByLabelText('Next page')
        fireEvent.click(nextPageBtn)

        expect(screen.getByText('Page 2 of 2')).toBeInTheDocument()
        expect(screen.getByText('Task #6')).toBeInTheDocument()
        expect(screen.getByText('Task #7')).toBeInTheDocument()
        expect(screen.queryByText('Task #1')).not.toBeInTheDocument()
    })

    it('directly creates a scheduled task record when clicking a suggestion without entering chat', () => {
        render(
            <HostServicesProvider services={mockServices}>
                <ScheduledView />
            </HostServicesProvider>,
        )

        const briefingCard = screen.getByText('Daily briefing').closest('div[class*="group"]')
        expect(briefingCard).toBeTruthy()

        if (briefingCard) {
            fireEvent.click(briefingCard)

            const tasks = useScheduledTasksStore.getState().tasks
            expect(tasks).toHaveLength(1)
            expect(tasks[0]?.title).toBe('Daily briefing')
            expect(tasks[0]?.schedule).toBe('Weekdays 8:00 AM')
            expect(tasks[0]?.status).toBe('active')
            expect(tasks[0]?.enabled).toBe(true)

            expect(sendMock).not.toHaveBeenCalled()
            expect(navigateMock).not.toHaveBeenCalled()
        }
    })

    it('hydrates tasks from hostServices.schedule on mount when store is initially empty', async () => {
        const persistedTasks = [
            {
                id: 'persisted-1',
                title: 'Persisted Schedule Task',
                schedule: 'Daily 22:49:00',
                prompt: '$gh-issue 5333',
                enabled: true,
                status: 'active' as const,
                createdAt: Date.now(),
            },
        ]
        const listMock = vi.fn().mockResolvedValue(persistedTasks)
        const servicesWithSchedule = {
            ...mockServices,
            schedule: {
                list: listMock,
                save: vi.fn().mockResolvedValue(undefined),
            },
        }

        render(
            <HostServicesProvider services={servicesWithSchedule}>
                <ScheduledView />
            </HostServicesProvider>,
        )

        await waitFor(() => {
            expect(screen.getByText('Persisted Schedule Task')).toBeInTheDocument()
        })
        expect(listMock).toHaveBeenCalled()
    })
})
