import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { HostServicesProvider } from '@cpa/plugin-ui'
import { FileManagerPanelContent } from './FileManagerPanelContent.js'

describe('FileManagerPanelContent', () => {
    const mockProject = {
        id: 'proj-1',
        name: 'MyProject',
        path: '/workspace/MyProject',
    }

    let mockServices: any

    beforeEach(() => {
        mockServices = {
            projects: {
                getSnapshot: () => [mockProject],
            },
            sessions: {
                getSnapshot: () => [],
            },
            ui: {
                getPendingSessionContext: () => ({ projectId: 'proj-1' }),
                getSnapshot: () => ({ rightPanelTabParams: {} }),
                openRightPanelTab: vi.fn(),
                pushToast: vi.fn(),
                writeClipboard: vi.fn(),
            },
            fileSystem: {
                readDir: vi.fn(async (dirPath: string) => {
                    if (dirPath === '/workspace/MyProject') {
                        return [
                            { name: 'src', isDirectory: true, isFile: false, path: '/workspace/MyProject/src' },
                            { name: 'README.md', isDirectory: false, isFile: true, path: '/workspace/MyProject/README.md' },
                            { name: 'config.yaml', isDirectory: false, isFile: true, path: '/workspace/MyProject/config.yaml' },
                        ]
                    }
                    if (dirPath === '/workspace/MyProject/src') {
                        return [
                            { name: 'main.ts', isDirectory: false, isFile: true, path: '/workspace/MyProject/src/main.ts' },
                        ]
                    }
                    return []
                }),
                readFile: vi.fn(async (filePath: string) => {
                    if (filePath.endsWith('README.md')) {
                        return { dataBase64: btoa('# My Project\nWelcome to CPA!\n') }
                    }
                    if (filePath.endsWith('config.yaml')) {
                        return { dataBase64: btoa('port: 8080\nhost: localhost\n') }
                    }
                    if (filePath.endsWith('main.ts')) {
                        return { dataBase64: btoa('export const hello = "world"\n') }
                    }
                    return { dataBase64: btoa('sample content\n') }
                }),
                revealInFileManager: vi.fn(),
            },
        }
    })

    it('renders empty state when no project is selected', () => {
        mockServices.projects.getSnapshot = () => []
        mockServices.ui.getPendingSessionContext = () => ({ projectId: null })

        render(
            <HostServicesProvider services={mockServices}>
                <FileManagerPanelContent />
            </HostServicesProvider>,
        )

        const view = screen.getByTestId('right-sidebar-files-view')
        expect(view.textContent).toMatch(/noProject|No project selected/i)
    })

    it('renders breadcrumbs, file tree, and code viewer', async () => {
        render(
            <HostServicesProvider services={mockServices}>
                <FileManagerPanelContent />
            </HostServicesProvider>,
        )

        expect(screen.getByText('MyProject')).toBeInTheDocument()

        await waitFor(() => {
            expect(screen.getByText('README.md')).toBeInTheDocument()
            expect(screen.getByText('config.yaml')).toBeInTheDocument()
            expect(screen.getByText('src')).toBeInTheDocument()
        })
    })

    it('toggles file tree sidebar visibility', async () => {
        render(
            <HostServicesProvider services={mockServices}>
                <FileManagerPanelContent />
            </HostServicesProvider>,
        )

        const toggleBtn = screen.getByTestId('toggle-file-tree-btn')
        expect(screen.getByTestId('file-tree-container')).toBeInTheDocument()

        fireEvent.click(toggleBtn)
        expect(screen.queryByTestId('file-tree-container')).not.toBeInTheDocument()

        fireEvent.click(toggleBtn)
        expect(screen.getByTestId('file-tree-container')).toBeInTheDocument()
    })

    it('opens and reads file when clicked in the tree', async () => {
        render(
            <HostServicesProvider services={mockServices}>
                <FileManagerPanelContent />
            </HostServicesProvider>,
        )

        const fileTree = await screen.findByTestId('file-tree-container')
        await waitFor(() => {
            expect(fileTree.textContent).toContain('config.yaml')
        })

        const configButtons = fileTree.querySelectorAll('button')
        const targetBtn = Array.from(configButtons).find((b) => b.textContent?.includes('config.yaml'))
        expect(targetBtn).toBeDefined()
        fireEvent.click(targetBtn!)

        await waitFor(() => {
            expect(screen.getByText('port:')).toBeInTheDocument()
            expect(screen.getByText('8080')).toBeInTheDocument()
        })
    })

    it('expands directory when clicked and shows child files', async () => {
        render(
            <HostServicesProvider services={mockServices}>
                <FileManagerPanelContent />
            </HostServicesProvider>,
        )

        await waitFor(() => {
            expect(screen.getByText('src')).toBeInTheDocument()
        })

        fireEvent.click(screen.getByText('src'))

        await waitFor(() => {
            expect(screen.getByText('main.ts')).toBeInTheDocument()
        })
    })
})
