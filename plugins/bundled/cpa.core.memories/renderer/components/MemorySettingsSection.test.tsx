import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { HostServicesProvider } from '@cpa/plugin-ui'
import type { HostServices, SettingsService, NotificationService, FileSystemService } from '@cpa/plugin-api'
import { MemorySettingsSection } from './MemorySettingsSection.js'

describe('MemorySettingsSection', () => {
    let mockSettings: any
    let mockSettingsService: SettingsService
    let mockNotificationService: NotificationService
    let mockFileSystemService: FileSystemService
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

        mockFileSystemService = {
            readFile: vi.fn(),
            writeFile: vi.fn(),
            readDir: vi.fn().mockResolvedValue([]),
        } as unknown as FileSystemService
    })

    function renderWithServices(ui: React.ReactElement) {
        const services = {
            settings: mockSettingsService,
            notifications: mockNotificationService,
            fileSystem: mockFileSystemService,
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

    it('deletes memory and shows toast notification', async () => {
        renderWithServices(<MemorySettingsSection />)

        const deleteButton = screen.getByRole('button', { name: 'Delete' })
        fireEvent.click(deleteButton)

        await waitFor(() => {
            expect(mockNotificationService.show).toHaveBeenCalled()
        })
    })
})
