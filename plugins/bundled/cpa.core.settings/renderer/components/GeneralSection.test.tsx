import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import i18n from '@/i18n'
import { DEFAULT_SETTINGS } from '@/types/models'
import { useSettingsStore } from '@/stores/settingsStore'
import { getHostServices } from '@/application/services/createHostServices'
import { GeneralSection } from './GeneralSection.js'

beforeEach(async () => {
    getHostServices()
    await i18n.changeLanguage('en')
    useSettingsStore.setState({
        settings: { ...DEFAULT_SETTINGS, showBottomPanel: true },
    })
})

describe('GeneralSection', () => {
    it('toggles bottom panel setting in store', async () => {
        const user = userEvent.setup()
        render(<GeneralSection />)

        const toggle = screen.getByRole('switch', { name: 'Bottom panel' })
        expect(toggle).toBeInTheDocument()
        expect(toggle).toHaveAttribute('aria-checked', 'true')
        expect(useSettingsStore.getState().settings.showBottomPanel).toBe(true)

        await user.click(toggle)
        expect(toggle).toHaveAttribute('aria-checked', 'false')
        expect(useSettingsStore.getState().settings.showBottomPanel).toBe(false)

        await user.click(toggle)
        expect(toggle).toHaveAttribute('aria-checked', 'true')
        expect(useSettingsStore.getState().settings.showBottomPanel).toBe(true)
    })

    it('shows terminal position selector when showBottomPanel is true and allows switching', async () => {
        const user = userEvent.setup()
        render(<GeneralSection />)

        const terminalPositionRow = screen.getByRole('radiogroup', {
            name: 'Default terminal position',
        })
        expect(terminalPositionRow).toBeInTheDocument()

        const bottomOption = screen.getByRole('radio', { name: 'Bottom' })
        const rightOption = screen.getByRole('radio', { name: 'Right' })

        expect(bottomOption).toHaveAttribute('aria-checked', 'true')
        expect(rightOption).toHaveAttribute('aria-checked', 'false')
        expect(useSettingsStore.getState().settings.terminalPosition).toBe('bottom')

        await user.click(rightOption)
        expect(useSettingsStore.getState().settings.terminalPosition).toBe('right')
        expect(rightOption).toHaveAttribute('aria-checked', 'true')
        expect(bottomOption).toHaveAttribute('aria-checked', 'false')

        await user.click(bottomOption)
        expect(useSettingsStore.getState().settings.terminalPosition).toBe('bottom')
    })

    it('hides terminal position selector when showBottomPanel is false', () => {
        useSettingsStore.setState({
            settings: { ...DEFAULT_SETTINGS, showBottomPanel: false },
        })
        render(<GeneralSection />)

        expect(
            screen.queryByRole('radiogroup', { name: 'Default terminal position' }),
        ).not.toBeInTheDocument()
    })

    it('dynamically hides and shows terminal position when bottom panel toggle is clicked', async () => {
        const user = userEvent.setup()
        render(<GeneralSection />)

        expect(
            screen.getByRole('radiogroup', { name: 'Default terminal position' }),
        ).toBeInTheDocument()

        const toggle = screen.getByRole('switch', { name: 'Bottom panel' })
        await user.click(toggle)

        expect(
            screen.queryByRole('radiogroup', { name: 'Default terminal position' }),
        ).not.toBeInTheDocument()

        await user.click(toggle)

        expect(
            screen.getByRole('radiogroup', { name: 'Default terminal position' }),
        ).toBeInTheDocument()
    })

    it('renders speed selector with only standard and fast options, and updates store on change', async () => {
        const user = userEvent.setup()
        render(<GeneralSection />)

        const speedCombobox = screen.getByRole('combobox', { name: 'Speed' })
        expect(speedCombobox).toBeInTheDocument()
        expect(speedCombobox).toHaveTextContent('Standard')
        expect(useSettingsStore.getState().settings.speed).toBe('standard')

        await user.click(speedCombobox)

        const options = screen.getAllByRole('option')
        const optionLabels = options.map((opt) => opt.textContent?.trim())
        expect(optionLabels).toEqual(['Standard', 'Fast'])
        expect(screen.queryByText('Fastest')).not.toBeInTheDocument()

        const fastOption = screen.getByRole('option', { name: 'Fast' })
        await user.click(fastOption)

        expect(useSettingsStore.getState().settings.speed).toBe('fast')
        expect(speedCombobox).toHaveTextContent('Fast')

        await user.click(speedCombobox)
        const standardOption = screen.getByRole('option', { name: 'Standard' })
        await user.click(standardOption)

        expect(useSettingsStore.getState().settings.speed).toBe('standard')
        expect(speedCombobox).toHaveTextContent('Standard')
    })

    it('renders default permissions switch as checked and disabled', async () => {
        const user = userEvent.setup()
        render(<GeneralSection />)

        const defaultPermSwitch = screen.getByRole('switch', { name: 'Default permissions' })
        expect(defaultPermSwitch).toBeInTheDocument()
        expect(defaultPermSwitch).toHaveAttribute('aria-checked', 'true')
        expect(defaultPermSwitch).toBeDisabled()

        await user.click(defaultPermSwitch)
        expect(defaultPermSwitch).toHaveAttribute('aria-checked', 'true')
    })

    it('does not render auto review settings row', () => {
        render(<GeneralSection />)

        expect(screen.queryByText('Auto approval')).not.toBeInTheDocument()
        expect(screen.queryByRole('switch', { name: 'Auto approval' })).not.toBeInTheDocument()
    })

    it('does not render file open target or prompt suggestions settings rows', () => {
        render(<GeneralSection />)

        expect(screen.queryByText('Default file open target')).not.toBeInTheDocument()
        expect(screen.queryByRole('combobox', { name: 'Default file open target' })).not.toBeInTheDocument()
        expect(screen.queryByText('Prompt suggestions')).not.toBeInTheDocument()
        expect(screen.queryByRole('switch', { name: 'Prompt suggestions' })).not.toBeInTheDocument()
    })

    it('renders resumeUnfinishedConversations switch with name Resume unfinished conversations and toggles store', async () => {
        const user = userEvent.setup()
        useSettingsStore.setState({
            settings: { ...DEFAULT_SETTINGS, resumeUnfinishedConversations: true },
        })
        render(<GeneralSection />)

        const switchEl = screen.getByRole('switch', { name: 'Resume unfinished conversations' })
        expect(switchEl).toBeInTheDocument()
        expect(switchEl).toHaveAttribute('aria-checked', 'true')
        expect(useSettingsStore.getState().settings.resumeUnfinishedConversations).toBe(true)

        await user.click(switchEl)
        expect(switchEl).toHaveAttribute('aria-checked', 'false')
        expect(useSettingsStore.getState().settings.resumeUnfinishedConversations).toBe(false)
    })

    it('renders preventSleep switch with name Prevent sleep while running and toggles store', async () => {
        const user = userEvent.setup()
        useSettingsStore.setState({
            settings: { ...DEFAULT_SETTINGS, preventSleep: true },
        })
        render(<GeneralSection />)

        const switchEl = screen.getByRole('switch', { name: 'Prevent sleep while running' })
        expect(switchEl).toBeInTheDocument()
        expect(switchEl).toHaveAttribute('aria-checked', 'true')
        expect(useSettingsStore.getState().settings.preventSleep).toBe(true)

        await user.click(switchEl)
        expect(switchEl).toHaveAttribute('aria-checked', 'false')
        expect(useSettingsStore.getState().settings.preventSleep).toBe(false)
    })

    it('renders editor section and toggles showContextUsage without plainText', async () => {
        const user = userEvent.setup()
        render(<GeneralSection />)

        expect(screen.getByRole('heading', { level: 3, name: 'Editor' })).toBeInTheDocument()
        expect(screen.queryByText('Plain text editor')).not.toBeInTheDocument()
        expect(screen.queryByRole('switch', { name: 'Plain text editor' })).not.toBeInTheDocument()

        const contextUsageToggle = screen.getByRole('switch', { name: 'Show context window usage' })
        expect(contextUsageToggle).toHaveAttribute('aria-checked', 'true')
        expect(useSettingsStore.getState().settings.editor?.showContextUsage).toBe(true)

        await user.click(contextUsageToggle)
        expect(contextUsageToggle).toHaveAttribute('aria-checked', 'false')
        expect(useSettingsStore.getState().settings.editor?.showContextUsage).toBe(false)
    })

    it('changes sendShortcut dropdown selection and followUpMode in editor section', async () => {
        const user = userEvent.setup()
        render(<GeneralSection />)

        const select = screen.getByRole('combobox', { name: 'Send shortcut' })
        expect(select).toBeInTheDocument()

        await user.click(select)
        const enterOption = await screen.findByRole('option', { name: 'Enter to send' })
        await user.click(enterOption)

        expect(useSettingsStore.getState().settings.editor?.sendShortcut).toBe('enter')

        const queueOption = screen.getByRole('radio', { name: 'Queue' })
        const steerOption = screen.getByRole('radio', { name: 'Steer' })

        expect(steerOption).toHaveAttribute('aria-checked', 'true')
        expect(queueOption).toHaveAttribute('aria-checked', 'false')

        await user.click(queueOption)
        expect(queueOption).toHaveAttribute('aria-checked', 'true')
        expect(steerOption).toHaveAttribute('aria-checked', 'false')
        expect(useSettingsStore.getState().settings.editor?.followUpMode).toBe('queue')
    })

    it('renders and changes headlessCloseAction setting', async () => {
        const user = userEvent.setup()
        render(<GeneralSection />)

        const select = screen.getByRole('combobox', { name: 'When Window is Closed' })
        expect(select).toBeInTheDocument()

        await user.click(select)
        const quitOption = await screen.findByRole('option', { name: 'Exit application completely' })
        await user.click(quitOption)

        expect(useSettingsStore.getState().settings.headlessCloseAction).toBe('quit')
    })

    it('renders headlessCloseAction setting above menuBar setting when continue_headless', () => {
        useSettingsStore.setState({
            settings: { ...DEFAULT_SETTINGS, headlessCloseAction: 'continue_headless', showInMenuBar: true },
        })
        const { container } = render(<GeneralSection />)

        const headlessRow = container.querySelector('#setting-headlessCloseAction')
        const menuBarRow = container.querySelector('#setting-menuBar')

        expect(headlessRow).toBeInTheDocument()
        expect(menuBarRow).toBeInTheDocument()
        expect(
            Boolean(headlessRow && menuBarRow && (headlessRow.compareDocumentPosition(menuBarRow) & Node.DOCUMENT_POSITION_FOLLOWING)),
        ).toBe(true)
    })

    it('hides menuBar setting when headlessCloseAction is quit, and shows it when continue_headless', async () => {
        const user = userEvent.setup()
        useSettingsStore.setState({
            settings: { ...DEFAULT_SETTINGS, headlessCloseAction: 'continue_headless', showInMenuBar: true },
        })
        render(<GeneralSection />)

        expect(screen.getByRole('switch', { name: 'Show in menu bar' })).toBeInTheDocument()

        const select = screen.getByRole('combobox', { name: 'When Window is Closed' })
        await user.click(select)
        const quitOption = await screen.findByRole('option', { name: 'Exit application completely' })
        await user.click(quitOption)

        expect(screen.queryByRole('switch', { name: 'Show in menu bar' })).not.toBeInTheDocument()
        expect(document.querySelector('#setting-menuBar')).toBeNull()

        // Switch back to continue_headless
        await user.click(select)
        const continueOption = await screen.findByRole('option', { name: 'Keep running in background (Headless)' })
        await user.click(continueOption)

        expect(screen.getByRole('switch', { name: 'Show in menu bar' })).toBeInTheDocument()
        expect(document.querySelector('#setting-menuBar')).toBeInTheDocument()
    })
})
