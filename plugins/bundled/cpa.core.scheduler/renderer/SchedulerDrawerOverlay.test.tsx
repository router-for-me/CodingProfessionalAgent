import i18n from '@/i18n'
import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import { HostServicesProvider } from '@cpa/plugin-ui'
import type { HostServices } from '@cpa/plugin-api'
import { useScheduledTasksStore } from './stores/scheduledTasksStore.js'

const navigateMock = vi.fn()
let mockPathname = '/scheduled'

vi.mock('@tanstack/react-router', () => ({
    useNavigate: () => navigateMock,
    useRouterState: ({
        select,
    }: {
        select: (state: { location: { pathname: string } }) => unknown
    }) => select({ location: { pathname: mockPathname } }),
}))

describe('SchedulerDrawerOverlay', () => {
    let mockServices: HostServices

    beforeEach(async () => {
        await i18n.changeLanguage('en')
        mockPathname = '/scheduled'
        navigateMock.mockReset()
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
            },
            projects: {
                getSnapshot: () => [],
                subscribe: () => () => {},
            },
            settings: {
                getSnapshot: () => ({}),
                subscribe: () => () => {},
            },
            skillUsage: {
                getAvailableSkills: () => [],
            },
        } as unknown as HostServices
    })

    it('renders the create drawer on /scheduled when modalOpen is true', async () => {
        const { SchedulerDrawerOverlay } = await import('./index.js')
        useScheduledTasksStore.setState({ modalOpen: true, editingTask: null })

        render(
            <HostServicesProvider services={mockServices}>
                <SchedulerDrawerOverlay />
            </HostServicesProvider>,
        )

        expect(screen.getByRole('complementary')).toBeInTheDocument()
        expect(screen.getByText('New')).toBeInTheDocument()
        expect(screen.getByRole('separator', { name: 'Resize sidebar' })).toBeInTheDocument()
    })

    it('uses a 1px visual resize handle', async () => {
        const { SchedulerDrawerOverlay } = await import('./index.js')
        useScheduledTasksStore.setState({ modalOpen: true, editingTask: null })

        render(
            <HostServicesProvider services={mockServices}>
                <SchedulerDrawerOverlay />
            </HostServicesProvider>,
        )

        const handle = screen.getByRole('separator', { name: 'Resize sidebar' })
        expect(handle.className).toContain('after:w-px')
        expect(handle.className).not.toContain('w-1.5')
    })

    it('closes and unmounts the drawer when leaving /scheduled', async () => {
        const { SchedulerDrawerOverlay } = await import('./index.js')
        useScheduledTasksStore.setState({
            modalOpen: true,
            editingTask: null,
            historyDrawerOpen: false,
            historyTask: null,
        })

        const { rerender } = render(
            <HostServicesProvider services={mockServices}>
                <SchedulerDrawerOverlay />
            </HostServicesProvider>,
        )

        expect(screen.getByRole('complementary')).toBeInTheDocument()

        mockPathname = '/chat/session-1'
        rerender(
            <HostServicesProvider services={mockServices}>
                <SchedulerDrawerOverlay />
            </HostServicesProvider>,
        )

        expect(screen.queryByRole('complementary')).toBeNull()
        expect(useScheduledTasksStore.getState().modalOpen).toBe(false)
        expect(useScheduledTasksStore.getState().editingTask).toBeNull()
        expect(useScheduledTasksStore.getState().historyDrawerOpen).toBe(false)
        expect(useScheduledTasksStore.getState().historyTask).toBeNull()
    })

    it('closes history drawer state when leaving /scheduled', async () => {
        const { SchedulerDrawerOverlay } = await import('./index.js')
        useScheduledTasksStore.setState({
            modalOpen: false,
            editingTask: null,
            historyDrawerOpen: true,
            historyTask: {
                id: 'task-1',
                title: 'Historical Task',
                schedule: 'Daily 09:00:00',
                prompt: 'do work',
                enabled: true,
                createdAt: 1,
            },
        })

        const { rerender } = render(
            <HostServicesProvider services={mockServices}>
                <SchedulerDrawerOverlay />
            </HostServicesProvider>,
        )

        expect(screen.getByRole('complementary')).toBeInTheDocument()

        mockPathname = '/'
        rerender(
            <HostServicesProvider services={mockServices}>
                <SchedulerDrawerOverlay />
            </HostServicesProvider>,
        )

        expect(screen.queryByRole('complementary')).toBeNull()
        expect(useScheduledTasksStore.getState().historyDrawerOpen).toBe(false)
        expect(useScheduledTasksStore.getState().historyTask).toBeNull()
    })
})
