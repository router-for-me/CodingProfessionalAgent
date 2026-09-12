import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '@/i18n'
import { useSettingsStore } from '@/stores/settingsStore'
import { useModelCatalogStore } from '@/stores/modelCatalogStore'
import * as modelCatalogService from '@/features/models/modelCatalogService'
import { StartupSplashOverlay } from './StartupSplashOverlay'

describe('StartupSplashOverlay', () => {
    beforeEach(async () => {
        await i18n.changeLanguage('en')
        vi.useFakeTimers({ shouldAdvanceTime: true })
        useSettingsStore.setState({
            settings: {
                ...useSettingsStore.getState().settings,
                cliProxyApi: { baseUrl: '', apiKey: '' },
            },
        })
        useModelCatalogStore.setState({
            status: 'idle',
            error: null,
            models: [],
        })
    })

    afterEach(() => {
        vi.useRealTimers()
    })

    it('renders splash overlay and transitions to config mode when cliProxyApi is not configured', async () => {
        render(<StartupSplashOverlay forceOpen />)

        expect(screen.getByTestId('startup-splash-overlay')).toBeInTheDocument()
        expect(screen.getByTestId('startup-splash-title')).toHaveTextContent(
            'Coding Professional Agent',
        )

        // Advance timer for smooth initial reveal of config form
        act(() => {
            vi.advanceTimersByTime(400)
        })

        expect(screen.getByTestId('startup-config-form')).toBeInTheDocument()
        expect(screen.getByTestId('startup-base-url-input')).toHaveValue(
            'http://127.0.0.1:8317',
        )
        expect(screen.getByTestId('startup-api-key-input')).toHaveValue('')
    })

    it('immediately synchronizes inputs to settings store as user types', async () => {
        render(<StartupSplashOverlay forceOpen />)

        act(() => {
            vi.advanceTimersByTime(400)
        })

        const baseUrlInput = screen.getByTestId('startup-base-url-input')
        fireEvent.change(baseUrlInput, { target: { value: 'http://127.0.0.1:9999' } })

        const apiKeyInput = screen.getByTestId('startup-api-key-input')
        fireEvent.change(apiKeyInput, { target: { value: 'sk-instant-sync-key' } })

        expect(useSettingsStore.getState().settings.cliProxyApi).toEqual({
            baseUrl: 'http://127.0.0.1:9999',
            apiKey: 'sk-instant-sync-key',
        })
    })

    it('shows validation error when submitting with empty API key', async () => {
        render(<StartupSplashOverlay forceOpen />)

        act(() => {
            vi.advanceTimersByTime(400)
        })

        const submitBtn = screen.getByTestId('startup-save-connect-btn')
        fireEvent.click(submitBtn)

        expect(screen.getByTestId('startup-error-banner')).toBeInTheDocument()
        expect(screen.getByTestId('startup-error-banner')).toHaveTextContent(
            'Please enter an API key',
        )
        expect(screen.getByRole('alert')).toHaveAttribute('id', 'startup-config-error')
        expect(screen.getByTestId('startup-config-form')).toHaveAttribute(
            'aria-describedby', 'startup-config-error',
        )
        expect(screen.getByTestId('startup-api-key-input')).toHaveFocus()
    })

    it('submits valid configuration, refreshes model catalog, and dismisses on success', async () => {
        const refreshSpy = vi
            .spyOn(modelCatalogService, 'refreshModelCatalog')
            .mockImplementation(async () => {
                useModelCatalogStore.setState({ status: 'ready', error: null })
            })

        const onDismiss = vi.fn()
        render(<StartupSplashOverlay onDismiss={onDismiss} />)

        act(() => {
            vi.advanceTimersByTime(400)
        })

        const apiKeyInput = screen.getByTestId('startup-api-key-input')
        act(() => {
            fireEvent.change(apiKeyInput, { target: { value: 'sk-test-key-123' } })
        })

        const submitBtn = screen.getByTestId('startup-save-connect-btn')
        await act(async () => {
            fireEvent.click(submitBtn)
        })

        expect(useSettingsStore.getState().settings.cliProxyApi).toEqual({
            baseUrl: 'http://127.0.0.1:8317',
            apiKey: 'sk-test-key-123',
        })
        expect(refreshSpy).toHaveBeenCalledWith({
            baseUrl: 'http://127.0.0.1:8317',
            apiKey: 'sk-test-key-123',
        })

        // Advance timers for success state and fade out
        act(() => {
            vi.advanceTimersByTime(1200)
        })

        expect(onDismiss).toHaveBeenCalled()
    })

    it('reveals config form with error message when model loading fails', async () => {
        useSettingsStore.setState({
            settings: {
                ...useSettingsStore.getState().settings,
                cliProxyApi: {
                    baseUrl: 'http://127.0.0.1:8317',
                    apiKey: 'invalid-key',
                },
            },
        })
        useModelCatalogStore.setState({
            status: 'error',
            error: 'Connection refused: 127.0.0.1:8317',
        })

        render(<StartupSplashOverlay forceOpen />)

        expect(screen.getByTestId('startup-config-form')).toBeInTheDocument()
        expect(screen.getByTestId('startup-error-banner')).toHaveTextContent(
            'Failed to load model catalog due to invalid configuration. Please check the CLIProxyAPI Base URL and API key and reconfigure. (Connection refused: 127.0.0.1:8317)',
        )
        expect(screen.getByTestId('startup-base-url-input')).toHaveValue(
            'http://127.0.0.1:8317',
        )
        expect(screen.getByTestId('startup-api-key-input')).toHaveValue(
            'invalid-key',
        )
    })

    it('requires reconfiguration and stays on config form when model refresh fails on submit', async () => {
        vi.spyOn(modelCatalogService, 'refreshModelCatalog').mockImplementation(
            async () => {
                useModelCatalogStore.setState({
                    status: 'error',
                    error: 'Unauthorized 401: Invalid API key',
                })
            },
        )

        const onDismiss = vi.fn()
        render(<StartupSplashOverlay onDismiss={onDismiss} />)

        act(() => {
            vi.advanceTimersByTime(400)
        })

        const apiKeyInput = screen.getByTestId('startup-api-key-input')
        act(() => {
            fireEvent.change(apiKeyInput, { target: { value: 'bad-key' } })
        })

        const submitBtn = screen.getByTestId('startup-save-connect-btn')
        await act(async () => {
            fireEvent.click(submitBtn)
        })

        expect(screen.getByTestId('startup-error-banner')).toBeInTheDocument()
        expect(screen.getByTestId('startup-error-banner')).toHaveTextContent(
            'Failed to load model catalog due to invalid configuration. Please check the CLIProxyAPI Base URL and API key and reconfigure. (Unauthorized 401: Invalid API key)',
        )
        expect(onDismiss).not.toHaveBeenCalled()
    })

    it('toggles password visibility with eye button', async () => {
        render(<StartupSplashOverlay forceOpen />)

        act(() => {
            vi.advanceTimersByTime(400)
        })

        const apiKeyInput = screen.getByTestId('startup-api-key-input')
        expect(apiKeyInput).toHaveAttribute('type', 'password')

        const toggleBtn = screen.getByRole('button', { name: /show api key/i })
        expect(toggleBtn).toHaveAttribute('aria-controls', 'startup-api-key')
        expect(toggleBtn).toHaveAttribute('aria-pressed', 'false')
        fireEvent.click(toggleBtn)

        expect(apiKeyInput).toHaveAttribute('type', 'text')
        expect(toggleBtn).toHaveAttribute('aria-pressed', 'true')

        const hideBtn = screen.getByRole('button', { name: /hide api key/i })
        fireEvent.click(hideBtn)

        expect(apiKeyInput).toHaveAttribute('type', 'password')
    })

    it('localizes visibility controls and keeps inputs associated with their labels', async () => {
        await i18n.changeLanguage('zh-CN')
        render(<StartupSplashOverlay forceOpen />)

        expect(screen.getByLabelText('CLIProxyAPI 服务地址')).toHaveAttribute('inputmode', 'url')
        expect(screen.getByLabelText('API 密钥')).toHaveAttribute('spellcheck', 'false')
        fireEvent.click(screen.getByRole('button', { name: '显示 API 密钥' }))
        expect(screen.getByRole('button', { name: '隐藏 API 密钥' })).toHaveAttribute('aria-pressed', 'true')
    })

    it('shows a busy, disabled connection button while the request is pending', async () => {
        let finishRequest!: () => void
        vi.spyOn(modelCatalogService, 'refreshModelCatalog').mockImplementation(
            () => new Promise<void>((resolve) => { finishRequest = resolve }),
        )
        render(<StartupSplashOverlay forceOpen />)
        fireEvent.change(screen.getByTestId('startup-api-key-input'), {
            target: { value: 'test-key' },
        })
        await act(async () => {
            fireEvent.submit(screen.getByTestId('startup-config-form'))
        })

        expect(screen.getByTestId('startup-config-form')).toHaveAttribute('aria-busy', 'true')
        expect(screen.getByTestId('startup-save-connect-btn')).toBeDisabled()
        expect(screen.getByTestId('startup-save-connect-btn')).toHaveTextContent('Connecting')

        await act(async () => {
            useModelCatalogStore.setState({ status: 'ready', error: null })
            finishRequest()
        })
        expect(screen.getByTestId('startup-config-form')).toHaveAttribute('aria-busy', 'false')
        expect(screen.getByTestId('startup-save-connect-btn')).toHaveAttribute('data-success', 'true')
    })

    it('renders CLIProxyAPI service address label and does not render subtitle', async () => {
        render(<StartupSplashOverlay forceOpen />)

        act(() => {
            vi.advanceTimersByTime(400)
        })

        expect(screen.getByText('CLIProxyAPI Base URL')).toBeInTheDocument()
        expect(
            screen.queryByText('Please configure CLIProxyAPI service to get started'),
        ).not.toBeInTheDocument()
    })

    it('auto-dismisses when configured and model catalog is ready', async () => {
        useSettingsStore.setState({
            settings: {
                ...useSettingsStore.getState().settings,
                cliProxyApi: {
                    baseUrl: 'http://127.0.0.1:8317',
                    apiKey: 'valid-key',
                },
            },
        })
        useModelCatalogStore.setState({
            status: 'ready',
            error: null,
            models: [
                {
                    id: 'gpt-4o',
                    label: 'GPT-4o',
                    supportsFast: false,
                    reasoningLevels: [],
                    input: ['text'],
                    contextWindow: 128000,
                    maxTokens: 16384,
                },
            ],
        })

        const onDismiss = vi.fn()
        render(<StartupSplashOverlay onDismiss={onDismiss} />)

        act(() => {
            vi.advanceTimersByTime(1000)
        })

        expect(onDismiss).toHaveBeenCalled()
    })
})
