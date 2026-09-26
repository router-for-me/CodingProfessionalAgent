import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '@/i18n'
import { useProjectStore } from '@/stores/projectStore'
import { useSessionStore } from '@/stores/sessionStore'
import { useUiStore } from '@/stores/uiStore'
import type { Project } from '@/types/models'
import { getHostServices } from '@/application/services/createHostServices'
import { WorkspaceVisibilityProvider } from '@cpa/plugin-ui'
import { ProjectEditDialog } from './ProjectEditDialog'

const { pickProjectDirectoryMock } = vi.hoisted(() => ({
    pickProjectDirectoryMock: vi.fn(),
}))

vi.mock('@/lib/projectDirectoryPicker', () => ({
    pickProjectDirectory: pickProjectDirectoryMock,
}))

const project: Project = {
    id: 'project-1',
    name: 'Example Project',
    path: '/workspace/example',
    pinned: false,
    createdAt: 1,
    updatedAt: 2,
}

beforeEach(async () => {
    getHostServices()
    await i18n.changeLanguage('en')
    pickProjectDirectoryMock.mockReset()
    useProjectStore.setState({ projects: [{ ...project }] })
    useSessionStore.setState({
        currentSessionId: 'session-1',
        sessions: [
            {
                id: 'session-1',
                projectId: project.id,
                title: 'Project Task',
                pinned: false,
                createdAt: 1,
                updatedAt: 2,
            },
        ],
    })
    useUiStore.setState({ toasts: [] })
})

describe('ProjectEditDialog', () => {
    it('saves a renamed project with multiple source folders', async () => {
        const user = userEvent.setup()
        const onClose = vi.fn()
        pickProjectDirectoryMock
            .mockResolvedValueOnce({
                name: 'new-source',
                path: '/workspace/new-source',
            })
            .mockResolvedValueOnce({
                name: 'shared-source',
                path: '/workspace/shared-source',
            })
        render(
            <ProjectEditDialog
                project={project}
                onClose={onClose}
                directoryPicker={pickProjectDirectoryMock}
            />,
        )

        const nameInput = screen.getByRole('textbox', { name: 'Project name' })
        await user.clear(nameInput)
        await user.type(nameInput, 'New Project Name')
        await user.click(screen.getByRole('button', { name: 'Add folder' }))
        expect(await screen.findByText('new-source')).toBeInTheDocument()
        await user.click(screen.getByRole('button', { name: 'Add folder' }))

        expect(pickProjectDirectoryMock).toHaveBeenCalledTimes(2)
        expect(pickProjectDirectoryMock).toHaveBeenLastCalledWith(
            'Select project directory',
        )
        expect(await screen.findByText('shared-source')).toBeInTheDocument()

        await user.click(screen.getByRole('button', { name: 'Save' }))

        expect(useProjectStore.getState().projects[0]).toMatchObject({
            name: 'New Project Name',
            path: '/workspace/example',
            paths: [
                '/workspace/example',
                '/workspace/new-source',
                '/workspace/shared-source',
            ],
        })
        expect(onClose).toHaveBeenCalledOnce()
    })

    it('discards name and path changes when cancelled', async () => {
        const user = userEvent.setup()
        const onClose = vi.fn()
        render(<ProjectEditDialog project={project} onClose={onClose} />)

        const nameInput = screen.getByRole('textbox', { name: 'Project name' })
        await user.clear(nameInput)
        await user.type(nameInput, 'Unsaved Name')
        await user.click(
            screen.getByRole('button', {
                name: 'Remove source folder /workspace/example',
            }),
        )
        await user.click(screen.getByRole('button', { name: 'Cancel' }))

        expect(useProjectStore.getState().projects[0]).toEqual(project)
        expect(onClose).toHaveBeenCalledOnce()
    })

    it('removes the project and keeps its chats uncategorized', async () => {
        const user = userEvent.setup()
        const onClose = vi.fn()
        render(<ProjectEditDialog project={project} onClose={onClose} />)

        await user.click(screen.getByRole('button', { name: 'Remove project' }))

        expect(useProjectStore.getState().projects).toEqual([])
        expect(useSessionStore.getState().sessions[0]?.projectId).toBeUndefined()
        expect(onClose).toHaveBeenCalledOnce()
    })

    it('preserves an open directory browser draft while settings is visible', async () => {
        Object.defineProperty(navigator, 'userAgent', {
            value: 'Mozilla/5.0 Chrome/120.0.0.0 Safari/537.36',
            configurable: true,
        })
        const user = userEvent.setup()
        const renderWorkspace = (visible: boolean) => (
            <WorkspaceVisibilityProvider visible={visible}>
                <ProjectEditDialog project={project} onClose={() => undefined} />
            </WorkspaceVisibilityProvider>
        )
        const { rerender } = render(renderWorkspace(true))
        await user.click(screen.getByRole('button', { name: 'Add folder' }))
        await user.click(await screen.findByRole('button', { name: /New folder/i }))
        const folderName = screen.getByPlaceholderText(/Folder name/i)
        await user.type(folderName, 'Unsent folder')

        rerender(renderWorkspace(false))
        expect(screen.queryByTestId('directory-browser-modal')).not.toBeInTheDocument()
        expect(screen.getByRole('dialog', { hidden: true, name: 'Edit project' })).not.toBeVisible()

        rerender(renderWorkspace(true))
        expect(screen.getByPlaceholderText(/Folder name/i)).toHaveValue('Unsent folder')
    })

    it('opens DirectoryBrowserModal in browser environment when adding folder', async () => {
        Object.defineProperty(navigator, 'userAgent', {
            value: 'Mozilla/5.0 Chrome/120.0.0.0 Safari/537.36',
            configurable: true,
        })

        const user = userEvent.setup()
        const onClose = vi.fn()

        render(<ProjectEditDialog project={project} onClose={onClose} />)

        await user.click(screen.getByRole('button', { name: 'Add folder' }))

        expect(await screen.findByTestId('directory-browser-modal')).toBeInTheDocument()
    })
})
