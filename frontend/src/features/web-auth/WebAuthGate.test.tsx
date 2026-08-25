import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import i18n from '@/i18n'
import { WebAuthGate, waitForWebAuthentication } from './WebAuthGate'
import { runStartup } from '@/main'

describe('WebAuthGate', () => {
    const originalUserAgent = navigator.userAgent

    beforeEach(async () => {
        vi.restoreAllMocks()
        await i18n.changeLanguage('en')
        Object.defineProperty(navigator, 'userAgent', {
            value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            configurable: true,
        })
    })

    afterEach(() => {
        vi.useRealTimers()
        Object.defineProperty(navigator, 'userAgent', {
            value: originalUserAgent,
            configurable: true,
        })
        vi.unstubAllGlobals()
        document.body.innerHTML = ''
    })

    it('provides accessible dialog name and checking status in en', async () => {
        const requestEn = vi
            .fn()
            .mockRejectedValueOnce(new Error('offline'))
            .mockReturnValueOnce(new Promise<Response>(() => {}))
        vi.stubGlobal('fetch', requestEn)

        render(
            <WebAuthGate
                onAuthenticated={vi.fn()}
                onGateVisible={vi.fn()}
            />,
        )

        const dialogEn = await screen.findByRole('dialog', { name: 'Coding Professional Agent' })
        expect(dialogEn).toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
        const statusEn = screen.getByRole('status')
        expect(statusEn).toHaveTextContent('Checking authentication status...')
    })

    it('shows the branded logo before raising it to reveal only the Web password form', async () => {
        vi.useFakeTimers()
        let resolveStatus!: (response: Response) => void
        vi.stubGlobal(
            'fetch',
            vi.fn().mockReturnValue(
                new Promise<Response>((resolve) => {
                    resolveStatus = resolve
                }),
            ),
        )

        render(<WebAuthGate onAuthenticated={vi.fn()} />)

        await act(async () => {
            resolveStatus(
                new Response(
                    JSON.stringify({ required: true, authenticated: false }),
                    { status: 200, headers: { 'Content-Type': 'application/json' } },
                ),
            )
            await Promise.resolve()
            await Promise.resolve()
        })

        const title = screen.getByTestId('web-auth-splash-title')
        const panel = screen.getByTestId('web-auth-panel')
        expect(title).toHaveTextContent('Coding Professional Agent')
        expect(title.parentElement).toHaveClass('translate-y-0')
        expect(panel).toHaveClass('max-h-0', 'opacity-0', 'translate-y-6')

        act(() => {
            vi.advanceTimersByTime(300)
        })

        expect(title.parentElement).toHaveClass('-translate-y-4')
        expect(panel).toHaveClass('mt-6', 'max-h-[600px]', 'opacity-100', 'translate-y-0')
        expect(screen.getByLabelText('Web access password')).toBeInTheDocument()
        expect(screen.queryByTestId('startup-base-url-input')).toBeNull()
        expect(screen.queryByTestId('startup-api-key-input')).toBeNull()
    })

    it('does not continue bootstrap until login succeeds', async () => {
        const request = vi
            .fn()
            .mockResolvedValueOnce(
                new Response(
                    JSON.stringify({ required: true, authenticated: false }),
                    { status: 200, headers: { 'Content-Type': 'application/json' } },
                ),
            )
            .mockResolvedValueOnce(
                new Response(
                    JSON.stringify({ authenticated: true }),
                    { status: 200, headers: { 'Content-Type': 'application/json' } },
                ),
            )
        vi.stubGlobal('fetch', request)
        const onAuthenticated = vi.fn()

        render(<WebAuthGate onAuthenticated={onAuthenticated} />)

        const password = await screen.findByLabelText('Web access password')
        expect(onAuthenticated).not.toHaveBeenCalled()
        fireEvent.change(password, { target: { value: 'secret' } })
        fireEvent.keyDown(password, { key: 'Enter' })

        await waitFor(() => expect(onAuthenticated).toHaveBeenCalledTimes(1))
    })

    it.each([
        { required: false, authenticated: false },
        { required: false, authenticated: true },
        { required: true, authenticated: true },
    ])('continues immediately for status $required/$authenticated', async (status) => {
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue(
                new Response(
                    JSON.stringify(status),
                    { status: 200, headers: { 'Content-Type': 'application/json' } },
                ),
            ),
        )
        const onAuthenticated = vi.fn()
        const onGateVisible = vi.fn()

        render(
            <WebAuthGate
                onAuthenticated={onAuthenticated}
                onGateVisible={onGateVisible}
            />,
        )

        await waitFor(() => expect(onAuthenticated).toHaveBeenCalledTimes(1))
        expect(onGateVisible).not.toHaveBeenCalled()
        expect(screen.queryByLabelText('Web access password')).toBeNull()
    })

    it('shows an invalid-password error and supports retrying a status failure', async () => {
        const request = vi
            .fn()
            .mockRejectedValueOnce(new Error('offline'))
            .mockResolvedValueOnce(
                new Response(
                    JSON.stringify({ required: true, authenticated: false }),
                    { status: 200, headers: { 'Content-Type': 'application/json' } },
                ),
            )
            .mockResolvedValueOnce(
                new Response(
                    JSON.stringify({ error: 'Unauthorized' }),
                    { status: 401, headers: { 'Content-Type': 'application/json' } },
                ),
            )
        vi.stubGlobal('fetch', request)
        const onGateVisible = vi.fn()

        render(
            <WebAuthGate
                onAuthenticated={vi.fn()}
                onGateVisible={onGateVisible}
            />,
        )

        fireEvent.click(await screen.findByRole('button', { name: 'Retry' }))
        const input = await screen.findByLabelText('Web access password')
        fireEvent.change(input, { target: { value: 'wrong' } })
        fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))

        expect(await screen.findByText('Incorrect password')).toBeInTheDocument()
        expect(input).toHaveFocus()
        expect(onGateVisible).toHaveBeenCalledTimes(1)
    })

    it('transitions to connection-error with retry button when login fails due to network error', async () => {
        const request = vi
            .fn()
            .mockResolvedValueOnce(
                new Response(
                    JSON.stringify({ required: true, authenticated: false }),
                    { status: 200, headers: { 'Content-Type': 'application/json' } },
                ),
            )
            .mockRejectedValueOnce(new Error('Network disconnected'))
            .mockResolvedValueOnce(
                new Response(
                    JSON.stringify({ required: true, authenticated: false }),
                    { status: 200, headers: { 'Content-Type': 'application/json' } },
                ),
            )
        vi.stubGlobal('fetch', request)

        render(<WebAuthGate onAuthenticated={vi.fn()} />)

        const input = await screen.findByLabelText('Web access password')
        fireEvent.change(input, { target: { value: 'secret' } })
        fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))

        // Network error must show connection error, NOT invalid-password
        expect(await screen.findByText('Unable to reach the Web Server')).toBeInTheDocument()
        expect(screen.queryByText('Incorrect password')).toBeNull()

        // User can retry connection
        const retryBtn = screen.getByRole('button', { name: 'Retry' })
        fireEvent.click(retryBtn)

        expect(await screen.findByLabelText('Web access password')).toBeInTheDocument()
    })

    it('transitions to connection-error with retry button when login fails due to server 500 error', async () => {
        const request = vi
            .fn()
            .mockResolvedValueOnce(
                new Response(
                    JSON.stringify({ required: true, authenticated: false }),
                    { status: 200, headers: { 'Content-Type': 'application/json' } },
                ),
            )
            .mockResolvedValueOnce(
                new Response(
                    JSON.stringify({ error: 'Internal Server Error' }),
                    { status: 500, headers: { 'Content-Type': 'application/json' } },
                ),
            )
        vi.stubGlobal('fetch', request)

        render(<WebAuthGate onAuthenticated={vi.fn()} />)

        const input = await screen.findByLabelText('Web access password')
        fireEvent.change(input, { target: { value: 'secret' } })
        fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))

        expect(await screen.findByText('Unable to reach the Web Server')).toBeInTheDocument()
        expect(screen.queryByText('Incorrect password')).toBeNull()
        expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
    })

    it('toggles password visibility', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue(
                new Response(
                    JSON.stringify({ required: true, authenticated: false }),
                    { status: 200, headers: { 'Content-Type': 'application/json' } },
                ),
            ),
        )
        render(<WebAuthGate onAuthenticated={vi.fn()} />)

        const input = await screen.findByLabelText('Web access password')
        expect(input).toHaveAttribute('type', 'password')
        fireEvent.click(screen.getByRole('button', { name: 'Show password' }))
        expect(input).toHaveAttribute('type', 'text')
        fireEvent.click(screen.getByRole('button', { name: 'Hide password' }))
        expect(input).toHaveAttribute('type', 'password')
    })

    it('adheres to typography and theme token constraints without hardcoded font/color overrides', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue(
                new Response(
                    JSON.stringify({ required: true, authenticated: false }),
                    { status: 200, headers: { 'Content-Type': 'application/json' } },
                ),
            ),
        )
        const { container } = render(<WebAuthGate onAuthenticated={vi.fn()} />)

        const input = await screen.findByLabelText('Web access password')
        const submitBtn = screen.getByRole('button', { name: 'Sign in' })
        const label = container.querySelector('label')

        // Ensure no text-white or fixed font sizes/weights override user settings
        expect(submitBtn.className).not.toContain('text-white')
        expect(submitBtn.className).not.toMatch(/\btext-xs\b/)
        expect(submitBtn.className).not.toMatch(/\bfont-medium\b/)
        expect(submitBtn.className).toContain('font-[inherit]')

        expect(label?.className).not.toMatch(/\btext-xs\b/)
        expect(label?.className).not.toMatch(/\bfont-medium\b/)

        expect(input.className).not.toMatch(/\btext-xs\b/)
        expect(input.className).toContain('font-[inherit]')
    })

    it('adheres to typography and theme token constraints in connection-error phase', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn().mockRejectedValue(new Error('offline')),
        )
        const { container } = render(<WebAuthGate onAuthenticated={vi.fn()} />)

        const retryBtn = await screen.findByRole('button', { name: 'Retry' })
        const alert = container.querySelector('[role="alert"]')

        expect(retryBtn.className).not.toContain('text-white')
        expect(retryBtn.className).not.toMatch(/\btext-xs\b/)
        expect(retryBtn.className).not.toMatch(/\bfont-medium\b/)
        expect(retryBtn.className).toContain('font-[inherit]')

        expect(alert?.className).not.toMatch(/\btext-xs\b/)
        expect(alert?.className).toContain('font-[inherit]')
    })

    it('skips root rendering in Electron', async () => {
        Object.defineProperty(navigator, 'userAgent', {
            value: 'Mozilla/5.0 Electron/44.0.0',
            configurable: true,
        })
        const root = { render: vi.fn() } as unknown as Root

        await waitForWebAuthentication(root)

        expect(root.render).not.toHaveBeenCalled()
    })

    it('renders gate into root in browser environment', async () => {
        let renderedNode: any = null
        const root = {
            render: vi.fn((node: any) => {
                renderedNode = node
            }),
        } as unknown as Root

        const waitPromise = waitForWebAuthentication(root)
        expect(root.render).toHaveBeenCalledTimes(1)
        expect(renderedNode).toBeTruthy()

        // Extract and invoke onAuthenticated from rendered props
        const gateElement = renderedNode.props.children
        gateElement.props.onAuthenticated()
        await expect(waitPromise).resolves.toBeUndefined()
    })

    describe('startup orchestration integration with real DOM mounting', () => {
        it('blocks native bridge, grab, bootstrap and app render until browser authentication succeeds, then runs strictly once in order', async () => {
            const fetchMock = vi
                .fn()
                .mockResolvedValueOnce(
                    new Response(
                        JSON.stringify({ required: true, authenticated: false }),
                        { status: 200, headers: { 'Content-Type': 'application/json' } },
                    ),
                )
                .mockResolvedValueOnce(
                    new Response(
                        JSON.stringify({ authenticated: true }),
                        { status: 200, headers: { 'Content-Type': 'application/json' } },
                    ),
                )
            vi.stubGlobal('fetch', fetchMock)

            const container = document.createElement('div')
            document.body.appendChild(container)
            const root = createRoot(container)

            const executionOrder: string[] = []
            const initBrowserBridge = vi.fn(() => {
                executionOrder.push('initBrowserBridge')
            })
            const initReactGrab = vi.fn(async () => {
                executionOrder.push('initReactGrab')
            })
            const bootstrapApp = vi.fn(async () => {
                executionOrder.push('bootstrapApp')
            })
            const renderApp = vi.fn(() => {
                executionOrder.push('renderApp')
            })
            const dismissSplash = vi.fn(() => {
                executionOrder.push('dismissSplash')
            })

            const startupPromise = runStartup({
                root,
                initBrowserBridge,
                initReactGrab,
                bootstrapApp,
                renderApp,
                dismissSplash,
            })

            // Wait for WebAuthGate to be mounted in real DOM
            await waitFor(() => {
                expect(container.querySelector('input[type="password"]')).not.toBeNull()
            })

            // Crucial security assertion: BEFORE auth, none of the downstream subsystems must run
            expect(initBrowserBridge).not.toHaveBeenCalled()
            expect(initReactGrab).not.toHaveBeenCalled()
            expect(bootstrapApp).not.toHaveBeenCalled()
            expect(renderApp).not.toHaveBeenCalled()
            expect(executionOrder).toEqual([])

            // User enters password and submits
            const input = container.querySelector('input[type="password"]')!
            await act(async () => {
                fireEvent.change(input, { target: { value: 'correct-password' } })
                fireEvent.keyDown(input, { key: 'Enter' })
            })

            await startupPromise

            // Verify strictly ordered lifecycle execution
            expect(executionOrder).toEqual([
                'initBrowserBridge',
                'initReactGrab',
                'bootstrapApp',
                'renderApp',
            ])
            expect(initBrowserBridge).toHaveBeenCalledTimes(1)
            expect(initReactGrab).toHaveBeenCalledTimes(1)
            expect(bootstrapApp).toHaveBeenCalledTimes(1)
            expect(renderApp).toHaveBeenCalledTimes(1)
        })

        it('runs startup in Electron without auth fetch and executes lifecycle in order', async () => {
            Object.defineProperty(navigator, 'userAgent', {
                value: 'Mozilla/5.0 Electron/44.0.0',
                configurable: true,
            })

            const fetchMock = vi.fn()
            vi.stubGlobal('fetch', fetchMock)

            const container = document.createElement('div')
            document.body.appendChild(container)
            const root = createRoot(container)

            const executionOrder: string[] = []
            const initBrowserBridge = vi.fn(() => {
                executionOrder.push('initBrowserBridge')
            })
            const initReactGrab = vi.fn(async () => {
                executionOrder.push('initReactGrab')
            })
            const bootstrapApp = vi.fn(async () => {
                executionOrder.push('bootstrapApp')
            })
            const renderApp = vi.fn(() => {
                executionOrder.push('renderApp')
            })
            const dismissSplash = vi.fn(() => {
                executionOrder.push('dismissSplash')
            })

            await runStartup({
                root,
                initBrowserBridge,
                initReactGrab,
                bootstrapApp,
                renderApp,
                dismissSplash,
            })

            // Electron must never perform web auth fetch
            expect(fetchMock).toHaveBeenCalledTimes(0)

            expect(executionOrder).toEqual([
                'initBrowserBridge',
                'initReactGrab',
                'bootstrapApp',
                'renderApp',
            ])
            expect(initBrowserBridge).toHaveBeenCalledTimes(1)
            expect(initReactGrab).toHaveBeenCalledTimes(1)
            expect(bootstrapApp).toHaveBeenCalledTimes(1)
            expect(renderApp).toHaveBeenCalledTimes(1)
        })
    })
})

