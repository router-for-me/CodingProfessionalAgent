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
            getRuntimeInfo: vi.fn().mockResolvedValue({ homeDir: '/test/home', appConfigDirName: '.cpa-test' }),
            stat: vi.fn().mockImplementation(async (path: string) => ({ isDir: !path.endsWith('.md'), mode: 0 })),
            mkdirAll: vi.fn(),
            removeFile: vi.fn(),
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

    it('actually deletes memory through host services before showing success', async () => {
        vi.mocked(mockFileSystemService.readDir!).mockResolvedValueOnce([
            { name: 'MEMORY.md', isDirectory: false, isFile: true, path: '' },
        ])
        renderWithServices(<MemorySettingsSection backendOptions={{ bridge: undefined }} />)
        fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
        await waitFor(() => {
            expect(mockNotificationService.show).toHaveBeenCalledWith(expect.objectContaining({ title: 'Local memory deleted', type: 'info' }))
        })
        expect(mockFileSystemService.removeFile).toHaveBeenCalledWith('/test/home/.cpa-test/memories/MEMORY.md')
        expect(mockFileSystemService.readDir).toHaveBeenCalledTimes(2)
    })

    it.each(['missing', 'rejected', 'no-op'] as const)('shows only failure when deletion is %s', async (failure) => {
        vi.mocked(mockFileSystemService.readDir!).mockResolvedValue([
            { name: 'MEMORY.md', isDirectory: false, isFile: true, path: '' },
        ])
        if (failure === 'missing') mockFileSystemService.removeFile = undefined
        if (failure === 'rejected') vi.mocked(mockFileSystemService.removeFile!).mockRejectedValue(new Error('EACCES'))
        renderWithServices(<MemorySettingsSection />)
        fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
        await waitFor(() => {
            expect(mockNotificationService.show).toHaveBeenCalledWith(expect.objectContaining({ title: 'Failed to delete local memory', type: 'error' }))
        })
        expect(mockNotificationService.show).toHaveBeenCalledTimes(1)
        expect(screen.getByRole('button', { name: 'Delete' })).toBeEnabled()
    })
})
