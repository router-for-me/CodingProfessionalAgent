import { act, render, screen, fireEvent, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { HostServicesProvider } from '@cpa/plugin-ui'
import type { HostServices, SettingsService, NotificationService } from '@cpa/plugin-api'
import { MemorySettingsSection } from './MemorySettingsSection.js'

vi.mock('@cpa/plugin-ui', async (importOriginal) => ({
    ...await importOriginal<typeof import('@cpa/plugin-ui')>(),
    useTranslation: () => ({ t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key }),
}))

describe('MemorySettingsSection', () => {
    let mockSettings: any
    let mockSettingsService: SettingsService
    let mockNotificationService: NotificationService
    let invoke: ReturnType<typeof vi.fn>
    let listeners: Array<() => void>

    beforeEach(() => {
        listeners = []
        mockSettings = {
            localMemoryEnabled: true,
            toolAssistedMemoryEnabled: false,
        }
        mockSettingsService = {
            getSnapshot: () => mockSettings,
            update: vi.fn().mockImplementation(async (partial) => {
                Object.assign(mockSettings, partial)
                listeners.forEach((l) => l())
            }),
            subscribe: vi.fn().mockImplementation((listener) => {
                listeners.push(listener)
                return () => {
                    listeners = listeners.filter((l) => l !== listener)
                }
            }),
        } as unknown as SettingsService

        mockNotificationService = {
            show: vi.fn(),
        } as unknown as NotificationService

        invoke = vi.fn().mockResolvedValue(undefined)
    })

    function renderWithServices(ui: React.ReactElement) {
        const services = {
            settings: mockSettingsService,
            notifications: mockNotificationService,
        } as unknown as HostServices

        return render(
            <HostServicesProvider services={services}>
                {ui}
            </HostServicesProvider>,
        )
    }

    it('renders memory section title and switches', () => {
        renderWithServices(<MemorySettingsSection />)

        expect(screen.getByText('Memory')).toBeInTheDocument()
        expect(screen.getByText('Enable local memory')).toBeInTheDocument()
        expect(screen.getByText('Tool-assisted memory')).toBeInTheDocument()
        expect(screen.getByText('Delete local memory')).toBeInTheDocument()
        expect(screen.getByText('Delete all memories stored in the local memory database. Legacy Markdown backup files in the memories folder are kept.')).toBeInTheDocument()
    })

    it('toggles local memory setting', () => {
        renderWithServices(<MemorySettingsSection />)

        const switches = screen.getAllByRole('switch')
        fireEvent.click(switches[0]!)

        expect(mockSettingsService.update).toHaveBeenCalledWith({
            localMemoryEnabled: false,
        })
    })

    it('toggles tool-assisted memory setting', () => {
        renderWithServices(<MemorySettingsSection />)

        const switches = screen.getAllByRole('switch')
        fireEvent.click(switches[1]!)

        expect(mockSettingsService.update).toHaveBeenCalledWith({
            toolAssistedMemoryEnabled: true,
        })
    })

    it('clears memory through RPC before showing success', async () => {
        let resolveClear!: () => void
        invoke.mockReturnValueOnce(new Promise<void>((resolve) => { resolveClear = resolve }))
        renderWithServices(<MemorySettingsSection capabilityClient={{ invoke }} />)
        fireEvent.click(screen.getByRole('button', { name: 'Delete' }))

        expect(invoke).toHaveBeenCalledExactlyOnceWith('memories:clear', [])
        expect(screen.getByRole('button', { name: 'Deleting...' })).toBeDisabled()
        expect(mockNotificationService.show).not.toHaveBeenCalled()

        await act(async () => { resolveClear() })
        await waitFor(() => {
            expect(mockNotificationService.show).toHaveBeenCalledWith(expect.objectContaining({ title: 'Local memory database cleared (legacy Markdown backups kept)', type: 'info' }))
        })
        expect(mockNotificationService.show).toHaveBeenCalledTimes(1)
        expect(screen.getByRole('button', { name: 'Delete' })).toBeEnabled()
    })

    it.each(['missing', 'rejected'] as const)('shows only failure when the capability client is %s', async (failure) => {
        if (failure === 'rejected') invoke.mockRejectedValueOnce(new Error('RPC unavailable'))
        renderWithServices(<MemorySettingsSection capabilityClient={failure === 'missing' ? undefined : { invoke }} />)
        fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
        await waitFor(() => {
            expect(mockNotificationService.show).toHaveBeenCalledWith(expect.objectContaining({ title: 'Failed to delete local memory', type: 'error' }))
        })
        expect(mockNotificationService.show).toHaveBeenCalledTimes(1)
        if (failure === 'rejected') expect(invoke).toHaveBeenCalledExactlyOnceWith('memories:clear', [])
        else expect(invoke).not.toHaveBeenCalled()
        expect(screen.getByRole('button', { name: 'Delete' })).toBeEnabled()
    })
})
