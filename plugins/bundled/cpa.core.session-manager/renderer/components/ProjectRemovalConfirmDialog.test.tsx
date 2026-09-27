import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '@/i18n'
import { getHostServices } from '@/application/services/createHostServices'
import { useUiStore } from '@/stores/uiStore'
import type { Project } from '@cpa/plugin-api'
import { ProjectRemovalConfirmDialog } from './ProjectRemovalConfirmDialog'

const project: Project = {
    id: 'project-1',
    name: 'Example Project',
    pinned: false,
    createdAt: 1,
    updatedAt: 2,
}

beforeEach(async () => {
    getHostServices()
    await i18n.changeLanguage('en')
    useUiStore.setState({ toasts: [] })
})

describe('ProjectRemovalConfirmDialog', () => {
    it('disables dismissal and repeated confirmation while removal is in progress', async () => {
        const user = userEvent.setup()
        let resolveRemoval: () => void = () => undefined
        const onConfirm = vi.fn(() => new Promise<void>((resolve) => {
            resolveRemoval = resolve
        }))
        const onCancel = vi.fn()
        render(<ProjectRemovalConfirmDialog project={project} onCancel={onCancel} onConfirm={onConfirm} />)

        const dialog = screen.getByRole('alertdialog', { name: 'Remove Example Project?' })
        await user.click(within(dialog).getByRole('button', { name: 'Remove project' }))
        expect(onConfirm).toHaveBeenCalledOnce()
        expect(within(dialog).getByRole('button', { name: 'Remove project' })).toBeDisabled()
        expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeDisabled()
        await user.keyboard('{Escape}')
        expect(onCancel).not.toHaveBeenCalled()

        await act(async () => resolveRemoval())
        expect(onConfirm).toHaveBeenCalledOnce()
    })

    it('keeps the confirmation open and allows retry after a removal failure', async () => {
        const user = userEvent.setup()
        const onConfirm = vi.fn()
            .mockRejectedValueOnce(new Error('failed'))
            .mockResolvedValueOnce(undefined)
        const onCancel = vi.fn()
        render(<ProjectRemovalConfirmDialog project={project} onCancel={onCancel} onConfirm={onConfirm} />)

        const dialog = screen.getByRole('alertdialog', { name: 'Remove Example Project?' })
        await user.click(within(dialog).getByRole('button', { name: 'Remove project' }))

        await waitFor(() => {
            expect(useUiStore.getState().toasts[0]?.message).toBe('Could not remove the project. Please try again.')
        })
        expect(screen.getByRole('alertdialog')).toBeInTheDocument()
        expect(within(dialog).getByRole('button', { name: 'Remove project' })).toBeEnabled()
        await user.click(within(dialog).getByRole('button', { name: 'Remove project' }))
        expect(onConfirm).toHaveBeenCalledTimes(2)
    })
})
