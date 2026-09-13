import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '@/i18n'
import { DEFAULT_SETTINGS } from '@/types/models'
import { useSettingsStore } from '@/stores/settingsStore'
import { HostServicesProvider } from '@cpa/plugin-ui'
import { createHostServices, setHostServices } from '@/application/services/createHostServices'
import type {
    DiscoveredGateway,
    GatewayDiscoveryService,
    HostServices,
    WebServerService,
    WebServerStatus,
} from '@cpa/plugin-api'
import { ConnectionsSection } from './ConnectionsSection.js'

function resetSettings(): void {
    useSettingsStore.setState({
        settings: {
            ...DEFAULT_SETTINGS,
            cliProxyApi: { ...DEFAULT_SETTINGS.cliProxyApi },
            webServer: { ...DEFAULT_SETTINGS.webServer! },
        },
    })
    void i18n.changeLanguage('en')
}

describe('ConnectionsSection', () => {
    const originalUserAgent = navigator.userAgent
    const originalInnerWidth = window.innerWidth
    const originalInnerHeight = window.innerHeight
    let mockWebServer: {
        getStatus: ReturnType<typeof vi.fn>
        start: ReturnType<typeof vi.fn>
        stop: ReturnType<typeof vi.fn>
    }
    let mockGatewayDiscovery: {
        discover: ReturnType<typeof vi.fn>
    }
    let hostServices: HostServices

    beforeEach(() => {
        vi.restoreAllMocks()
        resetSettings()

        Object.defineProperty(navigator, 'userAgent', {
            value: `${originalUserAgent} Electron/30.0.0`,
            configurable: true,
        })

        mockWebServer = {
            getStatus: vi.fn().mockResolvedValue({
                running: false,
                host: '127.0.0.1',
                port: 18080,
                url: '',
            }),
            start: vi.fn().mockImplementation(async (cfg) => ({
                running: true,
                host: cfg?.host || '127.0.0.1',
                port: cfg?.port || 18080,
                url: `http://${cfg?.host || '127.0.0.1'}:${cfg?.port || 18080}`,
            })),
            stop: vi.fn().mockResolvedValue({
                running: false,
                host: '127.0.0.1',
                port: 18080,
                url: '',
            }),
        }

        mockGatewayDiscovery = {
            discover: vi.fn().mockResolvedValue([]),
        }

        hostServices = createHostServices()
        hostServices.webServer = mockWebServer as unknown as WebServerService
        hostServices.gatewayDiscovery = mockGatewayDiscovery as unknown as GatewayDiscoveryService
        setHostServices(hostServices)
    })

    afterEach(() => {
        Object.defineProperty(navigator, 'userAgent', {
            value: originalUserAgent,
            configurable: true,
        })
        Object.defineProperty(window, 'innerWidth', {
            value: originalInnerWidth,
            configurable: true,
        })
        Object.defineProperty(window, 'innerHeight', {
            value: originalInnerHeight,
            configurable: true,
        })
    })

    const renderWithServices = () =>
        render(
            <HostServicesProvider services={hostServices}>
                <ConnectionsSection />
            </HostServicesProvider>,
        )

    it('shows the stored base URL', () => {
        useSettingsStore.getState().setCliProxyApi({
            baseUrl: 'http://127.0.0.1:8317',
        })

        renderWithServices()

        expect(screen.getByRole('textbox', { name: 'Base URL' })).toHaveValue(
            'http://127.0.0.1:8317',
        )
    })

    it('renders the API key as a password input', () => {
        renderWithServices()

        expect(screen.getByLabelText('API key')).toHaveAttribute('type', 'password')
    })

    it('uses the matching setter for each connection field', () => {
        const setCliProxyApi = vi.spyOn(
            useSettingsStore.getState(),
            'setCliProxyApi',
        )
        renderWithServices()

        fireEvent.change(screen.getByRole('textbox', { name: 'Base URL' }), {
            target: { value: 'http://localhost:8317' },
        })
        fireEvent.change(screen.getByLabelText('API key'), {
            target: { value: 'secret-key' },
        })

        expect(setCliProxyApi).toHaveBeenNthCalledWith(1, {
            baseUrl: 'http://localhost:8317',
        })
        expect(setCliProxyApi).toHaveBeenNthCalledWith(2, {
            apiKey: 'secret-key',
        })
    })

    it('does not render the API key in labels, descriptions, or errors', () => {
        useSettingsStore.getState().setCliProxyApi({ apiKey: 'secret-key' })

        renderWithServices()

        expect(document.body.textContent).not.toContain('secret-key')
    })

    it('renders Web Server settings and starts server on toggle enable', async () => {
        const setWebServer = vi.spyOn(useSettingsStore.getState(), 'setWebServer')
        renderWithServices()

        expect(screen.getByText('Web Server')).toBeInTheDocument()
        const toggle = screen.getByRole('switch', { name: 'Enable Web Server' })
        expect(toggle).toBeInTheDocument()
        expect(toggle).toHaveAttribute('aria-checked', 'false')

        fireEvent.click(toggle)

        expect(setWebServer).toHaveBeenCalledWith({ enabled: true })
        expect(mockWebServer.start).toHaveBeenCalledWith({
            host: '127.0.0.1',
            port: 18080,
            password: '',
        })

        await waitFor(() => {
            expect(screen.getByText('Open in Browser')).toBeInTheDocument()
            expect(screen.getByText('Copy Link')).toBeInTheDocument()
        })
    })

    it('turns off enable switch, stops web server, and saves host in real-time without confirm button when host is modified', async () => {
        const setWebServer = vi.spyOn(useSettingsStore.getState(), 'setWebServer')
        mockWebServer.getStatus.mockResolvedValueOnce({
            running: true,
            host: '127.0.0.1',
            port: 18080,
            url: 'http://127.0.0.1:18080',
        })
        useSettingsStore.setState({
            settings: {
                ...DEFAULT_SETTINGS,
                webServer: { enabled: true, host: '127.0.0.1', port: 18080, password: '' },
            },
        })
        renderWithServices()

        await waitFor(() => {
            expect(screen.getByRole('switch', { name: 'Enable Web Server' })).toHaveAttribute(
                'aria-checked',
                'true',
            )
        })

        // Confirm and cancel buttons should not exist
        expect(screen.queryByRole('button', { name: 'Confirm' })).not.toBeInTheDocument()
        expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument()

        const hostInput = screen.getByRole('textbox', { name: 'Binding IP' })
        fireEvent.change(hostInput, { target: { value: '0.0.0.0' } })

        expect(setWebServer).toHaveBeenCalledWith({ host: '0.0.0.0', enabled: false })
        await waitFor(() => {
            expect(screen.getByRole('switch', { name: 'Enable Web Server' })).toHaveAttribute(
                'aria-checked',
                'false',
            )
            expect(mockWebServer.stop).toHaveBeenCalled()
        })
        expect(screen.queryByRole('button', { name: 'Confirm' })).not.toBeInTheDocument()
    })

    it('turns off enable switch, stops web server, and saves port in real-time without confirm button when port is modified', async () => {
        const setWebServer = vi.spyOn(useSettingsStore.getState(), 'setWebServer')
        mockWebServer.getStatus.mockResolvedValueOnce({
            running: true,
            host: '127.0.0.1',
            port: 18080,
            url: 'http://127.0.0.1:18080',
        })
        useSettingsStore.setState({
            settings: {
                ...DEFAULT_SETTINGS,
                webServer: { enabled: true, host: '127.0.0.1', port: 18080, password: '' },
            },
        })
        renderWithServices()

        await waitFor(() => {
            expect(screen.getByRole('switch', { name: 'Enable Web Server' })).toHaveAttribute(
                'aria-checked',
                'true',
            )
        })

        const portInput = screen.getByRole('spinbutton', { name: 'Port' })
        fireEvent.change(portInput, { target: { value: '8888' } })

        expect(setWebServer).toHaveBeenCalledWith({ port: 8888, enabled: false })
        await waitFor(() => {
            expect(screen.getByRole('switch', { name: 'Enable Web Server' })).toHaveAttribute(
                'aria-checked',
                'false',
            )
            expect(mockWebServer.stop).toHaveBeenCalled()
        })
        expect(screen.queryByRole('button', { name: 'Confirm' })).not.toBeInTheDocument()
    })

    it('turns off enable switch, stops web server, and saves password in real-time without confirm button when password is modified', async () => {
        const setWebServer = vi.spyOn(useSettingsStore.getState(), 'setWebServer')
        mockWebServer.getStatus.mockResolvedValueOnce({
            running: true,
            host: '127.0.0.1',
            port: 18080,
            url: 'http://127.0.0.1:18080',
        })
        useSettingsStore.setState({
            settings: {
                ...DEFAULT_SETTINGS,
                webServer: { enabled: true, host: '127.0.0.1', port: 18080, password: 'old-pass' },
            },
        })
        renderWithServices()

        await waitFor(() => {
            expect(screen.getByRole('switch', { name: 'Enable Web Server' })).toHaveAttribute(
                'aria-checked',
                'true',
            )
        })

        const passwordInput = screen.getByLabelText('Web access password')
        fireEvent.change(passwordInput, { target: { value: 'new-pass' } })

        expect(setWebServer).toHaveBeenCalledWith({ password: 'new-pass', enabled: false })
        await waitFor(() => {
            expect(screen.getByRole('switch', { name: 'Enable Web Server' })).toHaveAttribute(
                'aria-checked',
                'false',
            )
            expect(mockWebServer.stop).toHaveBeenCalled()
        })
        expect(screen.queryByRole('button', { name: 'Confirm' })).not.toBeInTheDocument()
    })

    it('restarts web server with updated config when toggle switch is clicked back on', async () => {
        useSettingsStore.setState({
            settings: {
                ...DEFAULT_SETTINGS,
                webServer: { enabled: true, host: '127.0.0.1', port: 18080, password: '' },
            },
        })
        renderWithServices()

        const portInput = screen.getByRole('spinbutton', { name: 'Port' })
        fireEvent.change(portInput, { target: { value: '9000' } })

        await waitFor(() => {
            expect(screen.getByRole('switch', { name: 'Enable Web Server' })).toHaveAttribute(
                'aria-checked',
                'false',
            )
        })

        const toggle = screen.getByRole('switch', { name: 'Enable Web Server' })
        fireEvent.click(toggle)

        await waitFor(() => {
            expect(mockWebServer.start).toHaveBeenCalledWith({
                host: '127.0.0.1',
                port: 9000,
                password: '',
            })
        })
    })

    it('edits, reveals, and clears the Web access password', async () => {
        useSettingsStore.setState({
            settings: {
                ...DEFAULT_SETTINGS,
                webServer: {
                    enabled: false,
                    host: '127.0.0.1',
                    port: 18080,
                    password: 'old-secret',
                },
            },
        })
        renderWithServices()

        const input = screen.getByLabelText('Web access password')
        expect(input).toHaveAttribute('type', 'password')
        expect(document.body.textContent).not.toContain('old-secret')

        // Verify font inheritance and typography tokens
        expect(input.className).toContain('text-[length:var(--ui-font-size)]')
        expect(input.className).toContain('font-[inherit]')
        expect(input.className).not.toContain('text-[12px]')
        expect(input.className).not.toMatch(/font-(medium|semibold|bold|thin|light|normal)/)

        fireEvent.click(screen.getByRole('button', { name: 'Show Web access password' }))
        expect(input).toHaveAttribute('type', 'text')

        fireEvent.change(input, { target: { value: 'new-secret' } })
        expect(useSettingsStore.getState().settings.webServer?.password).toBe('new-secret')

        fireEvent.change(input, { target: { value: '' } })
        expect(useSettingsStore.getState().settings.webServer?.password).toBe('')
    })

    it('does not start web server when editing config if server is disabled and stopped', async () => {
        useSettingsStore.setState({
            settings: {
                ...DEFAULT_SETTINGS,
                webServer: {
                    enabled: false,
                    host: '127.0.0.1',
                    port: 18080,
                    password: '',
                },
            },
        })
        renderWithServices()

        const hostInput = screen.getByRole('textbox', { name: 'Binding IP' })
        fireEvent.change(hostInput, { target: { value: '192.168.1.100' } })

        const portInput = screen.getByRole('spinbutton', { name: 'Port' })
        fireEvent.change(portInput, { target: { value: '9999' } })

        const passInput = screen.getByLabelText('Web access password')
        fireEvent.change(passInput, { target: { value: 'offline-secret' } })

        expect(useSettingsStore.getState().settings.webServer?.host).toBe('192.168.1.100')
        expect(useSettingsStore.getState().settings.webServer?.port).toBe(9999)
        expect(useSettingsStore.getState().settings.webServer?.password).toBe('offline-secret')
        expect(mockWebServer.start).not.toHaveBeenCalled()
    })

    it('preserves leading and trailing whitespace in password without trimming', async () => {
        useSettingsStore.setState({
            settings: {
                ...DEFAULT_SETTINGS,
                webServer: {
                    enabled: false,
                    host: '127.0.0.1',
                    port: 18080,
                    password: '',
                },
            },
        })
        renderWithServices()

        const input = screen.getByLabelText('Web access password')
        fireEvent.change(input, { target: { value: '  spaced secret  ' } })

        expect(useSettingsStore.getState().settings.webServer?.password).toBe(
            '  spaced secret  ',
        )
    })

    it('shows error state if webServerService.stop fails during field change', async () => {
        mockWebServer.getStatus.mockResolvedValueOnce({
            running: true,
            host: '127.0.0.1',
            port: 18080,
            url: 'http://127.0.0.1:18080',
        })
        useSettingsStore.setState({
            settings: {
                ...DEFAULT_SETTINGS,
                webServer: {
                    enabled: true,
                    host: '127.0.0.1',
                    port: 18080,
                    password: '',
                },
            },
        })
        renderWithServices()

        await waitFor(() => {
            expect(screen.getByText('Running')).toBeInTheDocument()
        })

        mockWebServer.stop.mockRejectedValueOnce(new Error('Stop failed'))

        const hostInput = screen.getByRole('textbox', { name: 'Binding IP' })
        fireEvent.change(hostInput, { target: { value: '192.168.1.50' } })

        await waitFor(() => {
            expect(screen.getByText('Start Failed')).toBeInTheDocument()
            expect(screen.getByText('Stop failed')).toBeInTheDocument()
        })
    })

    it('clears previous startup error state when user modifies input', async () => {
        mockWebServer.getStatus.mockResolvedValue({
            running: false,
            host: '127.0.0.1',
            port: 80,
            url: '',
            error: 'listen EADDRINUSE: address already in use 127.0.0.1:80',
        })
        useSettingsStore.setState({
            settings: {
                ...DEFAULT_SETTINGS,
                webServer: {
                    enabled: false,
                    host: '127.0.0.1',
                    port: 80,
                    password: 'my-password',
                },
            },
        })
        renderWithServices()

        await waitFor(() => {
            expect(screen.getByText('Start Failed')).toBeInTheDocument()
            expect(screen.getByText('listen EADDRINUSE: address already in use 127.0.0.1:80')).toBeInTheDocument()
        })

        const portInput = screen.getByRole('spinbutton', { name: 'Port' })
        fireEvent.change(portInput, { target: { value: '18080' } })

        await waitFor(() => {
            expect(screen.queryByText('Start Failed')).not.toBeInTheDocument()
            expect(screen.getByText('Stopped')).toBeInTheDocument()
        })
    })

    it('does not render Web Server section when running in a browser environment', () => {
        Object.defineProperty(navigator, 'userAgent', {
            value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            configurable: true,
        })

        renderWithServices()

        expect(screen.getByRole('textbox', { name: 'Base URL' })).toBeInTheDocument()
        expect(screen.queryByText('Web Server')).not.toBeInTheDocument()
        expect(screen.queryByRole('switch', { name: 'Enable Web Server' })).not.toBeInTheDocument()
        expect(screen.queryByRole('textbox', { name: 'Binding IP' })).not.toBeInTheDocument()
        expect(screen.queryByLabelText('Web access password')).toBeNull()
        expect(mockWebServer.getStatus).not.toHaveBeenCalled()
    })

    describe('Gateway Discovery', () => {
        it('triggers gateway discovery when discover button is clicked and displays discovered gateways', async () => {
            const mockGateway: DiscoveredGateway = {
                instanceName: 'Office Gateway',
                baseUrl: 'http://192.168.1.100:8317',
                product: 'cliproxy',
                authRequired: true,
                host: '192.168.1.100',
                port: 8317,
                addresses: ['192.168.1.100'],
                primaryAddress: '192.168.1.100',
            }
            mockGatewayDiscovery.discover.mockResolvedValueOnce([mockGateway])

            renderWithServices()

            const discoverButton = screen.getByRole('button', { name: 'Discover Gateways' })
            expect(discoverButton).toBeInTheDocument()

            fireEvent.click(discoverButton)

            expect(mockGatewayDiscovery.discover).toHaveBeenCalledWith(3000)

            await waitFor(() => {
                expect(screen.getByText('Office Gateway')).toBeInTheDocument()
            })

            expect(screen.getByText('cliproxy')).toBeInTheDocument()
            expect(screen.getByText('Key Required')).toBeInTheDocument()
            expect(screen.getByText('http://192.168.1.100:8317')).toBeInTheDocument()
        })

        it('selecting a discovered gateway updates the Base URL setting', async () => {
            const mockGateway: DiscoveredGateway = {
                instanceName: 'Home Gateway',
                baseUrl: 'http://192.168.0.50:8317',
                product: 'generic',
                authRequired: false,
                host: '192.168.0.50',
                port: 8317,
                addresses: ['192.168.0.50'],
                primaryAddress: '192.168.0.50',
            }
            mockGatewayDiscovery.discover.mockResolvedValueOnce([mockGateway])
            const setCliProxyApi = vi.spyOn(
                useSettingsStore.getState(),
                'setCliProxyApi',
            )

            renderWithServices()

            fireEvent.click(screen.getByRole('button', { name: 'Discover Gateways' }))

            await waitFor(() => {
                expect(screen.getByText('Home Gateway')).toBeInTheDocument()
            })

            fireEvent.click(screen.getByText('Home Gateway'))

            expect(setCliProxyApi).toHaveBeenCalledWith({
                baseUrl: 'http://192.168.0.50:8317',
            })
            expect(useSettingsStore.getState().settings.cliProxyApi?.baseUrl).toBe(
                'http://192.168.0.50:8317',
            )
            await waitFor(() => {
                expect(screen.queryByText('Home Gateway')).not.toBeInTheDocument()
            })
        })

        it('shows no gateways found message when discovery returns empty results', async () => {
            mockGatewayDiscovery.discover.mockResolvedValueOnce([])

            renderWithServices()

            fireEvent.click(screen.getByRole('button', { name: 'Discover Gateways' }))

            expect(mockGatewayDiscovery.discover).toHaveBeenCalledWith(3000)

            await waitFor(() => {
                expect(screen.getByText('No gateways found')).toBeInTheDocument()
            })
        })

        it('shows error message when discovery fails', async () => {
            mockGatewayDiscovery.discover.mockRejectedValueOnce(new Error('MDNS discovery timeout'))

            renderWithServices()

            fireEvent.click(screen.getByRole('button', { name: 'Discover Gateways' }))

            await waitFor(() => {
                expect(screen.getByText('Scan failed')).toBeInTheDocument()
                expect(screen.getByText('MDNS discovery timeout')).toBeInTheDocument()
            })
        })

        it('disables discover button and shows scanning indicator while discovery is in progress', async () => {
            let resolveDiscovery: (v: DiscoveredGateway[]) => void = () => {}
            mockGatewayDiscovery.discover.mockReturnValueOnce(
                new Promise<DiscoveredGateway[]>((resolve) => {
                    resolveDiscovery = resolve
                }),
            )

            renderWithServices()

            const discoverButton = screen.getByRole('button', { name: 'Discover Gateways' })
            fireEvent.click(discoverButton)

            expect(screen.getByRole('button', { name: 'Scanning...' })).toBeDisabled()

            act(() => {
                resolveDiscovery([])
            })

            await waitFor(() => {
                expect(screen.getByRole('button', { name: 'Discover Gateways' })).not.toBeDisabled()
            })
        })

        it('closes the discovery menu when pressing Escape', async () => {
            mockGatewayDiscovery.discover.mockResolvedValueOnce([
                {
                    instanceName: 'Test Gateway',
                    baseUrl: 'http://127.0.0.1:8317',
                    authRequired: false,
                    host: '127.0.0.1',
                    port: 8317,
                    addresses: ['127.0.0.1'],
                    primaryAddress: '127.0.0.1',
                },
            ])

            renderWithServices()

            fireEvent.click(screen.getByRole('button', { name: 'Discover Gateways' }))

            await waitFor(() => {
                expect(screen.getByText('Test Gateway')).toBeInTheDocument()
            })

            fireEvent.keyDown(document, { key: 'Escape' })

            await waitFor(() => {
                expect(screen.queryByText('Test Gateway')).not.toBeInTheDocument()
            })
        })

        it('toggles discovered gateways list with the chevron toggle button', async () => {
            mockGatewayDiscovery.discover.mockResolvedValueOnce([
                {
                    instanceName: 'Test Gateway',
                    baseUrl: 'http://127.0.0.1:8317',
                    authRequired: false,
                    host: '127.0.0.1',
                    port: 8317,
                    addresses: ['127.0.0.1'],
                    primaryAddress: '127.0.0.1',
                },
            ])

            renderWithServices()

            fireEvent.click(screen.getByRole('button', { name: 'Discover Gateways' }))

            await waitFor(() => {
                expect(screen.getByText('Test Gateway')).toBeInTheDocument()
            })

            // Close via Escape
            fireEvent.keyDown(document, { key: 'Escape' })

            await waitFor(() => {
                expect(screen.queryByText('Test Gateway')).not.toBeInTheDocument()
            })

            // Re-open with toggle button
            const toggleButton = screen.getByRole('button', { name: 'Toggle gateways list' })
            fireEvent.click(toggleButton)

            await waitFor(() => {
                expect(screen.getByText('Test Gateway')).toBeInTheDocument()
            })

            // Close with toggle button
            fireEvent.click(toggleButton)

            await waitFor(() => {
                expect(screen.queryByText('Test Gateway')).not.toBeInTheDocument()
            })
        })

        it('supports keyboard navigation with ArrowDown, ArrowUp, Enter to select, and returns focus to trigger button', async () => {
            const mockGateways: DiscoveredGateway[] = [
                {
                    instanceName: 'Gateway One',
                    baseUrl: 'http://192.168.1.10:8317',
                    authRequired: false,
                    host: '192.168.1.10',
                    port: 8317,
                    addresses: ['192.168.1.10'],
                    primaryAddress: '192.168.1.10',
                },
                {
                    instanceName: 'Gateway Two',
                    baseUrl: 'http://192.168.1.20:8317',
                    authRequired: true,
                    host: '192.168.1.20',
                    port: 8317,
                    addresses: ['192.168.1.20'],
                    primaryAddress: '192.168.1.20',
                },
            ]
            mockGatewayDiscovery.discover.mockResolvedValueOnce(mockGateways)
            const setCliProxyApi = vi.spyOn(useSettingsStore.getState(), 'setCliProxyApi')

            renderWithServices()

            const discoverBtn = screen.getByRole('button', { name: 'Discover Gateways' })
            discoverBtn.focus()
            fireEvent.click(discoverBtn)

            await waitFor(() => {
                expect(screen.getByText('Gateway One')).toBeInTheDocument()
            })

            const option0 = screen.getByTestId('gateway-option-0')
            const option1 = screen.getByTestId('gateway-option-1')

            // Initial highlight is 0
            expect(option0).toHaveAttribute('data-highlighted', 'true')
            expect(option1).toHaveAttribute('data-highlighted', 'false')

            const listbox = screen.getByRole('listbox')
            expect(listbox).toHaveFocus()

            // ArrowDown moves highlight to 1
            fireEvent.keyDown(listbox, { key: 'ArrowDown' })
            expect(option0).toHaveAttribute('data-highlighted', 'false')
            expect(option1).toHaveAttribute('data-highlighted', 'true')

            // ArrowDown wraps back to 0
            fireEvent.keyDown(listbox, { key: 'ArrowDown' })
            expect(option0).toHaveAttribute('data-highlighted', 'true')

            // ArrowUp moves highlight to 1
            fireEvent.keyDown(listbox, { key: 'ArrowUp' })
            expect(option1).toHaveAttribute('data-highlighted', 'true')

            // Enter selects option 1 (Gateway Two)
            fireEvent.keyDown(listbox, { key: 'Enter' })

            await waitFor(() => {
                expect(screen.queryByTestId('gateway-discovery-menu')).not.toBeInTheDocument()
            })

            expect(setCliProxyApi).toHaveBeenCalledWith({
                baseUrl: 'http://192.168.1.20:8317',
            })
            expect(useSettingsStore.getState().settings.cliProxyApi?.baseUrl).toBe(
                'http://192.168.1.20:8317',
            )
            // Focus returned to trigger
            expect(discoverBtn).toHaveFocus()
        })

        it('supports Space key to select highlighted gateway and returns focus to trigger', async () => {
            const mockGateways: DiscoveredGateway[] = [
                {
                    instanceName: 'Gateway One',
                    baseUrl: 'http://192.168.1.10:8317',
                    authRequired: false,
                    host: '192.168.1.10',
                    port: 8317,
                    addresses: ['192.168.1.10'],
                    primaryAddress: '192.168.1.10',
                },
            ]
            mockGatewayDiscovery.discover.mockResolvedValueOnce(mockGateways)
            const setCliProxyApi = vi.spyOn(useSettingsStore.getState(), 'setCliProxyApi')

            renderWithServices()

            const discoverBtn = screen.getByRole('button', { name: 'Discover Gateways' })
            discoverBtn.focus()
            fireEvent.click(discoverBtn)

            await waitFor(() => {
                expect(screen.getByText('Gateway One')).toBeInTheDocument()
            })

            const listbox = screen.getByRole('listbox')
            expect(listbox).toHaveFocus()

            // Press Space to select
            fireEvent.keyDown(listbox, { key: ' ' })

            await waitFor(() => {
                expect(screen.queryByTestId('gateway-discovery-menu')).not.toBeInTheDocument()
            })

            expect(setCliProxyApi).toHaveBeenCalledWith({
                baseUrl: 'http://192.168.1.10:8317',
            })
            expect(discoverBtn).toHaveFocus()
        })

        it('returns focus to trigger button when dismissed via Escape', async () => {
            mockGatewayDiscovery.discover.mockResolvedValueOnce([
                {
                    instanceName: 'Gateway One',
                    baseUrl: 'http://192.168.1.10:8317',
                    authRequired: false,
                    host: '192.168.1.10',
                    port: 8317,
                    addresses: ['192.168.1.10'],
                    primaryAddress: '192.168.1.10',
                },
            ])

            renderWithServices()

            const discoverBtn = screen.getByRole('button', { name: 'Discover Gateways' })
            discoverBtn.focus()
            fireEvent.click(discoverBtn)

            await waitFor(() => {
                expect(screen.getByText('Gateway One')).toBeInTheDocument()
            })

            fireEvent.keyDown(document, { key: 'Escape' })

            await waitFor(() => {
                expect(screen.queryByTestId('gateway-discovery-menu')).not.toBeInTheDocument()
            })

            // Now re-open with toggle button and close via Escape
            const toggleBtn = screen.getByRole('button', { name: 'Toggle gateways list' })
            toggleBtn.focus()
            fireEvent.click(toggleBtn)

            await waitFor(() => {
                expect(screen.getByText('Gateway One')).toBeInTheDocument()
            })

            fireEvent.keyDown(document, { key: 'Escape' })

            await waitFor(() => {
                expect(screen.queryByTestId('gateway-discovery-menu')).not.toBeInTheDocument()
            })

            expect(toggleBtn).toHaveFocus()
        })

        it('provides proper ARIA attributes on triggers, listbox, and options', async () => {
            const mockGateways: DiscoveredGateway[] = [
                {
                    instanceName: 'Gateway One',
                    baseUrl: 'http://192.168.1.10:8317',
                    authRequired: false,
                    host: '192.168.1.10',
                    port: 8317,
                    addresses: ['192.168.1.10'],
                    primaryAddress: '192.168.1.10',
                },
            ]
            mockGatewayDiscovery.discover.mockResolvedValueOnce(mockGateways)

            renderWithServices()

            const discoverBtn = screen.getByRole('button', { name: 'Discover Gateways' })
            expect(discoverBtn).toHaveAttribute('aria-haspopup', 'listbox')
            expect(discoverBtn).toHaveAttribute('aria-expanded', 'false')
            expect(discoverBtn).not.toHaveAttribute('aria-controls')

            fireEvent.click(discoverBtn)

            await waitFor(() => {
                expect(screen.getByRole('listbox')).toBeInTheDocument()
            })

            expect(discoverBtn).toHaveAttribute('aria-expanded', 'true')
            expect(discoverBtn).toHaveAttribute('aria-controls', 'gateway-discovery-listbox')

            const listbox = screen.getByRole('listbox')
            expect(listbox).toHaveAttribute('id', 'gateway-discovery-listbox')
            expect(listbox).toHaveAttribute('tabIndex', '-1')
            expect(listbox).toHaveAttribute('aria-activedescendant', 'gateway-option-0')

            const option = screen.getByRole('option')
            expect(option).toHaveAttribute('id', 'gateway-option-0')
            expect(option).toHaveAttribute('aria-selected', 'false')
            expect(option).toHaveAttribute('tabIndex', '-1')

            // Toggle button should also have proper ARIA attributes
            const toggleBtn = screen.getByRole('button', { name: 'Toggle gateways list' })
            expect(toggleBtn).toHaveAttribute('aria-haspopup', 'listbox')
            expect(toggleBtn).toHaveAttribute('aria-expanded', 'true')
            expect(toggleBtn).toHaveAttribute('aria-controls', 'gateway-discovery-listbox')
        })

        it('calculates viewport-constrained maxHeight and flips upward when space below is less than 160px', async () => {
            const mockGateways: DiscoveredGateway[] = [
                {
                    instanceName: 'Gateway One',
                    baseUrl: 'http://192.168.1.10:8317',
                    authRequired: false,
                    host: '192.168.1.10',
                    port: 8317,
                    addresses: ['192.168.1.10'],
                    primaryAddress: '192.168.1.10',
                },
            ]
            mockGatewayDiscovery.discover.mockResolvedValue(mockGateways)

            // Scenario 1: Downward opening with space below >= 160px
            Object.defineProperty(window, 'innerHeight', { value: 600, configurable: true })
            vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
                if (this.getAttribute('data-testid') === 'gateway-discovery-container') {
                    return {
                        top: 200,
                        bottom: 232,
                        left: 100,
                        right: 460,
                        width: 360,
                        height: 32,
                    } as DOMRect
                }
                return { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 } as DOMRect
            })

            renderWithServices()

            const discoverBtn = screen.getByRole('button', { name: 'Discover Gateways' })
            fireEvent.click(discoverBtn)

            await waitFor(() => {
                expect(screen.getByTestId('gateway-discovery-menu')).toBeInTheDocument()
            })

            const menu = screen.getByTestId('gateway-discovery-menu')
            // Downward: top = bottom(232) + 6 = 238px
            // spaceBelow = 600 - 232 - 16 = 352 (>= 160)
            // maxHeight = Math.min(320, 352) = 320px
            expect(menu.style.top).toBe('238px')
            expect(menu.style.bottom).toBe('')
            expect(menu.style.maxHeight).toBe('320px')

            // Close menu
            fireEvent.keyDown(document, { key: 'Escape' })
            await waitFor(() => {
                expect(screen.queryByTestId('gateway-discovery-menu')).not.toBeInTheDocument()
            })

            // Scenario 2: Flip upward when space below < 160px and space above is larger
            // innerHeight = 600, top = 500, bottom = 532
            // spaceBelow = 600 - 532 - 16 = 52 (< 160)
            // spaceAbove = 500 - 16 = 484 (> 52)
            // bottom = 600 - 500 + 6 = 106px
            // maxHeight = Math.min(320, 484) = 320px
            vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
                if (this.getAttribute('data-testid') === 'gateway-discovery-container') {
                    return {
                        top: 500,
                        bottom: 532,
                        left: 100,
                        right: 460,
                        width: 360,
                        height: 32,
                    } as DOMRect
                }
                return { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 } as DOMRect
            })

            const toggleBtn = screen.getByRole('button', { name: 'Toggle gateways list' })
            fireEvent.click(toggleBtn)

            await waitFor(() => {
                expect(screen.getByTestId('gateway-discovery-menu')).toBeInTheDocument()
            })

            const flippedMenu = screen.getByTestId('gateway-discovery-menu')
            expect(flippedMenu.style.bottom).toBe('106px')
            expect(flippedMenu.style.top).toBe('')
            expect(flippedMenu.style.maxHeight).toBe('320px')
        })

        it('uses CPA theme semantic tokens and CSS variables for badges and buttons instead of hardcoded colors', async () => {
            mockGatewayDiscovery.discover.mockResolvedValueOnce([
                {
                    instanceName: 'Secured Gateway',
                    baseUrl: 'http://192.168.1.50:8317',
                    authRequired: true,
                    host: '192.168.1.50',
                    port: 8317,
                    addresses: ['192.168.1.50'],
                    primaryAddress: '192.168.1.50',
                },
                {
                    instanceName: 'Open Gateway',
                    baseUrl: 'http://192.168.1.60:8317',
                    authRequired: false,
                    host: '192.168.1.60',
                    port: 8317,
                    addresses: ['192.168.1.60'],
                    primaryAddress: '192.168.1.60',
                },
            ])

            renderWithServices()

            const discoverBtn = screen.getByRole('button', { name: 'Discover Gateways' })
            expect(discoverBtn.className).not.toContain('hover:text-white')
            expect(discoverBtn.className).toContain('hover:text-[var(--text-primary)]')

            fireEvent.click(discoverBtn)

            await waitFor(() => {
                expect(screen.getByText('Secured Gateway')).toBeInTheDocument()
            })

            const authBadge = screen.getByText('Key Required')
            expect(authBadge.className).toContain('text-[var(--accent-orange)]')
            expect(authBadge.className).not.toContain('text-amber-500')

            const noAuthBadge = screen.getByText('No Auth')
            expect(noAuthBadge.className).toContain('text-[var(--accent-green)]')
            expect(noAuthBadge.className).not.toContain('text-emerald-500')
        })

        it('does not select gateway when Enter or Space is pressed in an outside input while menu is open', async () => {
            const mockGateways: DiscoveredGateway[] = [
                {
                    instanceName: 'Gateway One',
                    baseUrl: 'http://192.168.1.10:8317',
                    authRequired: false,
                    host: '192.168.1.10',
                    port: 8317,
                    addresses: ['192.168.1.10'],
                    primaryAddress: '192.168.1.10',
                },
            ]
            mockGatewayDiscovery.discover.mockResolvedValueOnce(mockGateways)
            const setCliProxyApi = vi.spyOn(useSettingsStore.getState(), 'setCliProxyApi')
            setCliProxyApi.mockClear()

            renderWithServices()

            const discoverBtn = screen.getByRole('button', { name: 'Discover Gateways' })
            fireEvent.click(discoverBtn)

            await waitFor(() => {
                expect(screen.getByTestId('gateway-discovery-menu')).toBeInTheDocument()
            })

            const baseUrlInput = screen.getByRole('textbox', { name: 'Base URL' })
            baseUrlInput.focus()
            expect(baseUrlInput).toHaveFocus()

            // Press Enter and Space in the outside text input
            fireEvent.keyDown(baseUrlInput, { key: 'Enter' })
            fireEvent.keyDown(baseUrlInput, { key: ' ' })

            // Should NOT have selected the gateway
            expect(setCliProxyApi).not.toHaveBeenCalledWith(
                expect.objectContaining({ baseUrl: 'http://192.168.1.10:8317' }),
            )
            // Menu remains open
            expect(screen.getByTestId('gateway-discovery-menu')).toBeInTheDocument()
        })

        it('closes menu immediately when Tab is pressed', async () => {
            const mockGateways: DiscoveredGateway[] = [
                {
                    instanceName: 'Gateway One',
                    baseUrl: 'http://192.168.1.10:8317',
                    authRequired: false,
                    host: '192.168.1.10',
                    port: 8317,
                    addresses: ['192.168.1.10'],
                    primaryAddress: '192.168.1.10',
                },
            ]
            mockGatewayDiscovery.discover.mockResolvedValueOnce(mockGateways)

            renderWithServices()

            const discoverBtn = screen.getByRole('button', { name: 'Discover Gateways' })
            fireEvent.click(discoverBtn)

            await waitFor(() => {
                expect(screen.getByTestId('gateway-discovery-menu')).toBeInTheDocument()
            })

            // Press Tab key anywhere
            fireEvent.keyDown(document, { key: 'Tab' })

            await waitFor(() => {
                expect(screen.queryByTestId('gateway-discovery-menu')).not.toBeInTheDocument()
            })
        })

        it('clamps horizontal position within viewport bounds and applies maxWidth style', async () => {
            const mockGateways: DiscoveredGateway[] = [
                {
                    instanceName: 'Gateway One',
                    baseUrl: 'http://192.168.1.10:8317',
                    authRequired: false,
                    host: '192.168.1.10',
                    port: 8317,
                    addresses: ['192.168.1.10'],
                    primaryAddress: '192.168.1.10',
                },
            ]
            mockGatewayDiscovery.discover.mockResolvedValue(mockGateways)

            // Case A: Right-edge clamp: trigger.left is 700 with window width 800
            // menuWidth = 360, window.innerWidth - menuWidth - 16 = 800 - 360 - 16 = 424
            // left = Math.max(16, Math.min(700, 424)) = 424
            Object.defineProperty(window, 'innerWidth', { value: 800, configurable: true })
            Object.defineProperty(window, 'innerHeight', { value: 600, configurable: true })

            vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
                if (this.getAttribute('data-testid') === 'gateway-discovery-container') {
                    return {
                        top: 200,
                        bottom: 232,
                        left: 700,
                        right: 780,
                        width: 80,
                        height: 32,
                    } as DOMRect
                }
                return { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 } as DOMRect
            })

            const { unmount } = renderWithServices()

            const discoverBtn = screen.getByRole('button', { name: 'Discover Gateways' })
            fireEvent.click(discoverBtn)

            await waitFor(() => {
                expect(screen.getByTestId('gateway-discovery-menu')).toBeInTheDocument()
            })

            const menuA = screen.getByTestId('gateway-discovery-menu')
            expect(menuA.style.left).toBe('424px')
            expect(menuA.style.maxWidth).toBe('calc(100vw - 32px)')

            unmount()

            // Case B: Left-edge clamp: trigger.left is -50 with window width 800
            // left = Math.max(16, Math.min(-50, 424)) = 16
            vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
                if (this.getAttribute('data-testid') === 'gateway-discovery-container') {
                    return {
                        top: 200,
                        bottom: 232,
                        left: -50,
                        right: 30,
                        width: 80,
                        height: 32,
                    } as DOMRect
                }
                return { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 } as DOMRect
            })

            renderWithServices()

            const discoverBtnB = screen.getByRole('button', { name: 'Discover Gateways' })
            fireEvent.click(discoverBtnB)

            await waitFor(() => {
                expect(screen.getByTestId('gateway-discovery-menu')).toBeInTheDocument()
            })

            const menuB = screen.getByTestId('gateway-discovery-menu')
            expect(menuB.style.left).toBe('16px')
            expect(menuB.style.maxWidth).toBe('calc(100vw - 32px)')
        })

        it('maintains overflow-hidden on popover, flex-shrink-0 on header, and overflow-y-auto on content container across small height and long content states', async () => {
            // Scenario 1: Small available height with long list of gateways
            const longGatewayList: DiscoveredGateway[] = Array.from({ length: 15 }, (_, i) => ({
                instanceName: `Gateway Instance ${i + 1}`,
                baseUrl: `http://192.168.1.${10 + i}:8317`,
                authRequired: i % 2 === 0,
                host: `192.168.1.${10 + i}`,
                port: 8317,
                addresses: [`192.168.1.${10 + i}`],
                primaryAddress: `192.168.1.${10 + i}`,
            }))
            mockGatewayDiscovery.discover.mockResolvedValue(longGatewayList)

            // Setup small viewport height: innerHeight = 220px, container top = 100, bottom = 132
            // spaceBelow = 220 - 132 - 16 = 72px (< 160)
            // spaceAbove = 100 - 16 = 84px (> 72px)
            // Upward flip: maxHeight = Math.min(320, 84) = 84px
            Object.defineProperty(window, 'innerHeight', { value: 220, configurable: true })
            vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
                if (this.getAttribute('data-testid') === 'gateway-discovery-container') {
                    return {
                        top: 100,
                        bottom: 132,
                        left: 100,
                        right: 460,
                        width: 360,
                        height: 32,
                    } as DOMRect
                }
                return { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 } as DOMRect
            })

            const { unmount } = renderWithServices()

            const discoverBtn = screen.getByRole('button', { name: 'Discover Gateways' })
            fireEvent.click(discoverBtn)

            await waitFor(() => {
                expect(screen.getByTestId('gateway-discovery-menu')).toBeInTheDocument()
            })

            const menu = screen.getByTestId('gateway-discovery-menu')
            // Popover card must have flex, flex-col, and overflow-hidden
            expect(menu.className).toContain('flex')
            expect(menu.className).toContain('flex-col')
            expect(menu.className).toContain('overflow-hidden')
            expect(menu.style.maxHeight).toBe('84px')

            // Header must have flex-shrink-0 (and shrink-0)
            const header = menu.querySelector('div.border-b')
            expect(header).not.toBeNull()
            expect(header?.className).toContain('flex-shrink-0')

            // Content container must have flex-1, min-h-0, and overflow-y-auto
            const content = screen.getByTestId('gateway-discovery-content')
            expect(content.className).toContain('flex-1')
            expect(content.className).toContain('min-h-0')
            expect(content.className).toContain('overflow-y-auto')

            // All list items rendered inside content container
            expect(content.querySelector('[role="listbox"]')).toBeInTheDocument()

            unmount()

            // Scenario 2: Long content in error state
            const veryLongErrorMessage = 'Connection refused by upstream gateway daemon: ' +
                'ETIMEDOUT error occurred after multiple retries while connecting to http://192.168.1.99:8317/v1/models. ' +
                'Detailed trace: network socket unreachable, route table missing, host unreachable at physical layer, ' +
                'interface en0 state dormant, gateway probe aborted after timeout limit exceeded.'
            mockGatewayDiscovery.discover.mockRejectedValueOnce(new Error(veryLongErrorMessage))

            renderWithServices()

            const discoverBtnError = screen.getByRole('button', { name: 'Discover Gateways' })
            fireEvent.click(discoverBtnError)

            await waitFor(() => {
                expect(screen.getByText(veryLongErrorMessage)).toBeInTheDocument()
            })

            const errorMenu = screen.getByTestId('gateway-discovery-menu')
            expect(errorMenu.className).toContain('flex')
            expect(errorMenu.className).toContain('flex-col')
            expect(errorMenu.className).toContain('overflow-hidden')

            const errorContent = screen.getByTestId('gateway-discovery-content')
            expect(errorContent.className).toContain('flex-1')
            expect(errorContent.className).toContain('min-h-0')
            expect(errorContent.className).toContain('overflow-y-auto')
            expect(errorContent.textContent).toContain(veryLongErrorMessage)

            // Scenario 3: Empty state
            mockGatewayDiscovery.discover.mockResolvedValueOnce([])
            const rescanBtn = screen.getByRole('button', { name: 'Rescan' })
            fireEvent.click(rescanBtn)

            await waitFor(() => {
                expect(screen.getByText('No gateways found')).toBeInTheDocument()
            })

            const emptyContent = screen.getByTestId('gateway-discovery-content')
            expect(emptyContent.className).toContain('flex-1')
            expect(emptyContent.className).toContain('min-h-0')
            expect(emptyContent.className).toContain('overflow-y-auto')

            // Scenario 4: Loading state during in-flight rescan
            let resolvePending: (val: DiscoveredGateway[]) => void = () => {}
            mockGatewayDiscovery.discover.mockReturnValueOnce(new Promise((resolve) => {
                resolvePending = resolve
            }))
            fireEvent.click(rescanBtn)

            await waitFor(() => {
                const loadingArea = screen.getByTestId('gateway-discovery-content')
                expect(within(loadingArea).getByText('Scanning...')).toBeInTheDocument()
            })

            const loadingContent = screen.getByTestId('gateway-discovery-content')
            expect(loadingContent.className).toContain('flex-1')
            expect(loadingContent.className).toContain('min-h-0')
            expect(loadingContent.className).toContain('overflow-y-auto')

            act(() => {
                resolvePending([])
            })
        })
    })
})
