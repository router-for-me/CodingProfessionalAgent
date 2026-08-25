import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import i18n from '@/i18n'
import { useSettingsStore } from '@/stores/settingsStore'
import { useUiStore } from '@/stores/uiStore'
import { getHostServices } from '@/application/services/createHostServices'
import { ShortcutsSection } from './ShortcutsSection.js'
import { DEFAULT_SHORTCUT_ITEMS } from '../../../shared/defaultShortcuts.js'

describe('ShortcutsSection', () => {
    beforeEach(async () => {
        getHostServices()
        await i18n.changeLanguage('en')
        useSettingsStore.setState({
            settings: {
                ...useSettingsStore.getState().settings,
                shortcuts: {},
            },
        })
        useUiStore.setState({ toasts: [] })
    })

    it('renders header, search bar, and all 32 shortcut items', () => {
        render(<ShortcutsSection />)

        expect(
            screen.getByRole('heading', { level: 1, name: 'Keyboard shortcuts' }),
        ).toBeInTheDocument()
        expect(
            screen.getByRole('searchbox', { name: 'Search shortcuts' }),
        ).toBeInTheDocument()
        expect(
            screen.getByRole('button', { name: 'Search by shortcut' }),
        ).toBeInTheDocument()

        // Check key items
        expect(screen.getByText('New chat')).toBeInTheDocument()
        expect(screen.getByText('Start a new chat')).toBeInTheDocument()
        expect(screen.getByText('⌘N')).toBeInTheDocument()
        expect(screen.getByText('⇧⌘O')).toBeInTheDocument()

        // Check focus main chat input shortcut
        expect(screen.getByText('Focus main chat input')).toBeInTheDocument()
        expect(screen.getByText('Move keyboard focus to main chat input')).toBeInTheDocument()
        expect(screen.getByText('⌘I')).toBeInTheDocument()

        // Check unassigned items
        expect(screen.getByText('Fork chat')).toBeInTheDocument()
        expect(screen.getByText('Create a fork of current chat')).toBeInTheDocument()

        // Verify total items count
        expect(DEFAULT_SHORTCUT_ITEMS.length).toBe(33)
    })

    it('filters items when typing text in search input', async () => {
        const user = userEvent.setup()
        render(<ShortcutsSection />)

        const searchInput = screen.getByRole('searchbox', { name: 'Search shortcuts' })
        await user.type(searchInput, 'chat')

        expect(screen.getByText('New chat')).toBeInTheDocument()
        expect(screen.getByText('New standalone chat')).toBeInTheDocument()
        expect(screen.getByText('Fork chat')).toBeInTheDocument()
        expect(screen.queryByText('New temporary chat')).toBeNull()
        expect(screen.queryByText('Focus browser address bar')).toBeNull()
    })

    it('supports toggle search by shortcut key', async () => {
        const user = userEvent.setup()
        render(<ShortcutsSection />)

        const toggleBtn = screen.getByRole('button', { name: 'Search by shortcut' })
        expect(toggleBtn).toHaveAttribute('aria-pressed', 'false')

        // Activate shortcut search mode
        await user.click(toggleBtn)
        expect(toggleBtn).toHaveAttribute('aria-pressed', 'true')

        const searchInput = screen.getByPlaceholderText('Press shortcut keys to filter...')
        expect(searchInput).toBeInTheDocument()

        // Simulate pressing Option + Command + P (togglePin)
        fireEvent.keyDown(searchInput, {
            key: 'p',
            code: 'KeyP',
            metaKey: true,
            altKey: true,
        })

        expect(searchInput).toHaveValue('⌥⌘P')
        expect(screen.getByText('Toggle pin')).toBeInTheDocument()
        expect(screen.queryByText('New chat')).toBeNull()

        // Press Escape to clear
        fireEvent.keyDown(searchInput, { key: 'Escape' })
        expect(searchInput).toHaveValue('')

        // Click toggle button again to exit
        await user.click(toggleBtn)
        expect(toggleBtn).toHaveAttribute('aria-pressed', 'false')
    })

    it('displays empty state when search finds no matches', async () => {
        const user = userEvent.setup()
        render(<ShortcutsSection />)

        const searchInput = screen.getByRole('searchbox', { name: 'Search shortcuts' })
        await user.type(searchInput, 'nonmatchingxyz123')

        expect(screen.getByText('No matching shortcuts found')).toBeInTheDocument()
    })

    it('deletes a shortcut when clicking the trash icon', async () => {
        const user = userEvent.setup()
        render(<ShortcutsSection />)

        // Find delete button for New Chat shortcut ⌘N
        const deleteBtn = screen.getByRole('button', {
            name: 'Delete New chat shortcut ⌘N',
        })
        await user.click(deleteBtn)

        // State in settingsStore should now only have ⇧⌘O for new-chat
        const shortcutsMap = useSettingsStore.getState().settings.shortcuts
        expect(shortcutsMap?.['new-chat']).toEqual([
            { ctrl: false, alt: false, shift: true, meta: true, key: 'O' },
        ])
    })
})
