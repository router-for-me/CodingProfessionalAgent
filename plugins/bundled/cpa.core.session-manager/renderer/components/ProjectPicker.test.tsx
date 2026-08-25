import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '@/i18n'
import { useProjectStore } from '@/stores/projectStore'
import { useUiStore } from '@/stores/uiStore'
import { getHostServices } from '@/application/services/createHostServices'
import { setDefaultHostServices } from '@cpa/plugin-ui'
import { ProjectPicker } from './ProjectPicker'

const originalUserAgent = navigator.userAgent

describe('ProjectPicker', () => {
    beforeEach(async () => {
        getHostServices()
        await i18n.changeLanguage('en')
        useProjectStore.setState({ projects: [] })
        useUiStore.setState({ toasts: [] })
    })

    afterEach(() => {
        Object.defineProperty(navigator, 'userAgent', {
            value: originalUserAgent,
            configurable: true,
        })
    })

    it('adds project via native directoryPicker when custom picker is provided', async () => {
        const user = userEvent.setup()
        const onChange = vi.fn()
        const directoryPicker = vi.fn(async () => ({
            name: 'sample-project',
            path: '/workspace/sample-project',
        }))

        render(
            <ProjectPicker
                value={null}
                onChange={onChange}
                directoryPicker={directoryPicker}
            />,
        )

        await user.click(screen.getByRole('button', { name: /Select project/i }))
        await user.click(screen.getByRole('button', { name: /Add project/i }))

        await waitFor(() => {
            expect(useProjectStore.getState().projects).toHaveLength(1)
        })
        const project = useProjectStore.getState().projects[0]!
        expect(directoryPicker).toHaveBeenCalledWith('Select project directory')
        expect(project).toMatchObject({
            name: 'sample-project',
            path: '/workspace/sample-project',
        })
        expect(onChange).toHaveBeenCalledWith(project.id)
    })

    it('does not add project when directory selection is cancelled', async () => {
        const user = userEvent.setup()
        const onChange = vi.fn()

        render(
            <ProjectPicker
                value={null}
                onChange={onChange}
                directoryPicker={async () => null}
            />,
        )

        await user.click(screen.getByRole('button', { name: /Select project/i }))
        await user.click(screen.getByRole('button', { name: /Add project/i }))

        await waitFor(() => {
            expect(screen.getByRole('button', { name: /Select project/i })).toBeEnabled()
        })
        expect(useProjectStore.getState().projects).toEqual([])
        expect(onChange).not.toHaveBeenCalled()
    })

    it('shows error toast when custom directory picker throws', async () => {
        const user = userEvent.setup()

        render(
            <ProjectPicker
                value={null}
                onChange={() => undefined}
                directoryPicker={async () => {
                    throw new Error('dialog error')
                }}
            />,
        )

        await user.click(screen.getByRole('button', { name: /Select project/i }))
        await user.click(screen.getByRole('button', { name: /Add project/i }))

        await waitFor(() => {
            const toasts = useUiStore.getState().toasts
            expect(toasts[toasts.length - 1]?.message).toBe('Could not select project directory')
        })
    })

    it('opens web DirectoryBrowserModal in browser environment and adds selected directory', async () => {
        Object.defineProperty(navigator, 'userAgent', {
            value: 'Mozilla/5.0 Chrome/120.0.0.0 Safari/537.36',
            configurable: true,
        })

        const mockFileSystem = {
            getRuntimeInfo: vi.fn(async () => ({
                homeDir: '/home/user',
                platform: 'linux',
            })),
            readDir: vi.fn(async () => [
                { name: 'my-web-project', isDirectory: true, isFile: false, isSymlink: false, size: 0, mtime: 0 },
            ]),
        }

        const hostServices = getHostServices()
        setDefaultHostServices({
            ...hostServices,
            fileSystem: {
                ...hostServices.fileSystem,
                ...mockFileSystem,
            },
        } as any)

        const user = userEvent.setup()
        const onChange = vi.fn()

        render(<ProjectPicker value={null} onChange={onChange} />)

        await user.click(screen.getByRole('button', { name: /Select project/i }))
        await user.click(screen.getByRole('button', { name: /Add project/i }))

        // DirectoryBrowserModal should be open in web mode
        expect(await screen.findByRole('dialog')).toBeInTheDocument()
        expect(screen.getByText('my-web-project')).toBeInTheDocument()

        // Select the folder and confirm
        await user.click(screen.getByText('my-web-project'))
        await user.click(screen.getByRole('button', { name: /Select This Directory/i }))

        await waitFor(() => {
            expect(useProjectStore.getState().projects).toHaveLength(1)
        })
        const project = useProjectStore.getState().projects[0]!
        expect(project.name).toBe('my-web-project')
        expect(project.path).toBe('/home/user/my-web-project')
        expect(onChange).toHaveBeenCalledWith(project.id)
    })

    it('opens web DirectoryBrowserModal in browser environment and closes on cancel without adding project', async () => {
        Object.defineProperty(navigator, 'userAgent', {
            value: 'Mozilla/5.0 Chrome/120.0.0.0 Safari/537.36',
            configurable: true,
        })

        const mockFileSystem = {
            getRuntimeInfo: vi.fn(async () => ({
                homeDir: '/home/user',
                platform: 'linux',
            })),
            readDir: vi.fn(async () => [
                { name: 'my-web-project', isDirectory: true, isFile: false, isSymlink: false, size: 0, mtime: 0 },
            ]),
        }

        const hostServices = getHostServices()
        setDefaultHostServices({
            ...hostServices,
            fileSystem: {
                ...hostServices.fileSystem,
                ...mockFileSystem,
            },
        } as any)

        const user = userEvent.setup()
        const onChange = vi.fn()

        render(<ProjectPicker value={null} onChange={onChange} />)

        await user.click(screen.getByRole('button', { name: /Select project/i }))
        await user.click(screen.getByRole('button', { name: /Add project/i }))

        expect(await screen.findByRole('dialog')).toBeInTheDocument()

        await user.click(screen.getByRole('button', { name: /Cancel/i }))

        expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
        expect(useProjectStore.getState().projects).toHaveLength(0)
        expect(onChange).not.toHaveBeenCalled()
    })
})
