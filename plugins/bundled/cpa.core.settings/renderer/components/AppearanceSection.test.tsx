import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '@/i18n'
import { DEFAULT_SETTINGS } from '@/types/models'
import { useSettingsStore } from '@/stores/settingsStore'
import { getHostServices } from '@/application/services/createHostServices'
import { AppearanceSection } from './AppearanceSection.js'

beforeEach(async () => {
    getHostServices()
    await i18n.changeLanguage('en')
    useSettingsStore.setState({
        settings: { ...DEFAULT_SETTINGS },
    })
})

describe('AppearanceSection', () => {
    it('renders title, theme options, and preferences', () => {
        render(<AppearanceSection />)

        expect(
            screen.getByRole('heading', { level: 1, name: 'Appearance' }),
        ).toBeInTheDocument()
        expect(screen.getByText('Theme')).toBeInTheDocument()
        expect(screen.getByText('Preferences')).toBeInTheDocument()
        expect(screen.getByRole('radio', { name: 'System' })).toBeInTheDocument()
        expect(screen.getByRole('radio', { name: 'Light' })).toBeInTheDocument()
        expect(screen.getByRole('radio', { name: 'Dark' })).toBeInTheDocument()
    })

    it('switches theme mode on clicking cards', async () => {
        const user = userEvent.setup()
        render(<AppearanceSection />)

        const lightRadio = screen.getByRole('radio', { name: 'Light' })
        await user.click(lightRadio)
        const lightSettings = useSettingsStore.getState().settings
        expect(lightSettings.theme).toBe('light')
        expect(lightSettings.backgroundColor).toBe('#FFFFFF')
        expect(lightSettings.foregroundColor).toBe('#1A1C1F')
        expect(lightSettings.contrast).toBe(45)
        expect(screen.getByText('Light Theme')).toBeInTheDocument()

        const systemRadio = screen.getByRole('radio', { name: 'System' })
        await user.click(systemRadio)
        expect(useSettingsStore.getState().settings.theme).toBe('system')

        const darkRadio = screen.getByRole('radio', { name: 'Dark' })
        await user.click(darkRadio)
        const darkSettings = useSettingsStore.getState().settings
        expect(darkSettings.theme).toBe('dark')
        expect(darkSettings.backgroundColor).toBe('#181818')
        expect(darkSettings.foregroundColor).toBe('#FFFFFF')
        expect(darkSettings.contrast).toBe(60)
        expect(screen.getByText('Dark Theme')).toBeInTheDocument()
    })

    it('renders live diff code preview box and updates accent/contrast dynamically', () => {
        useSettingsStore.setState({
            settings: {
                ...DEFAULT_SETTINGS,
                accentColor: '#339CFF',
                contrast: 60,
            },
        })
        render(<AppearanceSection />)

        expect(screen.getByText('"sidebar"')).toBeInTheDocument()
        expect(screen.getByText('"sidebar-elevated"')).toBeInTheDocument()
        expect(screen.getByText('"#339cff"')).toBeInTheDocument()
        expect(screen.getAllByText('60').length).toBeGreaterThanOrEqual(1)
    })

    it('toggles font smoothing', async () => {
        const user = userEvent.setup()
        render(<AppearanceSection />)

        const smoothingToggle = screen.getByRole('switch', {
            name: 'Font Smoothing',
        })
        expect(smoothingToggle).toHaveAttribute('aria-checked', 'true')
        await user.click(smoothingToggle)
        expect(useSettingsStore.getState().settings.fontSmoothing).toBe(false)
    })

    it('changes UI and Code font sizes via pixel inputs', async () => {
        const user = userEvent.setup()
        render(<AppearanceSection />)

        const uiFontInput = screen.getByRole('spinbutton', { name: 'UI Font Size' })
        expect(uiFontInput).toHaveValue(14)

        await user.clear(uiFontInput)
        await user.type(uiFontInput, '16')
        fireEvent.blur(uiFontInput)
        expect(useSettingsStore.getState().settings.uiFontSize).toBe(16)

        const codeFontInput = screen.getByRole('spinbutton', {
            name: 'Code Font Size',
        })
        expect(codeFontInput).toHaveValue(12)

        await user.clear(codeFontInput)
        await user.type(codeFontInput, '13')
        fireEvent.blur(codeFontInput)
        expect(useSettingsStore.getState().settings.codeFontSize).toBe(13)
    })

    it('changes theme presets and updates colors & contrast', async () => {
        const user = userEvent.setup()
        render(<AppearanceSection />)

        const presetSelect = screen.getByRole('combobox', { name: 'Theme Preset' })
        await user.click(presetSelect)

        const draculaOption = screen.getByRole('option', { name: 'Dracula' })
        await user.click(draculaOption)

        const currentSettings = useSettingsStore.getState().settings
        expect(currentSettings.themePreset).toBe('dracula')
        expect(currentSettings.accentColor).toBe('#bd93f9')
        expect(currentSettings.backgroundColor).toBe('#282a36')
        expect(currentSettings.contrast).toBe(65)
    })

    it('changes contrast slider value and marks preset as custom', () => {
        render(<AppearanceSection />)

        const slider = screen.getByRole('slider', { name: 'Contrast' })
        fireEvent.change(slider, { target: { value: '80' } })

        const currentSettings = useSettingsStore.getState().settings
        expect(currentSettings.contrast).toBe(80)
        expect(currentSettings.themePreset).toBe('custom')
    })

    it('copies theme configuration to clipboard', async () => {
        const user = userEvent.setup()
        const writeTextMock = vi.fn().mockResolvedValue(undefined)
        Object.defineProperty(navigator, 'clipboard', {
            value: { writeText: writeTextMock },
            configurable: true,
            writable: true,
        })

        render(<AppearanceSection />)

        const copyBtn = screen.getByRole('button', { name: 'Duplicate Theme' })
        await user.click(copyBtn)

        expect(writeTextMock).toHaveBeenCalledTimes(1)
        const copiedJson = JSON.parse(writeTextMock.mock.calls[0][0])
        expect(copiedJson.theme).toBe('dark')
        expect(copiedJson.accentColor).toBe('#339CFF')
    })

    it('opens import dialog, validates invalid JSON and imports valid JSON', async () => {
        const user = userEvent.setup()
        render(<AppearanceSection />)

        const importBtn = screen.getByRole('button', { name: 'Import' })
        await user.click(importBtn)

        const dialog = screen.getByRole('dialog', { name: 'Import Theme Configuration' })
        expect(dialog).toBeInTheDocument()

        const textarea = screen.getByPlaceholderText(/Paste JSON theme configuration/i)
        fireEvent.change(textarea, { target: { value: '{ broken json' } })

        const confirmBtn = within(dialog).getByRole('button', { name: 'Import' })
        await user.click(confirmBtn)

        expect(screen.getByText('Invalid theme configuration format')).toBeInTheDocument()

        await user.clear(textarea)
        fireEvent.change(textarea, {
            target: {
                value: JSON.stringify({
                    accentColor: '#10B981',
                    contrast: 75,
                    themePreset: 'custom',
                }),
            },
        })

        await user.click(confirmBtn)

        expect(screen.queryByRole('dialog', { name: 'Import Theme Configuration' })).toBeNull()
        const settings = useSettingsStore.getState().settings
        expect(settings.accentColor).toBe('#10B981')
        expect(settings.contrast).toBe(75)
    })
})
