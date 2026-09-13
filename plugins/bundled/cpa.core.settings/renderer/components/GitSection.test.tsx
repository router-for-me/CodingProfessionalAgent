import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import i18n from '@/i18n'
import { useSettingsStore } from '@/stores/settingsStore'
import { DEFAULT_SETTINGS } from '@/types/models'
import { getHostServices } from '@/application/services/createHostServices'
import { GitSection } from './GitSection.js'

describe('GitSection', () => {
    beforeEach(async () => {
        getHostServices()
        useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS } })
        await i18n.changeLanguage('en')
    })

    it('renders all sections and initial values correctly', () => {
        render(<GitSection />)

        // Check main heading
        expect(screen.getByRole('heading', { level: 1, name: 'Git' })).toBeInTheDocument()

        // Check branch prefix input
        const branchInput = screen.getByLabelText('Branch prefix') as HTMLInputElement
        expect(branchInput).toBeInTheDocument()
        expect(branchInput.value).toBe('cpa/')

        // Check merge method radio buttons
        expect(screen.getByRole('radio', { name: 'Merge' })).toBeInTheDocument()
        expect(screen.getByRole('radio', { name: 'Squash and merge' })).toBeInTheDocument()
        expect(screen.getByRole('radio', { name: 'Merge' })).toHaveAttribute('aria-checked', 'true')

        // Check switches
        expect(screen.getByRole('switch', { name: 'Always force push' })).toHaveAttribute(
            'aria-checked',
            'false',
        )
        expect(screen.getByRole('switch', { name: 'Create draft pull requests' })).toHaveAttribute(
            'aria-checked',
            'true',
        )

        // Review presentation should not be in Git section
        expect(screen.queryByText('Review presentation')).not.toBeInTheDocument()

        // Check auto merge section
        expect(screen.getByText('Monitor and fix Pull Requests')).toBeInTheDocument()
        expect(screen.getByRole('switch', { name: 'Auto-merge when ready' })).toHaveAttribute(
            'aria-checked',
            'false',
        )
        expect(
            screen.getByPlaceholderText(
                'e.g. Comment /merge once checks pass, approve unrelated Chromatic changes...',
            ),
        ).toBeInTheDocument()

        // Check commit instructions
        expect(screen.getByText('Commit instructions')).toBeInTheDocument()
        expect(screen.getByPlaceholderText('Add commit instructions...')).toBeInTheDocument()

        // Check pull request instructions
        expect(screen.getByText('Pull request instructions')).toBeInTheDocument()
        expect(screen.getByPlaceholderText('Add pull request instructions...')).toBeInTheDocument()
    })

    it('allows editing branch prefix and saves to settingsStore', () => {
        render(<GitSection />)
        const branchInput = screen.getByLabelText('Branch prefix') as HTMLInputElement
        fireEvent.change(branchInput, { target: { value: 'feature/' } })
        expect(branchInput.value).toBe('feature/')
        expect(useSettingsStore.getState().settings.git?.branchPrefix).toBe('feature/')
    })

    it('allows toggling switches and segmented controls and saves to settingsStore', () => {
        render(<GitSection />)

        // Toggle merge method
        const squashRadio = screen.getByRole('radio', { name: 'Squash and merge' })
        fireEvent.click(squashRadio)
        expect(squashRadio).toHaveAttribute('aria-checked', 'true')
        expect(useSettingsStore.getState().settings.git?.mergeMethod).toBe('squash')

        // Toggle always force push
        const forcePushSwitch = screen.getByRole('switch', { name: 'Always force push' })
        fireEvent.click(forcePushSwitch)
        expect(forcePushSwitch).toHaveAttribute('aria-checked', 'true')
        expect(useSettingsStore.getState().settings.git?.alwaysForcePush).toBe(true)

        // Toggle auto merge
        const autoMergeSwitch = screen.getByRole('switch', { name: 'Auto-merge when ready' })
        fireEvent.click(autoMergeSwitch)
        expect(autoMergeSwitch).toHaveAttribute('aria-checked', 'true')
        expect(useSettingsStore.getState().settings.git?.autoMergeWhenReady).toBe(true)
    })

    it('allows editing textareas and saves to settingsStore', () => {
        render(<GitSection />)

        const autoMergeTextarea = screen.getByPlaceholderText(
            'e.g. Comment /merge once checks pass, approve unrelated Chromatic changes...',
        ) as HTMLTextAreaElement
        fireEvent.change(autoMergeTextarea, {
            target: { value: 'Auto merge when tests pass' },
        })
        expect(
            useSettingsStore.getState().settings.git?.autoMergeInstructions,
        ).toBe('Auto merge when tests pass')

        const commitTextarea = screen.getByPlaceholderText(
            'Add commit instructions...',
        ) as HTMLTextAreaElement
        fireEvent.change(commitTextarea, {
            target: { value: 'Use conventional commits' },
        })
        expect(
            useSettingsStore.getState().settings.git?.commitInstructions,
        ).toBe('Use conventional commits')

        const prTextarea = screen.getByPlaceholderText(
            'Add pull request instructions...',
        ) as HTMLTextAreaElement
        fireEvent.change(prTextarea, {
            target: { value: 'Include test plan in PR' },
        })
        expect(
            useSettingsStore.getState().settings.git?.prInstructions,
        ).toBe('Include test plan in PR')
    })
})
