import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DiscoveredGateway } from '@cpa/plugin-api'
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
        vi.restoreAllMocks()
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

    it('auto-triggers gateway discovery with 3000ms timeout on unconfigured mount', async () => {
        const discoverFn = vi.fn().mockResolvedValue([])
        render(<StartupSplashOverlay forceOpen discoverFn={discoverFn} />)

        expect(discoverFn).toHaveBeenCalledWith(3000)
    })

    it('renders discovered gateway selector, auto-selects first gateway, and updates baseUrl', async () => {
        const mockGateways: DiscoveredGateway[] = [
            {
                instanceName: 'Primary Gateway',
                host: '192.168.1.10',
                port: 8317,
                addresses: ['192.168.1.10'],
                primaryAddress: '192.168.1.10',
                baseUrl: 'http://192.168.1.10:8317',
                product: 'cliproxyapi',
                authRequired: true,
            },
            {
                instanceName: 'Secondary Gateway',
                host: '192.168.1.20',
                port: 8317,
                addresses: ['192.168.1.20'],
                primaryAddress: '192.168.1.20',
                baseUrl: 'http://192.168.1.20:8317',
                product: 'generic',
                authRequired: false,
            },
        ]

        let resolveDiscover!: (gws: DiscoveredGateway[]) => void
        const discoverFn = vi.fn().mockImplementation(
            () => new Promise<DiscoveredGateway[]>((resolve) => { resolveDiscover = resolve }),
        )

        render(<StartupSplashOverlay forceOpen discoverFn={discoverFn} />)

        // Initially scanning indicator is shown
        expect(screen.getByTestId('gateway-scanning-indicator')).toBeInTheDocument()

        // Resolve discovery
        await act(async () => {
            resolveDiscover(mockGateways)
        })

        // Config form reveal timer
        act(() => {
            vi.advanceTimersByTime(400)
        })

        // Gateway selector should be present
        const selector = screen.getByTestId('gateway-selector')
        expect(selector).toBeInTheDocument()
        expect(selector).toHaveTextContent('Primary Gateway')
        expect(selector).toHaveTextContent(/cliproxyapi/i)
        expect(selector).toHaveTextContent('Key Required')

        // baseUrl should be updated in settings store
        expect(useSettingsStore.getState().settings.cliProxyApi.baseUrl).toBe('http://192.168.1.10:8317')

        // Click selector to open dropdown menu
        fireEvent.click(selector)
        expect(screen.getByTestId('gateway-selector-menu')).toBeInTheDocument()

        // Select secondary gateway
        const option1 = screen.getByTestId('gateway-option-1')
        expect(option1).toHaveTextContent('Secondary Gateway')
        expect(option1).toHaveTextContent('No Auth')

        fireEvent.click(option1)

        // Should update selection and baseUrl in settings store
        expect(selector).toHaveTextContent('Secondary Gateway')
        expect(useSettingsStore.getState().settings.cliProxyApi.baseUrl).toBe('http://192.168.1.20:8317')
    })

    it('selecting manual input reveals manual input field and allows typing custom baseUrl', async () => {
        const mockGateways: DiscoveredGateway[] = [
            {
                instanceName: 'Primary Gateway',
                host: '192.168.1.10',
                port: 8317,
                addresses: ['192.168.1.10'],
                primaryAddress: '192.168.1.10',
                baseUrl: 'http://192.168.1.10:8317',
                product: 'cliproxyapi',
                authRequired: true,
            },
        ]

        const discoverFn = vi.fn().mockResolvedValue(mockGateways)
        render(<StartupSplashOverlay forceOpen discoverFn={discoverFn} />)

        await act(async () => {
            vi.advanceTimersByTime(400)
        })

        // When gateway is selected, manual input is not rendered
        expect(screen.queryByTestId('startup-base-url-input')).not.toBeInTheDocument()

        // Open dropdown and select manual input option
        fireEvent.click(screen.getByTestId('gateway-selector'))
        fireEvent.click(screen.getByTestId('gateway-option-manual'))

        // Manual input field should now be rendered
        const manualInput = screen.getByTestId('startup-base-url-input')
        expect(manualInput).toBeInTheDocument()

        // Can change value
        fireEvent.change(manualInput, { target: { value: 'http://custom-host:9000' } })
        expect(useSettingsStore.getState().settings.cliProxyApi.baseUrl).toBe('http://custom-host:9000')
    })

    it('shows manual input with no-gateways notice and rescan button when 0 gateways found', async () => {
        const discoverFn = vi.fn().mockResolvedValue([])
        render(<StartupSplashOverlay forceOpen discoverFn={discoverFn} />)

        await act(async () => {
            vi.advanceTimersByTime(400)
        })

        // Manual input is visible
        expect(screen.getByTestId('startup-base-url-input')).toBeInTheDocument()
        // Subtle notice is displayed
        expect(screen.getByTestId('gateway-not-found-notice')).toHaveTextContent('No AI Gateways found on LAN')
        // Rescan button is present
        expect(screen.getByTestId('gateway-rescan-btn')).toHaveTextContent('Rescan')
    })

    it('rescan button triggers a new discovery scan', async () => {
        const discoverFn = vi.fn().mockResolvedValue([])
        render(<StartupSplashOverlay forceOpen discoverFn={discoverFn} />)

        await act(async () => {
            vi.advanceTimersByTime(400)
        })

        expect(discoverFn).toHaveBeenCalledTimes(1)

        const rescanBtn = screen.getByTestId('gateway-rescan-btn')
        await act(async () => {
            fireEvent.click(rescanBtn)
        })

        expect(discoverFn).toHaveBeenCalledTimes(2)
    })

    it('preserves manual address input when discovery results arrive late after user edits', async () => {
        let resolveDiscover!: (gws: DiscoveredGateway[]) => void
        const discoverFn = vi.fn().mockImplementation(
            () => new Promise<DiscoveredGateway[]>((resolve) => { resolveDiscover = resolve }),
        )

        render(<StartupSplashOverlay forceOpen discoverFn={discoverFn} />)

        // Wait for config form to reveal
        act(() => {
            vi.advanceTimersByTime(400)
        })

        // User edits the address while discovery is still pending
        const addressInput = screen.getByTestId('startup-base-url-input')
        fireEvent.change(addressInput, { target: { value: 'http://custom-proxy.local:9999' } })

        expect(useSettingsStore.getState().settings.cliProxyApi.baseUrl).toBe('http://custom-proxy.local:9999')

        // Late-arriving discovery results with discovered gateways
        const mockGateways: DiscoveredGateway[] = [
            {
                instanceName: 'Discovered Gateway',
                host: '192.168.1.100',
                port: 8317,
                addresses: ['192.168.1.100'],
                primaryAddress: '192.168.1.100',
                baseUrl: 'http://192.168.1.100:8317',
                product: 'cliproxyapi',
                authRequired: true,
            },
        ]

        await act(async () => {
            resolveDiscover(mockGateways)
        })

        // Advance timers to allow any effects to settle
        act(() => {
            vi.advanceTimersByTime(200)
        })

        // Manual address must NOT have been overwritten by http://192.168.1.100:8317
        const currentAddressInput = screen.getByTestId('startup-base-url-input')
        expect(currentAddressInput).toBeInTheDocument()
        expect(currentAddressInput).toHaveValue('http://custom-proxy.local:9999')
        expect(useSettingsStore.getState().settings.cliProxyApi.baseUrl).toBe('http://custom-proxy.local:9999')

        // Gateway selector displays manual input option
        const selector = screen.getByTestId('gateway-selector')
        expect(selector).toHaveTextContent('Manual address input...')
    })

    it('submitting a no-auth gateway without entering an API key succeeds, sets a valid non-empty apiKey, and keeps isConfigured true on remount', async () => {
        const mockGateways: DiscoveredGateway[] = [
            {
                instanceName: 'Open Gateway',
                host: '192.168.1.80',
                port: 8317,
                addresses: ['192.168.1.80'],
                primaryAddress: '192.168.1.80',
                baseUrl: 'http://192.168.1.80:8317',
                product: 'generic',
                authRequired: false,
            },
        ]

        const refreshSpy = vi
            .spyOn(modelCatalogService, 'refreshModelCatalog')
            .mockImplementation(async () => {
                useModelCatalogStore.setState({ status: 'ready', error: null })
            })

        const discoverFn = vi.fn().mockResolvedValue(mockGateways)
        const { unmount } = render(<StartupSplashOverlay forceOpen discoverFn={discoverFn} />)

        await act(async () => {
            vi.advanceTimersByTime(400)
        })

        // API key input has optional placeholder
        expect(screen.getByTestId('startup-api-key-input')).toHaveAttribute(
            'placeholder',
            'API Key is optional for this gateway',
        )

        // Submitting with empty API key should succeed because authRequired is false
        const submitBtn = screen.getByTestId('startup-save-connect-btn')
        await act(async () => {
            fireEvent.click(submitBtn)
        })

        expect(screen.queryByTestId('startup-error-banner')).not.toBeInTheDocument()
        // refreshModelCatalog must be called with a non-empty fallback apiKey ('no-auth')
        expect(refreshSpy).toHaveBeenCalledWith({
            baseUrl: 'http://192.168.1.80:8317',
            apiKey: 'no-auth',
        })

        // Settings store has non-empty apiKey
        const savedSettings = useSettingsStore.getState().settings.cliProxyApi
        expect(savedSettings.baseUrl).toBe('http://192.168.1.80:8317')
        expect(savedSettings.apiKey).toBe('no-auth')

        // Verify isConfigured invariant: both baseUrl and apiKey must be non-empty strings
        const isConfigured = Boolean(savedSettings.baseUrl.trim() && savedSettings.apiKey.trim())
        expect(isConfigured).toBe(true)

        unmount()

        // Remounting StartupSplashOverlay when configured and catalog is ready auto-dismisses
        const onDismiss = vi.fn()
        render(<StartupSplashOverlay onDismiss={onDismiss} />)

        act(() => {
            vi.advanceTimersByTime(1000)
        })

        expect(onDismiss).toHaveBeenCalled()
    })

    it('supports keyboard navigation for gateway selector: Escape closes, Enter/Space selects, ArrowUp/ArrowDown navigates', async () => {
        const mockGateways: DiscoveredGateway[] = [
            {
                instanceName: 'Gateway One',
                host: '192.168.1.10',
                port: 8317,
                addresses: ['192.168.1.10'],
                primaryAddress: '192.168.1.10',
                baseUrl: 'http://192.168.1.10:8317',
                product: 'cliproxyapi',
                authRequired: true,
            },
            {
                instanceName: 'Gateway Two',
                host: '192.168.1.20',
                port: 8317,
                addresses: ['192.168.1.20'],
                primaryAddress: '192.168.1.20',
                baseUrl: 'http://192.168.1.20:8317',
                product: 'generic',
                authRequired: false,
            },
        ]

        const discoverFn = vi.fn().mockResolvedValue(mockGateways)
        render(<StartupSplashOverlay forceOpen discoverFn={discoverFn} />)

        await act(async () => {
            vi.advanceTimersByTime(400)
        })

        const selector = screen.getByTestId('gateway-selector')
        expect(selector).toBeInTheDocument()

        // 1. ArrowDown opens the dropdown
        fireEvent.keyDown(selector, { key: 'ArrowDown' })
        expect(screen.getByTestId('gateway-selector-menu')).toBeInTheDocument()

        // 2. Escape closes the dropdown
        fireEvent.keyDown(selector, { key: 'Escape' })
        expect(screen.queryByTestId('gateway-selector-menu')).not.toBeInTheDocument()

        // 3. ArrowDown reopens
        fireEvent.keyDown(selector, { key: 'ArrowDown' })
        expect(screen.getByTestId('gateway-selector-menu')).toBeInTheDocument()

        // Option 0 (Gateway One) was selected. Press ArrowDown to move highlight to Option 1 (Gateway Two)
        fireEvent.keyDown(selector, { key: 'ArrowDown' })
        const option1 = screen.getByTestId('gateway-option-1')
        expect(option1).toHaveAttribute('data-highlighted', 'true')

        // 4. Enter selects Option 1 (Gateway Two)
        fireEvent.keyDown(selector, { key: 'Enter' })
        expect(screen.queryByTestId('gateway-selector-menu')).not.toBeInTheDocument()
        expect(selector).toHaveTextContent('Gateway Two')
        expect(useSettingsStore.getState().settings.cliProxyApi.baseUrl).toBe('http://192.168.1.20:8317')

        // 5. ArrowDown reopens, navigate to manual option with ArrowDown, and verify ArrowUp wraps/moves up
        fireEvent.keyDown(selector, { key: 'ArrowDown' })
        fireEvent.keyDown(selector, { key: 'ArrowDown' })
        const manualOption = screen.getByTestId('gateway-option-manual')
        expect(manualOption).toHaveAttribute('data-highlighted', 'true')

        // ArrowUp moves highlight back to Option 1
        fireEvent.keyDown(selector, { key: 'ArrowUp' })
        expect(screen.getByTestId('gateway-option-1')).toHaveAttribute('data-highlighted', 'true')

        // ArrowDown moves back to manual option
        fireEvent.keyDown(selector, { key: 'ArrowDown' })
        expect(manualOption).toHaveAttribute('data-highlighted', 'true')

        // Space selects manual option
        fireEvent.keyDown(selector, { key: ' ' })
        expect(screen.queryByTestId('gateway-selector-menu')).not.toBeInTheDocument()
        expect(selector).toHaveTextContent('Manual address input...')
        expect(screen.getByTestId('startup-base-url-input')).toBeInTheDocument()
    })

    it('renders dropdown portaled to document.body with fixed z-[10001] and overflow-y-auto', async () => {
        const mockGateways: DiscoveredGateway[] = [
            {
                instanceName: 'Primary Gateway',
                host: '192.168.1.10',
                port: 8317,
                addresses: ['192.168.1.10'],
                primaryAddress: '192.168.1.10',
                baseUrl: 'http://192.168.1.10:8317',
                product: 'cliproxyapi',
                authRequired: true,
            },
        ]

        const discoverFn = vi.fn().mockResolvedValue(mockGateways)
        render(<StartupSplashOverlay forceOpen discoverFn={discoverFn} />)

        await act(async () => {
            vi.advanceTimersByTime(400)
        })

        const selector = screen.getByTestId('gateway-selector')
        fireEvent.click(selector)

        const menu = screen.getByTestId('gateway-selector-menu')
        expect(menu).toBeInTheDocument()
        expect(menu.parentElement).toBe(document.body)
        expect(menu.className).toContain('fixed')
        expect(menu.className).toContain('z-[10001]')
        expect(menu.className).toContain('overflow-y-auto')
    })

    it('positions dropdown downward when space below is sufficient and flips upward when space below is constrained', async () => {
        const mockGateways: DiscoveredGateway[] = [
            {
                instanceName: 'Primary Gateway',
                host: '192.168.1.10',
                port: 8317,
                addresses: ['192.168.1.10'],
                primaryAddress: '192.168.1.10',
                baseUrl: 'http://192.168.1.10:8317',
                product: 'cliproxyapi',
                authRequired: true,
            },
        ]

        const discoverFn = vi.fn().mockResolvedValue(mockGateways)

        // Scenario 1: Downward positioning (spaceBelow >= 160)
        // window.innerHeight = 600, innerWidth = 1000
        // trigger: top = 200, bottom = 240, left = 100, width = 360
        // spaceBelow = 600 - 240 - 16 = 344 (>= 160)
        // top = 240 + 6 = 246px, bottom = undefined
        // maxHeight = Math.min(320, 344) = 320px
        Object.defineProperty(window, 'innerHeight', { value: 600, configurable: true })
        Object.defineProperty(window, 'innerWidth', { value: 1000, configurable: true })
        vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
            if (this.getAttribute('data-testid') === 'gateway-selector') {
                return {
                    top: 200,
                    bottom: 240,
                    left: 100,
                    right: 460,
                    width: 360,
                    height: 40,
                } as DOMRect
            }
            return { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 } as DOMRect
        })

        const { unmount } = render(<StartupSplashOverlay forceOpen discoverFn={discoverFn} />)

        await act(async () => {
            vi.advanceTimersByTime(400)
        })

        const selector = screen.getByTestId('gateway-selector')
        fireEvent.click(selector)

        const menu = screen.getByTestId('gateway-selector-menu')
        expect(menu.style.top).toBe('246px')
        expect(menu.style.bottom).toBe('')
        expect(menu.style.left).toBe('100px')
        expect(menu.style.width).toBe('360px')
        expect(menu.style.maxHeight).toBe('320px')

        unmount()

        // Scenario 2: Flip upward (spaceBelow < 160 && spaceAbove > spaceBelow)
        // trigger: top = 500, bottom = 540, left = 100, width = 360
        // spaceBelow = 600 - 540 - 16 = 44 (< 160)
        // spaceAbove = 500 - 16 = 484 (> 44)
        // bottom = 600 - 500 + 6 = 106px, top = undefined
        // maxHeight = Math.min(320, 484) = 320px
        vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
            if (this.getAttribute('data-testid') === 'gateway-selector') {
                return {
                    top: 500,
                    bottom: 540,
                    left: 100,
                    right: 460,
                    width: 360,
                    height: 40,
                } as DOMRect
            }
            return { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 } as DOMRect
        })

        render(<StartupSplashOverlay forceOpen discoverFn={discoverFn} />)

        await act(async () => {
            vi.advanceTimersByTime(400)
        })

        const flippedSelector = screen.getByTestId('gateway-selector')
        fireEvent.click(flippedSelector)

        const flippedMenu = screen.getByTestId('gateway-selector-menu')
        expect(flippedMenu.style.bottom).toBe('106px')
        expect(flippedMenu.style.top).toBe('')
        expect(flippedMenu.style.left).toBe('100px')
        expect(flippedMenu.style.maxHeight).toBe('320px')
    })

    it('closes dropdown on click outside, Tab, and Escape, and updates position on window resize/scroll', async () => {
        const mockGateways: DiscoveredGateway[] = [
            {
                instanceName: 'Primary Gateway',
                host: '192.168.1.10',
                port: 8317,
                addresses: ['192.168.1.10'],
                primaryAddress: '192.168.1.10',
                baseUrl: 'http://192.168.1.10:8317',
                product: 'cliproxyapi',
                authRequired: true,
            },
        ]

        let triggerLeft = 100
        Object.defineProperty(window, 'innerHeight', { value: 600, configurable: true })
        Object.defineProperty(window, 'innerWidth', { value: 1000, configurable: true })
        vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
            if (this.getAttribute('data-testid') === 'gateway-selector') {
                return {
                    top: 200,
                    bottom: 240,
                    left: triggerLeft,
                    right: triggerLeft + 360,
                    width: 360,
                    height: 40,
                } as DOMRect
            }
            return { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 } as DOMRect
        })

        const discoverFn = vi.fn().mockResolvedValue(mockGateways)
        render(<StartupSplashOverlay forceOpen discoverFn={discoverFn} />)

        await act(async () => {
            vi.advanceTimersByTime(400)
        })

        const selector = screen.getByTestId('gateway-selector')

        // 1. Open and close via click outside (mousedown on document body)
        fireEvent.click(selector)
        expect(screen.getByTestId('gateway-selector-menu')).toBeInTheDocument()

        fireEvent.mouseDown(document.body)
        expect(screen.queryByTestId('gateway-selector-menu')).not.toBeInTheDocument()

        // 2. Open and close via Tab
        fireEvent.click(selector)
        expect(screen.getByTestId('gateway-selector-menu')).toBeInTheDocument()

        fireEvent.keyDown(document, { key: 'Tab' })
        expect(screen.queryByTestId('gateway-selector-menu')).not.toBeInTheDocument()

        // 3. Open and close via Escape
        fireEvent.click(selector)
        expect(screen.getByTestId('gateway-selector-menu')).toBeInTheDocument()

        fireEvent.keyDown(document, { key: 'Escape' })
        expect(screen.queryByTestId('gateway-selector-menu')).not.toBeInTheDocument()

        // 4. Open, resize window, and verify position updates
        fireEvent.click(selector)
        const menu = screen.getByTestId('gateway-selector-menu')
        expect(menu.style.left).toBe('100px')

        // Shift trigger rect and trigger window resize
        triggerLeft = 200
        fireEvent(window, new Event('resize'))
        expect(menu.style.left).toBe('200px')

        // Shift trigger rect and trigger window scroll
        triggerLeft = 300
        fireEvent(window, new Event('scroll'))
        expect(menu.style.left).toBe('300px')
    })
})
