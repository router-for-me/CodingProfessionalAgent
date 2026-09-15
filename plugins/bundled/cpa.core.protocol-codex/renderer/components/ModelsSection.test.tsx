import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { HostServicesProvider } from '@cpa/plugin-ui'
import type { HostServices, ModelCatalogEntry, ModelCatalogService, SettingsService } from '@cpa/plugin-api'
import { ModelsSection, DEFAULT_MODEL_SETTINGS } from './ModelsSection.js'

const testModels: readonly ModelCatalogEntry[] = [
    {
        id: 'test-model-pro',
        label: 'Test Model Pro',
        description: 'Pro model description',
        supportsFast: false,
        reasoningLevels: [
            { id: 'medium', requestValue: 'medium', labelKey: 'composer.reasoning.medium', fallbackLabel: 'Medium' },
        ],
        input: ['text'],
        contextWindow: 128_000,
        maxTokens: 16_384,
    },
    {
        id: 'test-model-fast',
        label: 'Test Model Fast',
        description: 'Fast model description',
        supportsFast: true,
        reasoningLevels: [],
        input: ['text'],
        contextWindow: 128_000,
        maxTokens: 16_384,
    },
    {
        id: 'test-model-reason',
        label: 'Test Model Reason',
        description: 'Reason model description',
        supportsFast: false,
        reasoningLevels: [
            { id: 'off', requestValue: 'off', labelKey: 'composer.reasoning.off', fallbackLabel: 'Off' },
            { id: 'low', requestValue: 'low', labelKey: 'composer.reasoning.low', fallbackLabel: 'Low' },
            { id: 'high', requestValue: 'high', labelKey: 'composer.reasoning.high', fallbackLabel: 'High' },
            { id: 'ultra', requestValue: 'ultra', labelKey: 'composer.reasoning.ultra', fallbackLabel: 'Ultra' },
        ],
        input: ['text'],
        contextWindow: 128_000,
        maxTokens: 16_384,
    },
]

