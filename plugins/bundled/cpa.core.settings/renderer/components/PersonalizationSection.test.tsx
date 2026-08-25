import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '@/i18n'
import { HostServicesProvider } from '@cpa/plugin-ui'
import { createHostServices, setHostServices } from '@/application/services/createHostServices'
import type { HostServices, PersonalizationService } from '@cpa/plugin-api'
import { useSettingsStore } from '@/stores/settingsStore'
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
})
