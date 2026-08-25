import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '@/i18n'
import { DEFAULT_SETTINGS } from '@/types/models'
import { useSettingsStore } from '@/stores/settingsStore'
import { HostServicesProvider } from '@cpa/plugin-ui'
import { createHostServices, setHostServices } from '@/application/services/createHostServices'
import type { HostServices, WebServerService, WebServerStatus } from '@cpa/plugin-api'
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
    let mockWebServer: {
        getStatus: ReturnType<typeof vi.fn>
        start: ReturnType<typeof vi.fn>
        stop: ReturnType<typeof vi.fn>
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

        hostServices = createHostServices()
        hostServices.webServer = mockWebServer as unknown as WebServerService
        setHostServices(hostServices)
    })

    afterEach(() => {
        Object.defineProperty(navigator, 'userAgent', {
            value: originalUserAgent,
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
})
