import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '@/i18n'
import { HostServicesProvider } from '@cpa/plugin-ui'
import { createHostServices, setHostServices } from '@/application/services/createHostServices'
import type {
    HostServices,
    ModelCatalogEntry,
    PersonalizationService,
    SystemPromptEnhancementSettings,
} from '@cpa/plugin-api'
import { useSettingsStore } from '@/stores/settingsStore'
import { useModelCatalogStore } from '@/stores/modelCatalogStore'
import { useUiStore } from '@/stores/uiStore'
import { ToggleSwitch } from '@cpa/plugin-ui'
import { BasePersonalizationSection, PersonalizationSection } from './PersonalizationSection.js'
import { rendererPluginRuntime } from '@/plugins/platform/RendererPluginRuntimeHost'
import { rendererRegistry } from '@/plugins/platform/rendererRegistry'

describe('PersonalizationSection', () => {
    let mockPersonalization: {
        loadInstructions: ReturnType<typeof vi.fn>
        saveInstructions: ReturnType<typeof vi.fn>
    }
    let hostServices: HostServices

    beforeEach(async () => {
        rendererRegistry.registerComponentWrapper({
            id: 'test.memories.personalization-wrapper',
            pluginId: 'test.memories',
            targetComponent: 'PersonalizationSection',
            order: 20,
            wrapper: (BaseComponent: any) => {
                return function WrappedPersonalization(props: any) {
                    const localMemoryEnabled = useSettingsStore(
                        (s) => s.settings.localMemoryEnabled ?? true,
                    )
                    const setLocalMemoryEnabled = useSettingsStore((s) => s.setLocalMemoryEnabled)
                    const toolAssistedMemoryEnabled = useSettingsStore(
                        (s) => s.settings.toolAssistedMemoryEnabled ?? false,
                    )
                    const setToolAssistedMemoryEnabled = useSettingsStore(
                        (s) => s.setToolAssistedMemoryEnabled,
                    )
                    const pushToast = useUiStore((s) => s.pushToast)

                    return (
                        <BaseComponent {...props}>
                            <section>
                                <h2>Memory</h2>
                                <p>Configure how local memory is collected, retained, and consolidated on this machine</p>
                                <div>
                                    <span>Enable local memory</span>
                                    <ToggleSwitch
                                        checked={localMemoryEnabled}
                                        label="Enable local memory"
                                        onChange={setLocalMemoryEnabled}
                                    />
                                </div>
                                <div>
                                    <span>Allow memory generation from tool-assisted chats</span>
                                    <ToggleSwitch
                                        checked={toolAssistedMemoryEnabled}
                                        label="Allow memory generation from tool-assisted chats"
                                        onChange={setToolAssistedMemoryEnabled}
                                    />
                                </div>
                                <div>
                                    <span>Delete local memory</span>
                                    <button
                                        type="button"
                                        onClick={() => pushToast('Local memory deleted')}
                                    >
                                        Delete
                                    </button>
                                </div>
                            </section>
                        </BaseComponent>
                    )
                }
            },
        })

        await i18n.changeLanguage('en')
        useSettingsStore.setState({
            settings: {
                ...useSettingsStore.getState().settings,
                localMemoryEnabled: true,
                toolAssistedMemoryEnabled: false,
                personality: 'pragmatic',
            },
        })
        useUiStore.setState({ toasts: [] })

        mockPersonalization = {
            loadInstructions: vi.fn().mockResolvedValue('# Custom Instructions\n- KISS rule'),
            saveInstructions: vi.fn().mockResolvedValue(undefined),
        }

        hostServices = createHostServices()
        hostServices.personalization = mockPersonalization as unknown as PersonalizationService
        setHostServices(hostServices)
    })

    afterEach(async () => {
        await rendererPluginRuntime.reset()
        vi.restoreAllMocks()
    })

    const renderWithServices = (ui = <PersonalizationSection />) =>
        render(
            <HostServicesProvider services={hostServices}>
                {ui}
            </HostServicesProvider>,
        )

    it('renders all sections matching snapshot specifications', async () => {
        renderWithServices()

        // Title
        expect(screen.getByRole('heading', { level: 1, name: 'Personalization' })).toBeInTheDocument()

        // Section 1: Custom Instructions
        expect(screen.getByRole('heading', { level: 2, name: 'Custom Instructions' })).toBeInTheDocument()
        expect(screen.getByText(/Provide custom instructions and context for all chats on this machine/i)).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument()

        // Wait for textarea to load content from service
        await waitFor(() => {
            const textarea = screen.getByPlaceholderText('Enter custom instructions here...') as HTMLTextAreaElement
            expect(textarea.value).toBe('# Custom Instructions\n- KISS rule')
        })

        // Section 2: Memory
        expect(screen.getByRole('heading', { level: 2, name: 'Memory' })).toBeInTheDocument()
        expect(screen.getByText(/Configure how local memory is collected, retained, and consolidated on this machine/i)).toBeInTheDocument()
        expect(screen.getByText('Enable local memory')).toBeInTheDocument()
        expect(screen.getByText('Allow memory generation from tool-assisted chats')).toBeInTheDocument()
        expect(screen.getByText('Delete local memory')).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument()

        // Section 3: Personality
        expect(screen.getByText('Choose the default tone for CPA responses')).toBeInTheDocument()
        expect(screen.getByRole('combobox', { name: 'Personality' })).toBeInTheDocument()
    })

    it('defaults textarea to empty if instructions do not exist', async () => {
        mockPersonalization.loadInstructions.mockRejectedValueOnce(new Error('ENOENT: no such file'))

        renderWithServices()

        await waitFor(() => {
            const textarea = screen.getByPlaceholderText('Enter custom instructions here...') as HTMLTextAreaElement
            expect(textarea.value).toBe('')
        })
    })

    it('saves custom instructions when clicking save', async () => {
        mockPersonalization.loadInstructions.mockResolvedValueOnce('')

        renderWithServices()

        const textarea = screen.getByPlaceholderText('Enter custom instructions here...')
        fireEvent.change(textarea, { target: { value: '# Custom Global Rule\nFollow KISS principle' } })

        const saveButton = screen.getByRole('button', { name: 'Save' })
        await act(async () => {
            fireEvent.click(saveButton)
        })

        expect(mockPersonalization.saveInstructions).toHaveBeenCalledWith(
            '# Custom Global Rule\nFollow KISS principle',
        )
        expect(useUiStore.getState().toasts[0]?.message).toBe('Custom instructions saved')
    })

    it('populates empty content when saving with empty content', async () => {
        mockPersonalization.loadInstructions.mockResolvedValueOnce('initial content')

        renderWithServices()

        await waitFor(() => {
            const textarea = screen.getByPlaceholderText('Enter custom instructions here...') as HTMLTextAreaElement
            expect(textarea.value).toBe('initial content')
        })

        const textarea = screen.getByPlaceholderText('Enter custom instructions here...')
        fireEvent.change(textarea, { target: { value: '' } })

        const saveButton = screen.getByRole('button', { name: 'Save' })
        await act(async () => {
            fireEvent.click(saveButton)
        })

        expect(mockPersonalization.saveInstructions).toHaveBeenCalledWith('')
        expect(useUiStore.getState().toasts[0]?.message).toBe('Custom instructions saved')
    })

    it('toggles local memory and tool-assisted memory switches', () => {
        renderWithServices()

        const switches = screen.getAllByRole('switch')
        expect(switches[0]).toHaveAttribute('aria-checked', 'true')
        expect(switches[1]).toHaveAttribute('aria-checked', 'false')

        fireEvent.click(switches[0])
        expect(useSettingsStore.getState().settings.localMemoryEnabled).toBe(false)

        fireEvent.click(switches[1])
        expect(useSettingsStore.getState().settings.toolAssistedMemoryEnabled).toBe(true)
    })

    it('triggers delete memory toast when clicking delete button', async () => {
        renderWithServices()

        const deleteButton = screen.getByRole('button', { name: 'Delete' })
        await act(async () => {
            fireEvent.click(deleteButton)
        })

        expect(useUiStore.getState().toasts[0]?.message).toBe('Local memory deleted')
    })

    it('changes personality tone via dropdown', () => {
        renderWithServices()

        const select = screen.getByRole('combobox', { name: 'Personality' })
        expect(select).toHaveTextContent('Pragmatic')

        fireEvent.click(select)
        const option = screen.getByRole('option', { name: 'Professional' })
        fireEvent.click(option)

        expect(useSettingsStore.getState().settings.personality).toBe('professional')
    })

    it('renders BasePersonalizationSection without memory section when no plugins/wrappers are active', () => {
        renderWithServices(<BasePersonalizationSection />)

        // Custom Instructions should exist
        expect(screen.getByRole('heading', { level: 2, name: 'Custom Instructions' })).toBeInTheDocument()
        // Personality should exist
        expect(screen.getByRole('combobox', { name: 'Personality' })).toBeInTheDocument()
        // Memory section should NOT exist
        expect(screen.queryByRole('heading', { level: 2, name: 'Memory' })).not.toBeInTheDocument()
        expect(screen.queryByText('Enable local memory')).not.toBeInTheDocument()
    })

    describe('System Prompt Enhancement section in PersonalizationSection', () => {
        it('hides all enhancement options when switched off and restores saved values when switched back on', async () => {
            const user = userEvent.setup()
            const defaultModel: ModelCatalogEntry = {
                id: 'model-a',
                label: 'Model A',
                supportsFast: false,
                reasoningLevels: [],
                input: ['text'],
                contextWindow: 128_000,
                maxTokens: 8_192,
            }
            const savedEnhancement: SystemPromptEnhancementSettings = {
                enabled: true,
                modelId: 'model-b',
                appliedModelIds: ['model-a'],
                multilingualEnabled: true,
                allowedLanguages: ['de', 'ja'],
            }
            useModelCatalogStore.setState({
                models: [defaultModel, { ...defaultModel, id: 'model-b', label: 'Model B' }],
            })
            useSettingsStore.setState({
                settings: {
                    ...useSettingsStore.getState().settings,
                    modelId: defaultModel.id,
                    modelSettings: { enableAll: true },
                    systemPromptEnhancement: savedEnhancement,
                },
            })
            renderWithServices(<BasePersonalizationSection />)

            const toggle = screen.getByRole('switch', { name: 'System Prompt Enhancement' })
            const toggleRow = toggle.closest('#systemPromptEnhancement')
            expect(toggle).toBeChecked()
            await user.click(toggle)

            expect(toggle).not.toBeChecked()
            for (const label of [
                'Builder model',
                'Apply to models',
                'Allow multilingual construction',
                'Allowed construction languages',
            ]) {
                expect(screen.queryByText(label)).not.toBeInTheDocument()
            }
            expect(toggleRow).not.toHaveClass('border-b')
            expect(useSettingsStore.getState().settings.systemPromptEnhancement).toEqual({
                ...savedEnhancement,
                enabled: false,
            })

            await user.click(toggle)

            expect(toggle).toBeChecked()
            expect(toggleRow).toHaveClass('border-b')
            expect(screen.getByRole('combobox', { name: 'Builder model' })).toHaveTextContent('Model B')
            expect(screen.getByRole('switch', { name: 'Allow multilingual construction' })).toBeChecked()
            expect(screen.getByRole('button', { name: 'German', pressed: true })).toBeInTheDocument()
            expect(screen.getByRole('button', { name: 'Japanese', pressed: true })).toBeInTheDocument()
            expect(screen.getByRole('button', { name: 'English', pressed: false })).toBeInTheDocument()
            await user.click(screen.getByRole('button', { name: /apply to models/i }))
            const scope = within(screen.getByRole('dialog', { name: 'Apply to models' }))
            expect(scope.getByRole('checkbox', { name: 'Model A' })).toBeChecked()
            expect(scope.getByRole('checkbox', { name: 'Model B' })).not.toBeChecked()
        })

        it('renders enhancement switch, multilingual switch, and build model CustomSelect aligned with enabled models in modelOrder', async () => {
            useModelCatalogStore.setState({
                models: [
                    {
                        id: 'model-a',
                        label: 'Model A',
                        supportsFast: false,
                        reasoningLevels: [],
                        input: ['text'],
                        contextWindow: 128_000,
                        maxTokens: 8_192,
                    },
                    {
                        id: 'model-b',
                        label: 'Model B',
                        supportsFast: false,
                        reasoningLevels: [],
                        input: ['text'],
                        contextWindow: 128_000,
                        maxTokens: 8_192,
                    },
                    {
                        id: 'model-disabled',
                        label: 'Model Disabled',
                        supportsFast: false,
                        reasoningLevels: [],
                        input: ['text'],
                        contextWindow: 128_000,
                        maxTokens: 8_192,
                    },
                ],
            })
            useSettingsStore.setState({
                settings: {
                    ...useSettingsStore.getState().settings,
                    modelId: 'model-a',
                    modelSettings: {
                        enableAll: false,
                        modelOrder: ['model-b', 'model-a'],
                        models: {
                            'model-disabled': { enabled: false },
                        },
                    },
                    systemPromptEnhancement: {
                        enabled: false,
                        multilingualEnabled: false,
                        allowedLanguages: ['en'],
                        modelId: '',
                    },
                },
            })

            const spySetEnhancement = vi.spyOn(hostServices.settings!, 'setSystemPromptEnhancement')

            renderWithServices(<BasePersonalizationSection />)

            expect(
                screen.getByRole('heading', { level: 2, name: 'System Prompt Enhancement' }),
            ).toBeInTheDocument()
            const toggle = screen.getByRole('switch', { name: 'System Prompt Enhancement' })
            expect(toggle).not.toBeChecked()
            expect(screen.queryByRole('combobox', { name: 'Builder model' })).not.toBeInTheDocument()
            await userEvent.setup().click(toggle)
            expect(screen.getByRole('switch', { name: 'Allow multilingual construction' })).not.toBeChecked()

            // Language selection list is hidden when multilingualEnabled is false
            expect(screen.queryByRole('button', { name: 'Select all' })).not.toBeInTheDocument()

            // Open build model CustomSelect
            const modelSelect = screen.getByRole('combobox', { name: 'Builder model' })
            expect(modelSelect).toHaveTextContent('Model A')
            fireEvent.click(modelSelect)

            const options = screen.getAllByRole('option')
            expect(options.map((o) => o.textContent)).toEqual(['Model B', 'Model A'])
            expect(screen.queryByRole('option', { name: 'Model Disabled' })).not.toBeInTheDocument()

            fireEvent.click(screen.getByRole('option', { name: 'Model B' }))
            expect(spySetEnhancement).toHaveBeenCalledWith({ modelId: 'model-b' })
            expect(useSettingsStore.getState().settings.systemPromptEnhancement?.modelId).toBe(
                'model-b',
            )
        })

        it('shows 8 languages when multilingualEnabled is true, toggles selection, and prevents unchecking the last selected language', async () => {
            useSettingsStore.setState({
                settings: {
                    ...useSettingsStore.getState().settings,
                    systemPromptEnhancement: {
                        enabled: true,
                        multilingualEnabled: true,
                        allowedLanguages: ['en'],
                        modelId: '',
                    },
                },
            })

            renderWithServices(<BasePersonalizationSection />)

            const langLabels = [
                'English',
                'Simplified Chinese',
                'Traditional Chinese',
                'Japanese',
                'German',
                'Spanish',
                'Portuguese',
                'Italian',
            ]
            for (const label of langLabels) {
                expect(screen.getByRole('button', { name: label })).toBeInTheDocument()
            }

            // Clicking the sole selected language must NOT empty allowedLanguages and exposes disabled semantics
            const enBtn = screen.getByRole('button', { name: 'English' })
            expect(enBtn).toHaveAttribute('aria-pressed', 'true')
            expect(enBtn).toBeDisabled()
            expect(enBtn).toHaveAttribute('aria-disabled', 'true')
            fireEvent.click(enBtn)
            expect(
                useSettingsStore.getState().settings.systemPromptEnhancement?.allowedLanguages,
            ).toEqual(['en'])

            // Clicking Japanese adds it -> ['en', 'ja']
            fireEvent.click(screen.getByRole('button', { name: 'Japanese' }))
            expect(
                useSettingsStore.getState().settings.systemPromptEnhancement?.allowedLanguages,
            ).toEqual(['en', 'ja'])

            // Now unchecking English leaves ['ja']
            fireEvent.click(screen.getByRole('button', { name: 'English' }))
            expect(
                useSettingsStore.getState().settings.systemPromptEnhancement?.allowedLanguages,
            ).toEqual(['ja'])
        })
    })
    describe('models the system prompt enhancement applies to', () => {
        const alpha: ModelCatalogEntry = {
            id: 'gateway/alpha',
            label: 'Alpha',
            supportsFast: false,
            reasoningLevels: [],
            input: ['text'],
            contextWindow: 128_000,
            maxTokens: 8_192,
        }
        const beta = { ...alpha, id: 'gateway/beta', label: 'Beta' }
        const offline = { ...alpha, id: 'gateway/third', label: 'Offline Model' }

        function renderModelScope(appliedModelIds?: string[] | null) {
            useModelCatalogStore.setState({ models: [alpha, beta, offline] })
            useSettingsStore.setState({
                settings: {
                    ...useSettingsStore.getState().settings,
                    modelSettings: {
                        enableAll: false,
                        models: { 'gateway/third': { enabled: false } },
                    },
                    systemPromptEnhancement: {
                        enabled: true,
                        multilingualEnabled: false,
                        allowedLanguages: ['en'],
                        modelId: 'gateway/alpha',
                        appliedModelIds,
                    },
                },
            })
            return renderWithServices(<BasePersonalizationSection />)
        }

        const storedScope = () => useSettingsStore.getState().settings.systemPromptEnhancement?.appliedModelIds

        it('shows the saved partial scope and filters the full catalog by name and ID without closing on toggles', async () => {
            const user = userEvent.setup()
            renderModelScope(['gateway/beta'])
            const trigger = screen.getByRole('button', { name: /apply to models/i })
            expect(trigger).toHaveTextContent('1 model selected')
            expect(trigger.closest('[data-setting-id]')).toBe(
                document.getElementById('systemPromptEnhancementModel')?.nextElementSibling,
            )
            await user.click(trigger)
            const dialog = within(screen.getByRole('dialog', { name: 'Apply to models' }))
            const all = dialog.getByRole('checkbox', { name: 'All models' })
            expect(all).toBePartiallyChecked()
            expect(dialog.getByRole('checkbox', { name: 'Beta' })).toBeChecked()
            expect(dialog.getByRole('checkbox', { name: 'Alpha' })).not.toBeChecked()
            expect(dialog.getByRole('checkbox', { name: 'Offline Model' })).not.toBeChecked()

            const search = dialog.getByRole('searchbox', { name: 'Search models' })
            await user.type(search, 'OFFLINE')
            expect(dialog.getAllByRole('checkbox')).toHaveLength(2)
            expect(all).toBePartiallyChecked()
            const model = dialog.getByRole('checkbox', { name: 'Offline Model' })
            await user.click(model)
            expect(model).toBeChecked()
            expect(storedScope()).toEqual(['gateway/beta', 'gateway/third'])
            expect(trigger).toHaveTextContent('2 models selected')

            await user.clear(search)
            await user.type(search, 'gateway/third')
            expect(dialog.getAllByRole('checkbox')).toHaveLength(2)
            await user.click(dialog.getByRole('checkbox', { name: 'Offline Model' }))
            expect(dialog.getByRole('checkbox', { name: 'Offline Model' })).not.toBeChecked()
            expect(storedScope()).toEqual(['gateway/beta'])
        })

        it.each([undefined, null])('shows the dynamic scope (%s) checked and unchecks against the unfiltered catalog', async (value) => {
            const user = userEvent.setup()
            renderModelScope(value)
            const trigger = screen.getByRole('button', { name: /apply to models/i })
            expect(trigger).toHaveTextContent('All models')
            await user.click(trigger)
            const dialog = within(screen.getByRole('dialog', { name: 'Apply to models' }))
            const all = dialog.getByRole('checkbox', { name: 'All models' })
            for (const checkbox of dialog.getAllByRole('checkbox')) {
                expect(checkbox).toBeChecked()
            }

            await user.type(dialog.getByRole('searchbox'), 'alpha')
            const model = dialog.getByRole('checkbox', { name: 'Alpha' })
            await user.click(model)
            expect(storedScope()).toEqual(['gateway/beta', 'gateway/third'])
            expect(all).toBePartiallyChecked()
            await user.click(model)
            expect(storedScope()).toEqual(['gateway/beta', 'gateway/third', 'gateway/alpha'])
            expect(all).toBePartiallyChecked()
        })

        it('uses the always-visible bulk checkbox for dynamic all and clear even with no matches', async () => {
            const user = userEvent.setup()
            renderModelScope([])
            const trigger = screen.getByRole('button', { name: /apply to models/i })
            expect(trigger).toHaveTextContent('No models selected')
            await user.click(trigger)
            const dialog = within(screen.getByRole('dialog', { name: 'Apply to models' }))
            const all = dialog.getByRole('checkbox', { name: 'All models' })
            expect(all).not.toBeChecked()
            expect(dialog.getByRole('checkbox', { name: 'Beta' })).not.toBeChecked()

            const search = dialog.getByRole('searchbox')
            await user.type(search, 'no-such-model')
            expect(dialog.getByRole('status')).toHaveTextContent('No matching models')
            expect(dialog.getAllByRole('checkbox')).toEqual([all])
            await user.click(all)
            expect(storedScope()).toBeNull()
            expect(all).toBeChecked()
            await user.click(all)
            expect(storedScope()).toEqual([])
            expect(all).not.toBeChecked()
            await user.click(all)
            expect(storedScope()).toBeNull()

            act(() => {
                useModelCatalogStore.setState({ models: [alpha, beta, offline, { ...alpha, id: 'gateway/new', label: 'New Model' }] })
            })
            await user.clear(search)
            expect(dialog.getByRole('checkbox', { name: 'New Model' })).toBeChecked()
        })

        it('supports keyboard selection within the portal and restores trigger focus on Escape', async () => {
            const user = userEvent.setup()
            const { container } = renderModelScope(['gateway/beta'])
            const trigger = screen.getByRole('button', { name: /apply to models/i })
            trigger.focus()
            await user.keyboard('{Enter}')
            const popup = screen.getByRole('dialog', { name: 'Apply to models' })
            expect(container).not.toContainElement(popup)
            expect(popup).toHaveClass('fixed', 'z-[70]')
            expect(trigger).toHaveAttribute('aria-controls', popup.id)
            expect(within(popup).getByRole('searchbox')).toHaveFocus()
            await user.keyboard('offline')
            await user.tab()
            expect(within(popup).getByRole('checkbox', { name: 'All models' })).toHaveFocus()
            await user.keyboard(' ')
            expect(storedScope()).toBeNull()
            await user.tab()
            expect(within(popup).getByRole('checkbox', { name: 'Offline Model' })).toHaveFocus()
            await user.keyboard(' ')
            expect(storedScope()).toEqual(['gateway/alpha', 'gateway/beta'])
            const onGlobalKey = vi.fn((event: KeyboardEvent) => {
                if (event.shiftKey && event.key === 'Tab') event.preventDefault()
            })
            window.addEventListener('keydown', onGlobalKey)
            try {
                await user.tab({ shift: true })
                expect(within(popup).getByRole('checkbox', { name: 'All models' })).toHaveFocus()
                expect(onGlobalKey).not.toHaveBeenCalledWith(expect.objectContaining({ key: 'Tab' }))
            } finally {
                window.removeEventListener('keydown', onGlobalKey)
            }
            await user.keyboard('{Escape}')
            expect(popup).not.toBeInTheDocument()
            expect(trigger).toHaveFocus()
            expect(trigger).toHaveAttribute('aria-expanded', 'false')
        })
    })

    it.each(['en', 'zh-CN'])('describes the global default model and shows empty catalog label in %s', async (locale) => {
        await i18n.changeLanguage(locale)
        useModelCatalogStore.setState({ models: [] })
        useSettingsStore.getState().setSystemPromptEnhancement({ enabled: true })
        renderWithServices(<BasePersonalizationSection />)
        const prefix = 'settings.personalization.systemPromptEnhancement.'
        expect(i18n.t(prefix + 'modelDesc')).toMatch(locale === 'en' ? /global default model/i : /全局默认模型/)
        expect(i18n.t(prefix + 'modelPlaceholder')).toMatch(locale === 'en' ? /global default model/i : /全局默认模型/)
        expect(screen.getByRole('combobox', { name: locale === 'en' ? 'Builder model' : '构建模型' })).toHaveTextContent(locale === 'en' ? 'No models available' : '暂无可用模型')
        const scopeLabel = locale === 'en' ? 'Apply to models' : '应用到的模型'
        fireEvent.click(screen.getByRole('button', { name: new RegExp(scopeLabel, 'i') }))
        const scope = within(screen.getByRole('dialog', { name: scopeLabel }))
        const all = scope.getByRole('checkbox', { name: locale === 'en' ? 'All models' : '全部模型' })
        expect(all).toBeEnabled()
        expect(scope.getByRole('status')).toHaveTextContent(locale === 'en' ? 'No models available' : '暂无可用模型')
    })

    it('inherits --ui-font-size and --font-weight-ui typography tokens in the System Prompt Enhancement block', () => {
        useSettingsStore.setState({
            settings: {
                ...useSettingsStore.getState().settings,
                systemPromptEnhancement: {
                    enabled: true,
                    multilingualEnabled: true,
                    allowedLanguages: ['en'],
                    modelId: '',
                },
            },
        })

        renderWithServices(<BasePersonalizationSection />)

        const heading = screen.getByRole('heading', { level: 2, name: 'System Prompt Enhancement' })
        expect(heading.className).toContain('font-[inherit]')
        expect(heading.className).toContain('--ui-font-size')
        expect(heading.className).not.toMatch(/text-\[\d+px\]/)
        expect(heading.className).not.toMatch(/font-(medium|semibold|bold|thin|light|normal)/)

        const description = screen.getByText(/Rewrite the core system prompt once per session/i)
        expect(description.className).toContain('font-[inherit]')
        expect(description.className).toContain('--ui-font-size')
        expect(description.className).not.toMatch(/text-\[\d+px\]/)

        const enButton = screen.getByRole('button', { name: 'English' })
        expect(enButton.className).toContain('font-[inherit]')
        expect(enButton.className).toContain('--ui-font-size')
        expect(enButton.className).not.toMatch(/text-\[\d+px\]/)
        expect(enButton.className).not.toMatch(/font-(medium|semibold|bold|thin|light|normal)/)

        const selectAllBtn = screen.getByRole('button', { name: 'Select all' })
        expect(selectAllBtn.className).toContain('font-[inherit]')
        expect(selectAllBtn.className).toContain('--ui-font-size')
        expect(selectAllBtn.className).not.toMatch(/text-\[\d+px\]/)
        expect(selectAllBtn.className).not.toMatch(/font-(medium|semibold|bold|thin|light|normal)/)

        // All 3 SettingsRow titles, descriptions, and Builder model CustomSelect trigger must inherit typography
        const rowTitles = [
            screen.getByText('Enable system prompt enhancement'),
            screen.getByText('Builder model'),
            screen.getByText('Allow multilingual construction'),
        ]
        for (const titleEl of rowTitles) {
            expect(titleEl.className).toContain('font-[inherit]')
            expect(titleEl.className).toContain('--ui-font-size')
            expect(titleEl.className).not.toMatch(/text-\[\d+px\]/)
            expect(titleEl.className).not.toMatch(/font-(medium|semibold|bold|thin|light|normal)/)
        }

        const rowDescriptions = [
            screen.getByText(/Generate a unique rewritten core system prompt for each new session/i),
            screen.getByText(/Model used to synthesize each session's enhanced core system prompt/i),
            screen.getByText(/Randomly pick one selected language to write the enhanced system prompt/i),
        ]
        for (const descEl of rowDescriptions) {
            expect(descEl.className).toContain('font-[inherit]')
            expect(descEl.className).toContain('--ui-font-size')
            expect(descEl.className).not.toMatch(/text-\[\d+px\]/)
            expect(descEl.className).not.toMatch(/font-(medium|semibold|bold|thin|light|normal)/)
        }

        const modelSelectTrigger = screen.getByRole('combobox', { name: 'Builder model' })
        expect(modelSelectTrigger.className).toContain('font-[inherit]')
        expect(modelSelectTrigger.className).toContain('--ui-font-size')
        expect(modelSelectTrigger.className).not.toMatch(/text-\[\d+px\]/)
        expect(modelSelectTrigger.className).not.toMatch(/font-(medium|semibold|bold|thin|light|normal)/)
    })

})
