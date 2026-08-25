import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { DirectoryBrowserModal } from './DirectoryBrowserModal.js'

describe('DirectoryBrowserModal', () => {
    const mockRuntimeInfo = vi.fn(async () => ({
        homeDir: '/Users/testuser',
        platform: 'darwin',
    }))

    const mockReadDir = vi.fn(async (targetPath: string) => {
        if (targetPath === '/Users/testuser') {
            return [
                { name: 'Documents', isDir: true },
                { name: 'Projects', isDir: true },
                { name: '.hidden-folder', isDir: true },
                { name: 'file.txt', isDir: false },
            ]
        }
        if (targetPath === '/Users/testuser/Projects') {
            return [
                { name: 'Alpha', isDir: true },
                { name: 'Beta', isDir: true },
            ]
        }
        if (targetPath === '/Users') {
            return [
                { name: 'testuser', isDir: true },
                { name: 'shared', isDir: true },
            ]
        }
        if (targetPath === '/') {
            return [
                { name: 'Users', isDir: true },
                { name: 'var', isDir: true },
            ]
        }
        return []
    })

    it('renders directory contents and allows selecting current folder', async () => {
        const onSelect = vi.fn()
        const onClose = vi.fn()

        render(
            <DirectoryBrowserModal
                isOpen={true}
                onClose={onClose}
                onSelect={onSelect}
                readDir={mockReadDir}
                runtimeInfo={mockRuntimeInfo}
            />,
        )

        expect(await screen.findByText('Documents')).toBeInTheDocument()
        expect(screen.getByText('Projects')).toBeInTheDocument()
        expect(screen.queryByText('file.txt')).not.toBeInTheDocument()
        expect(screen.queryByText('.hidden-folder')).not.toBeInTheDocument()

        const selectBtn = screen.getByRole('button', { name: /selectThisDirectory|Select this directory/i })
        fireEvent.click(selectBtn)
        expect(onSelect).toHaveBeenCalledWith({
            name: 'testuser',
            path: '/Users/testuser',
        })
        expect(onClose).toHaveBeenCalled()
    })

    it('allows single-clicking a subfolder to select it', async () => {
        const onSelect = vi.fn()
        const onClose = vi.fn()

        render(
            <DirectoryBrowserModal
                isOpen={true}
                onClose={onClose}
                onSelect={onSelect}
                readDir={mockReadDir}
                runtimeInfo={mockRuntimeInfo}
            />,
        )

        expect(await screen.findByText('Projects')).toBeInTheDocument()
        fireEvent.click(screen.getByText('Projects'))

        const selectBtn = screen.getByRole('button', { name: /selectThisDirectory|Select this directory/i })
        fireEvent.click(selectBtn)
        expect(onSelect).toHaveBeenCalledWith({
            name: 'Projects',
            path: '/Users/testuser/Projects',
        })
    })

    it('allows double-clicking a subfolder to enter into it', async () => {
        const onSelect = vi.fn()
        const onClose = vi.fn()

        render(
            <DirectoryBrowserModal
                isOpen={true}
                onClose={onClose}
                onSelect={onSelect}
                readDir={mockReadDir}
                runtimeInfo={mockRuntimeInfo}
            />,
        )

        const projectsFolder = await screen.findByText('Projects')
        fireEvent.doubleClick(projectsFolder)

        expect(await screen.findByText('Alpha')).toBeInTheDocument()
        expect(screen.getByText('Beta')).toBeInTheDocument()

        const upBtn = screen.getByRole('button', { name: /up|Up/i })
        fireEvent.click(upBtn)
        expect(await screen.findByText('Documents')).toBeInTheDocument()
    })

    it('allows creating a new folder', async () => {
        const mockMkdirAll = vi.fn(async () => {})

        render(
            <DirectoryBrowserModal
                isOpen={true}
                onClose={vi.fn()}
                onSelect={vi.fn()}
                readDir={mockReadDir}
                runtimeInfo={mockRuntimeInfo}
                mkdirAll={mockMkdirAll}
            />,
        )

        expect(await screen.findByText('Documents')).toBeInTheDocument()

        const newFolderBtn = screen.getByRole('button', { name: /newFolder|New folder/i })
        fireEvent.click(newFolderBtn)
        const nameInput = screen.getByPlaceholderText(/folderName|Folder name/i)
        fireEvent.change(nameInput, { target: { value: 'NewProject' } })
        const createBtn = screen.getByRole('button', { name: /create|Create/i })
        fireEvent.click(createBtn)

        await waitFor(() => {
            expect(mockMkdirAll).toHaveBeenCalledWith('/Users/testuser/NewProject')
        })
    })
})
