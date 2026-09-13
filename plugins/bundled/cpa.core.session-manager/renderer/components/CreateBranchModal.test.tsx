import i18n from '@/i18n'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CreateBranchModal } from './CreateBranchModal.js'

describe('CreateBranchModal', () => {
    beforeEach(async () => {
        await i18n.changeLanguage('zh-CN')
        vi.resetAllMocks()
    })

    it('does not render when isOpen is false', () => {
        render(
            <CreateBranchModal
                isOpen={false}
                onClose={() => {}}
                onConfirm={() => {}}
            />,
        )
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })

    it('renders modal with correct title and elements when open', () => {
        render(
            <CreateBranchModal
                isOpen={true}
                onClose={() => {}}
                onConfirm={() => {}}
                existingBranches={['main', 'dev']}
            />,
        )
        expect(screen.getByRole('dialog')).toBeInTheDocument()
        expect(screen.getByText('创建并检出分支')).toBeInTheDocument()
        expect(screen.getByText('分支名称')).toBeInTheDocument()
        expect(screen.getByRole('button', { name: '创建并检出' })).toBeDisabled()
        expect(screen.getByRole('button', { name: '关闭' })).toBeEnabled()
    })

    it('shows error when branch ends with slash', async () => {
        const user = userEvent.setup()
        render(
            <CreateBranchModal
                isOpen={true}
                onClose={() => {}}
                onConfirm={() => {}}
                existingBranches={['main', 'dev']}
            />,
        )
        const input = screen.getByPlaceholderText(/输入新分支名称/i)
        const submitBtn = screen.getByRole('button', { name: '创建并检出' })

        await user.type(input, 'feature/foo/')
        expect(screen.getByText('分支名不能以“/”结尾。')).toBeInTheDocument()
        expect(submitBtn).toBeDisabled()

        // Remove trailing slash
        await user.type(input, 'bar')
        expect(screen.queryByText('分支名不能以“/”结尾。')).not.toBeInTheDocument()
        expect(submitBtn).toBeEnabled()
    })

    it('shows error when branch already exists', async () => {
        const user = userEvent.setup()
        render(
            <CreateBranchModal
                isOpen={true}
                onClose={() => {}}
                onConfirm={() => {}}
                existingBranches={['main', 'dev']}
            />,
        )
        const input = screen.getByPlaceholderText(/输入新分支名称/i)
        const submitBtn = screen.getByRole('button', { name: '创建并检出' })

        await user.type(input, 'main')
        expect(screen.getByText('该分支已存在')).toBeInTheDocument()
        expect(submitBtn).toBeDisabled()
    })

    it('shows error when branch name has invalid characters', async () => {
        const user = userEvent.setup()
        render(
            <CreateBranchModal
                isOpen={true}
                onClose={() => {}}
                onConfirm={() => {}}
                existingBranches={['main', 'dev']}
            />,
        )
        const input = screen.getByPlaceholderText(/输入新分支名称/i)
        const submitBtn = screen.getByRole('button', { name: '创建并检出' })

        await user.type(input, 'bad branch name')
        expect(screen.getByText('无效的分支名')).toBeInTheDocument()
        expect(submitBtn).toBeDisabled()
    })

    it('submits on Enter key when valid', async () => {
        const user = userEvent.setup()
        const onConfirm = vi.fn()
        render(
            <CreateBranchModal
                isOpen={true}
                onClose={() => {}}
                onConfirm={onConfirm}
                existingBranches={['main', 'dev']}
            />,
        )
        const input = screen.getByPlaceholderText(/输入新分支名称/i)

        await user.type(input, 'feat/awesome-idea{Enter}')
        expect(onConfirm).toHaveBeenCalledWith('feat/awesome-idea')
    })

    it('does not submit on Enter key when invalid', async () => {
        const user = userEvent.setup()
        const onConfirm = vi.fn()
        render(
            <CreateBranchModal
                isOpen={true}
                onClose={() => {}}
                onConfirm={onConfirm}
                existingBranches={['main', 'dev']}
            />,
        )
        const input = screen.getByPlaceholderText(/输入新分支名称/i)

        await user.type(input, 'feat/invalid/{Enter}')
        expect(onConfirm).not.toHaveBeenCalled()
    })

    it('closes on Escape key press', async () => {
        const user = userEvent.setup()
        const onClose = vi.fn()
        render(
            <CreateBranchModal
                isOpen={true}
                onClose={onClose}
                onConfirm={() => {}}
            />,
        )

        await user.keyboard('{Escape}')
        expect(onClose).toHaveBeenCalledTimes(1)
    })

    it('prefills branch name with configured branchPrefix from Git settings', async () => {
        const user = userEvent.setup()
        const onConfirm = vi.fn()
        render(
            <CreateBranchModal
                isOpen={true}
                onClose={() => {}}
                onConfirm={onConfirm}
                branchPrefix="codex/"
            />,
        )
        const input = screen.getByPlaceholderText(/输入新分支名称/i) as HTMLInputElement
        const submitBtn = screen.getByRole('button', { name: '创建并检出' })

        // Should be prefilled with "codex/"
        expect(input.value).toBe('codex/')
        // Ending with '/' shows validation error and disables submit
        expect(screen.getByText('分支名不能以“/”结尾。')).toBeInTheDocument()
        expect(submitBtn).toBeDisabled()

        // User types branch name suffix
        await user.type(input, 'quick-fix')
        expect(input.value).toBe('codex/quick-fix')
        expect(screen.queryByText('分支名不能以“/”结尾。')).not.toBeInTheDocument()
        expect(submitBtn).toBeEnabled()

        await user.click(submitBtn)
        expect(onConfirm).toHaveBeenCalledWith('codex/quick-fix')
    })

    it('prepends branchPrefix to initialValue if not already starting with prefix', () => {
        render(
            <CreateBranchModal
                isOpen={true}
                onClose={() => {}}
                onConfirm={() => {}}
                branchPrefix="codex/"
                initialValue="task-123"
            />,
        )
        const input = screen.getByPlaceholderText(/输入新分支名称/i) as HTMLInputElement
        expect(input.value).toBe('codex/task-123')
    })

    it('does not duplicate branchPrefix if initialValue already starts with it', () => {
        render(
            <CreateBranchModal
                isOpen={true}
                onClose={() => {}}
                onConfirm={() => {}}
                branchPrefix="codex/"
                initialValue="codex/task-123"
            />,
        )
        const input = screen.getByPlaceholderText(/输入新分支名称/i) as HTMLInputElement
        expect(input.value).toBe('codex/task-123')
    })
})