describe('ModelsSection', () => {
    let mockSettings: any
    let mockSettingsService: SettingsService
    let mockModelsService: ModelCatalogService
    let listeners: Array<() => void>

    beforeEach(() => {
        listeners = []
        mockSettings = {
            modelSettings: {
                ...DEFAULT_MODEL_SETTINGS,
                enableAll: true,
                models: {},
            },
        }

        mockSettingsService = {
            getSnapshot: () => mockSettings,
            update: vi.fn().mockImplementation(async (partial) => {
                Object.assign(mockSettings, partial)
                listeners.forEach((l) => l())
            }),
            subscribe: vi.fn().mockImplementation((listener) => {
                listeners.push(listener)
                return () => {
                    listeners = listeners.filter((l) => l !== listener)
                }
            }),
        } as unknown as SettingsService

        mockModelsService = {
            getModels: () => testModels,
            getStatus: () => 'ready',
            getError: () => null,
            subscribe: () => () => {},
            refresh: async () => {},
        } as unknown as ModelCatalogService
    })

    function renderWithServices(ui: React.ReactElement) {
        const services = {
            settings: mockSettingsService,
            models: mockModelsService,
            modelCatalog: mockModelsService,
        } as unknown as HostServices

        return render(
            <HostServicesProvider services={services}>
                {ui}
            </HostServicesProvider>,
        )
    }

    it('renders section title and master switch', () => {
        renderWithServices(<ModelsSection />)

        expect(screen.getByRole('heading', { level: 1, name: /Models/i })).toBeInTheDocument()
        const masterSwitch = screen.getByRole('switch', {
            name: /Enable all models/i,
        })
        expect(masterSwitch).toBeInTheDocument()
        expect(masterSwitch).toHaveAttribute('aria-checked', 'true')
    })

    it('hides model list when master switch is enabled', () => {
        renderWithServices(<ModelsSection />)

        expect(screen.queryByText(/Model List/i)).not.toBeInTheDocument()
        expect(screen.queryByText('Test Model Pro')).not.toBeInTheDocument()
    })

    it('shows full model list with name, id, description, reasoning buttons, and toggle switch when master switch is disabled', () => {
        mockSettings.modelSettings.enableAll = false

        renderWithServices(<ModelsSection />)

        expect(screen.getByText(/Model List/i)).toBeInTheDocument()
        // Model name and ID
        expect(screen.getByText('Test Model Pro')).toBeInTheDocument()
        expect(screen.getByText('test-model-pro')).toBeInTheDocument()
        expect(screen.getByText('Test Model Fast')).toBeInTheDocument()
        expect(screen.getByText('test-model-fast')).toBeInTheDocument()
        expect(screen.getByText('Test Model Reason')).toBeInTheDocument()
        expect(screen.getByText('test-model-reason')).toBeInTheDocument()

        // Descriptions
        expect(screen.getByText('Pro model description')).toBeInTheDocument()

        // Model enable toggle switches
        const proToggle = screen.getByRole('switch', { name: /Test Model Pro/i })
        expect(proToggle).toBeInTheDocument()
        expect(proToggle).toHaveAttribute('aria-checked', 'true')
    })

    it('toggles master switch to show and hide model list', () => {
        renderWithServices(<ModelsSection />)

        const masterSwitch = screen.getByRole('switch', {
            name: /Enable all models/i,
        })
        expect(masterSwitch).toHaveAttribute('aria-checked', 'true')

        fireEvent.click(masterSwitch)

        expect(mockSettingsService.update).toHaveBeenCalledWith(
            expect.objectContaining({
                modelSettings: expect.objectContaining({ enableAll: false }),
            }),
        )
    })

    it('toggles model enabled state when clicking model switch', () => {
        mockSettings.modelSettings.enableAll = false

        renderWithServices(<ModelsSection />)

        const proToggle = screen.getByRole('switch', { name: /Test Model Pro/i })
        expect(proToggle).toHaveAttribute('aria-checked', 'true')

        fireEvent.click(proToggle)

        expect(mockSettingsService.update).toHaveBeenCalledWith(
            expect.objectContaining({
                modelSettings: expect.objectContaining({
                    models: expect.objectContaining({
                        'test-model-pro': expect.objectContaining({ enabled: false }),
                    }),
                }),
            }),
        )
    })

    it('hides ultra reasoning levels while showing every other catalog level', () => {
        mockSettings.modelSettings.enableAll = false

        renderWithServices(<ModelsSection />)

        expect(screen.getByRole('checkbox', { name: /Off/i })).toBeInTheDocument()
        expect(screen.getByRole('checkbox', { name: /Low/i })).toBeInTheDocument()
        expect(screen.getByRole('checkbox', { name: /High/i })).toBeInTheDocument()
        expect(screen.queryByRole('checkbox', { name: /^Ultra$/i })).not.toBeInTheDocument()
        expect(screen.queryByText('Ultra')).not.toBeInTheDocument()
    })

    it('toggles reasoning level when clicking reasoning checkbox button', () => {
        mockSettings.modelSettings.enableAll = false

        renderWithServices(<ModelsSection />)

        const lowButtons = screen.getAllByRole('checkbox', { name: /Low/i })
        expect(lowButtons[0]).toBeInTheDocument()

        fireEvent.click(lowButtons[0]!)

        expect(mockSettingsService.update).toHaveBeenCalled()
    })

    it('disables reasoning buttons when model is toggled off', () => {
        mockSettings.modelSettings.enableAll = false
        mockSettings.modelSettings.models = {
            'test-model-reason': { enabled: false },
        }

        renderWithServices(<ModelsSection />)

        const lowButtons = screen.getAllByRole('checkbox', { name: /Low/i })
        expect(lowButtons[0]).toBeDisabled()
    })

    it('reorders models when dragging and dropping a model row', () => {
        mockSettings.modelSettings.enableAll = false

        renderWithServices(<ModelsSection />)

        const rowFast = screen.getByTestId('model-row-test-model-fast')
        const rowPro = screen.getByTestId('model-row-test-model-pro')

        const mockDataTransfer = {
            setData: () => undefined,
            getData: () => 'test-model-fast',
            effectAllowed: 'none',
            dropEffect: 'none',
        }

        fireEvent.dragStart(rowFast, { dataTransfer: mockDataTransfer })
        fireEvent.dragOver(rowPro, { dataTransfer: mockDataTransfer })
        fireEvent.drop(rowPro, { dataTransfer: mockDataTransfer })
        fireEvent.dragEnd(rowFast)

        expect(mockSettingsService.update).toHaveBeenCalledWith(
            expect.objectContaining({
                modelSettings: expect.objectContaining({
                    modelOrder: ['test-model-fast', 'test-model-pro', 'test-model-reason'],
                }),
            }),
        )
    })
})
