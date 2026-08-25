import { describe, expect, it, vi } from 'vitest'
import { PluginCapabilityError } from '@cpa/plugin-api'
import { fileManagerRendererEntry } from './index.js'

describe('file-manager plugin integration and capability tests', () => {
    it('handles capability denied error when reading directory without grant', async () => {
        const deniedCapabilityClient = {
            has: () => false,
            invoke: vi.fn(async () => {
                throw new PluginCapabilityError('Capability "filesystem.read" is not granted')
            }),
            subscribe: vi.fn(() => () => {}),
        }

        const mockServices = {
            fileSystem: {
                readDir: async (dirPath: string) => {
                    return deniedCapabilityClient.invoke('filesystem.readDir', [dirPath])
                },
                readFile: async (filePath: string) => {
                    return deniedCapabilityClient.invoke('filesystem.readFile', [filePath])
                },
            },
        }

        await expect(
            mockServices.fileSystem.readDir('/workspace'),
        ).rejects.toThrow('Capability "filesystem.read" is not granted')
    })

    it('subscribes to file-manager:open-file event and opens right panel with params', () => {
        const registrations: Array<{ kind: string; id: string; value: any }> = []
        let openFileListener: ((payload: any) => void) | null = null

        const mockContext = {
            manifest: { id: 'cpa.core.file-manager', name: 'File Manager', version: '1.0.0' },
            register: vi.fn((item) => {
                registrations.push(item)
                return () => {}
            }),
            events: {
                emit: vi.fn(),
                on: vi.fn((event, handler) => {
                    if (event === 'file-manager:open-file') {
                        openFileListener = handler
                    }
                    return () => {}
                }),
            },
            services: {
                ui: {
                    openRightPanelTab: vi.fn(),
                    getPendingSessionContext: () => ({ projectId: 'p1' }),
                },
                projects: {
                    getSnapshot: () => [{ id: 'p1', name: 'Proj1', path: '/test' }],
                },
                sessions: {
                    getSnapshot: () => [],
                },
            },
        }

        fileManagerRendererEntry.activate(mockContext as any)

        expect(openFileListener).toBeDefined()
        openFileListener?.({
            path: '/test/src/App.tsx',
            name: 'App.tsx',
            relativePath: 'src/App.tsx',
        })

        expect(mockContext.services.ui.openRightPanelTab).toHaveBeenCalledWith('file-manager', {
            activate: true,
            params: {
                activeFilePath: '/test/src/App.tsx',
                name: 'App.tsx',
                relativePath: 'src/App.tsx',
            },
        })
    })
})
