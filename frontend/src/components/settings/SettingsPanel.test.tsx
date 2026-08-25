import { createEvent, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import i18n from '@/i18n'
import { rendererRegistry } from '@/plugins/platform/rendererRegistry'
import { rendererPluginRuntime } from '@/plugins/platform/RendererPluginRuntimeHost'
import { useProjectStore } from '@/stores/projectStore'
import { useUiStore } from '@/stores/uiStore'
import { useAppKeyboardShortcuts } from '@/features/shortcuts/useAppKeyboardShortcuts'
import { SettingsPanel } from './SettingsPanel'

beforeEach(async () => {
    await rendererPluginRuntime.activateAll()
    await i18n.changeLanguage('en')
    useUiStore.setState({ settingsOpen: false, settingsSection: undefined, settingsParams: undefined })
})

afterEach(async () => {
    await rendererPluginRuntime.reset()
    rendererRegistry.clear()
})

describe('SettingsPanel keyboard shortcuts', () => {
    it('opens settings with Command+Comma', () => {
        function TestHost() {
            useAppKeyboardShortcuts()
            return <SettingsPanel />
        }
        render(<TestHost />)
        const shortcut = createEvent.keyDown(document, {
            key: ',',
            code: 'Comma',
            metaKey: true,
        })

        fireEvent(document, shortcut)

        expect(shortcut.defaultPrevented).toBe(true)
        expect(useUiStore.getState().settingsOpen).toBe(true)
        expect(
            screen.getByRole('dialog', { name: 'Settings' })
        ).toBeInTheDocument()
    })

    it('closes an open dropdown with Escape before closing settings', async () => {
        const user = userEvent.setup()
        useUiStore.setState({ settingsOpen: true })
        render(<SettingsPanel />)

        await user.click(screen.getByRole('combobox', { name: 'Language' }))
        expect(screen.getByRole('listbox', { name: 'Language' })).toBeInTheDocument()

        await user.keyboard('{Escape}')
        expect(screen.queryByRole('listbox')).toBeNull()
        expect(screen.getByRole('dialog', { name: 'Settings' })).toBeInTheDocument()

        await user.keyboard('{Escape}')
        expect(screen.queryByRole('dialog', { name: 'Settings' })).toBeNull()
    })

    it('renders the editor section inside general settings', () => {
        useUiStore.setState({ settingsOpen: true })
        render(<SettingsPanel />)

        expect(
            screen.getByRole('heading', { level: 1, name: 'General' })
        ).toBeInTheDocument()
        expect(
            screen.getByRole('heading', { level: 3, name: 'Editor' })
        ).toBeInTheDocument()
        expect(
            screen.queryByText('Plain text editor')
        ).toBeNull()
        expect(
            screen.getByText('Show context window usage')
        ).toBeInTheDocument()
        expect(
            screen.getByText('Send shortcut')
        ).toBeInTheDocument()
        expect(
            screen.getByText('Follow-up handling')
        ).toBeInTheDocument()
    })

    it('opens the hooks section from settings navigation', () => {
        useUiStore.setState({ settingsOpen: true })
        render(<SettingsPanel />)

        fireEvent.click(
            screen.getByRole('button', { name: 'Hooks' })
        )

        expect(
            screen.getByRole('heading', { level: 1, name: 'Hooks' })
        ).toBeInTheDocument()
        expect(
            screen.getByText('From configuration')
        ).toBeInTheDocument()
        expect(
            screen.getByText('User configuration')
        ).toBeInTheDocument()
    })

    it('opens the models section from settings navigation', () => {
        useUiStore.setState({ settingsOpen: true })
        render(<SettingsPanel />)

        fireEvent.click(
            screen.getByRole('button', { name: 'Models' })
        )

        expect(
            screen.getByRole('heading', { level: 1, name: 'Models' })
        ).toBeInTheDocument()
        expect(
            screen.getByText('Enable all models and reasoning efforts')
        ).toBeInTheDocument()
    })

    it('renders subagents menu item directly after models and opens subagents settings page', () => {
        useUiStore.setState({ settingsOpen: true })
        render(<SettingsPanel />)

        const allButtons = screen.getAllByRole('button')
        const modelsIndex = allButtons.findIndex((b) => b.textContent?.includes('Models'))
        const subagentsIndex = allButtons.findIndex((b) => b.textContent?.includes('Subagents'))

        expect(modelsIndex).toBeGreaterThan(-1)
        expect(subagentsIndex).toBe(modelsIndex + 1)

        fireEvent.click(allButtons[subagentsIndex])

        expect(
            screen.getByRole('heading', { level: 1, name: 'Subagents' })
        ).toBeInTheDocument()

        const toggleBtn = screen.getByRole('switch', { name: 'Subagents' })
        expect(toggleBtn).toBeInTheDocument()

        const concurrencyInput = screen.getByRole('spinbutton', { name: 'Global Concurrent Subagents' })
        const maxPerSessionInput = screen.getByRole('spinbutton', { name: 'Maximum Concurrent Subagents per Session' })
        const maxDepthInput = screen.getByRole('spinbutton', { name: 'Maximum Subagent Depth' })
        expect(concurrencyInput).toBeInTheDocument()
        expect(maxPerSessionInput).toBeInTheDocument()
        expect(maxDepthInput).toBeInTheDocument()

        // When toggle is turned off, child inputs must be hidden
        fireEvent.click(toggleBtn)
        expect(screen.queryByRole('spinbutton', { name: 'Global Concurrent Subagents' })).toBeNull()
        expect(screen.queryByRole('spinbutton', { name: 'Maximum Concurrent Subagents per Session' })).toBeNull()
        expect(screen.queryByRole('spinbutton', { name: 'Maximum Subagent Depth' })).toBeNull()

        // When toggle is turned back on, child inputs must re-appear
        fireEvent.click(toggleBtn)
        expect(screen.getByRole('spinbutton', { name: 'Global Concurrent Subagents' })).toBeInTheDocument()
        expect(screen.getByRole('spinbutton', { name: 'Maximum Concurrent Subagents per Session' })).toBeInTheDocument()
        expect(screen.getByRole('spinbutton', { name: 'Maximum Subagent Depth' })).toBeInTheDocument()
    })

    it('opens the usage section from settings navigation', () => {
        useUiStore.setState({ settingsOpen: true })
        render(<SettingsPanel />)

        fireEvent.click(
            screen.getByRole('button', { name: 'Usage & billing' })
        )

        expect(
            screen.getByRole('heading', { level: 1, name: 'Usage & billing' })
        ).toBeInTheDocument()
        expect(
            screen.getByText('Total Tokens')
        ).toBeInTheDocument()
        expect(
            screen.getByText('Token Activity')
        ).toBeInTheDocument()
    })

    it('opens the archived chats section from settings navigation', () => {
        useUiStore.setState({ settingsOpen: true })
        render(<SettingsPanel />)

        fireEvent.click(
            screen.getByRole('button', { name: 'Archived chats' })
        )

        expect(
            screen.getByRole('heading', { name: 'Archived chats' })
        ).toBeInTheDocument()
        expect(
            screen.getByRole('searchbox', { name: 'Search archived chats' })
        ).toBeInTheDocument()
    })

    it('opens the personalization section from settings navigation', () => {
        useUiStore.setState({ settingsOpen: true })
        render(<SettingsPanel />)

        fireEvent.click(
            screen.getByRole('button', { name: 'Personalization' })
        )

        expect(
            screen.getByRole('heading', { level: 1, name: 'Personalization' })
        ).toBeInTheDocument()
        expect(
            screen.getByRole('heading', { level: 2, name: 'Custom Instructions' })
        ).toBeInTheDocument()
        expect(
            screen.getByRole('heading', { level: 2, name: 'Memory' })
        ).toBeInTheDocument()
    })

    it('opens the shortcuts section from settings navigation', () => {
        useUiStore.setState({ settingsOpen: true })
        render(<SettingsPanel />)

        fireEvent.click(
            screen.getByRole('button', { name: 'Keyboard shortcuts' })
        )

        expect(
            screen.getByRole('heading', { level: 1, name: 'Keyboard shortcuts' })
        ).toBeInTheDocument()
        expect(
            screen.getByRole('searchbox', { name: 'Search shortcuts' })
        ).toBeInTheDocument()
        expect(
            screen.getByText('New chat')
        ).toBeInTheDocument()
    })

    it('opens the environments section from settings navigation', () => {
        useProjectStore.setState({
            projects: [
                {
                    id: 'p-1',
                    name: 'EasyCLIProxyAPI',
                    path: '/tmp/EasyCLIProxyAPI',
                    pinned: false,
                    createdAt: 1,
                    updatedAt: 1,
                },
            ],
        })
        useUiStore.setState({ settingsOpen: true })
        render(<SettingsPanel />)

        fireEvent.click(
            screen.getByRole('button', { name: 'Environments' })
        )

        expect(
            screen.getByRole('heading', { level: 1, name: 'Environments' })
        ).toBeInTheDocument()
        expect(
            screen.getByText('EasyCLIProxyAPI')
        ).toBeInTheDocument()
        expect(
            screen.getByText('/tmp/EasyCLIProxyAPI')
        ).toBeInTheDocument()
    })

    it('renders dynamically registered settings section component when active', () => {
        // Override general
        rendererRegistry.registerSettingsSection({
            id: 'general',
            labelKey: 'settings.nav.general',
            order: 2,
            component: () => (
                <div data-testid="custom-general-override">
                    Overridden General Content
                </div>
            ),
        })

        useUiStore.setState({ settingsOpen: true })
        render(<SettingsPanel />)

        expect(
            screen.getByTestId('custom-general-override')
        ).toBeInTheDocument()
        expect(
            screen.getByText('Overridden General Content')
        ).toBeInTheDocument()
    })

    it('displays and navigates to dynamic settings sections outside hardcoded groups', () => {
        rendererRegistry.registerSettingsSection({
            id: 'custom-plugin-section',
            labelKey: 'Custom Plugin Settings',
            order: 50,
            component: () => (
                <div data-testid="custom-plugin-panel">
                    Custom Plugin Panel Content
                </div>
            ),
        })

        useUiStore.setState({ settingsOpen: true })
        render(<SettingsPanel />)

        expect(screen.getByText('Extensions')).toBeInTheDocument()
        const dynamicNavButton = screen.getByRole('button', {
            name: 'Custom Plugin Settings',
        })
        expect(dynamicNavButton).toBeInTheDocument()

        fireEvent.click(dynamicNavButton)

        expect(
            screen.getByTestId('custom-plugin-panel')
        ).toBeInTheDocument()
    })

    it('keeps navigation fully interactive and switches sections without freeze when opened with target section', () => {
        // Open settings with target section 'hooks' and params
        useUiStore.getState().setSettingsOpen(true, 'hooks', { testParam: 'val' })
        const { unmount } = render(<SettingsPanel />)

        expect(screen.getByRole('heading', { level: 1, name: 'Hooks' })).toBeInTheDocument()

        // Click 'Models' in the left menu
        fireEvent.click(screen.getByRole('button', { name: 'Models' }))

        // Must switch to 'Models' immediately, without freezing on 'Hooks'
        expect(screen.getByRole('heading', { level: 1, name: 'Models' })).toBeInTheDocument()
        expect(useUiStore.getState().settingsSection).toBe('models')
        expect(useUiStore.getState().settingsParams).toBeUndefined()

        // Close settings
        useUiStore.getState().setSettingsOpen(false)
        expect(useUiStore.getState().settingsOpen).toBe(false)
        expect(useUiStore.getState().settingsSection).toBeUndefined()
        expect(useUiStore.getState().settingsParams).toBeUndefined()
        unmount()

        // Re-open settings - should start cleanly and be interactive
        useUiStore.getState().setSettingsOpen(true)
        render(<SettingsPanel />)

        // Click 'Git' in the left menu
        fireEvent.click(screen.getByRole('button', { name: 'Git' }))
        expect(screen.getByRole('heading', { level: 1, name: 'Git' })).toBeInTheDocument()
    })

    it('matches the main session sidebar width and remains non-resizable', () => {
        useUiStore.setState({ settingsOpen: true, sidebarWidth: 340 })
        render(<SettingsPanel />)

        const dialog = screen.getByRole('dialog', { name: 'Settings' })
        const aside = dialog.querySelector('aside')
        expect(aside).not.toBeNull()
        expect(aside).toHaveStyle({ width: '340px' })

        // Ensure there is no resize handle inside settings
        expect(screen.queryByRole('separator')).toBeNull()
    })

    it('searches sub-items and displays them underneath the section header', async () => {
        useUiStore.setState({ settingsOpen: true })
        render(<SettingsPanel />)

        const searchInput = screen.getByPlaceholderText('Search settings...')
        fireEvent.change(searchInput, { target: { value: 'Language' } })

        // "General" section and its sub-item "Language" must be visible
        expect(screen.getByRole('button', { name: 'General' })).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Language' })).toBeInTheDocument()

        // Clicking sub-item "Language" navigates to the section
        fireEvent.click(screen.getByRole('button', { name: 'Language' }))
        expect(useUiStore.getState().settingsSection).toBe('general')
    })

    it('supports searching by keywords and aliases (e.g. "locale" and "Language")', async () => {
        useUiStore.setState({ settingsOpen: true })
        const { unmount } = render(<SettingsPanel />)

        const searchInput1 = screen.getByPlaceholderText('Search settings...')
        fireEvent.change(searchInput1, { target: { value: 'locale' } })

        expect(screen.getByRole('button', { name: 'General' })).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Language' })).toBeInTheDocument()
        unmount()

        render(<SettingsPanel />)
        const searchInput2 = screen.getByPlaceholderText('Search settings...')
        fireEvent.change(searchInput2, { target: { value: 'Language' } })

        expect(screen.getByRole('button', { name: 'General' })).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Language' })).toBeInTheDocument()
    })

    it('clears search query and restores grouped navigation when clicking clear button', () => {
        useUiStore.setState({ settingsOpen: true })
        render(<SettingsPanel />)

        const searchInput = screen.getByPlaceholderText('Search settings...')
        fireEvent.change(searchInput, { target: { value: 'Language' } })

        // Clear button should be present
        const clearBtn = screen.getByRole('button', { name: 'Clear' })
        expect(clearBtn).toBeInTheDocument()

        fireEvent.click(clearBtn)

        expect((searchInput as HTMLInputElement).value).toBe('')
        // Standard group header should be restored
        expect(screen.getByText('Personal')).toBeInTheDocument()
    })
})
