// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://example.com/cpa/#/example/123?tab=files"}

import { act, render, screen, waitFor } from '@testing-library/react'
import { RouterProvider } from '@tanstack/react-router'
import { describe, expect, it, vi } from 'vitest'
import { viewRegistry } from '@/application/views/viewRegistry'

vi.mock('@/components/layout/AppShell', async () => {
    const { Outlet } = await import('@tanstack/react-router')
    return { AppShell: Outlet }
})
vi.mock('@/application/services/createHostServices', () => ({
    setHostRouter: vi.fn(),
}))

import { router } from './router'

describe('Browser hash routing', () => {
    it('restores deep links and supports navigation and history under a deployment prefix', async () => {
        const layout = {
            showComposer: false,
            rightPanelMode: 'hidden' as const,
            reserveWindowToolbar: false,
        }
        const unregisterHome = viewRegistry.registerView({
            id: 'test-home',
            path: '/',
            component: () => <div>Home page</div>,
            layout,
        })
        const unregisterDetail = viewRegistry.registerView({
            id: 'test-detail',
            path: '/example/$itemId',
            component: () => <div>Detail page</div>,
            layout,
        })
        const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => {})

        try {
            expect(router.history.location.pathname).toBe('/example/123')
            expect(router.history.location.search).toBe('?tab=files')
            render(<RouterProvider router={router} />)
            expect(await screen.findByText('Detail page')).toBeInTheDocument()

            await act(async () => {
                await router.navigate({ to: '/' })
            })
            expect(await screen.findByText('Home page')).toBeInTheDocument()
            expect(window.location.hash).toBe('#/')
            expect(window.location.pathname).toBe('/cpa/')

            await act(async () => {
                router.history.back()
                await new Promise<void>((resolve) => {
                    window.addEventListener('popstate', () => resolve(), { once: true })
                })
            })
            await waitFor(() => expect(router.state.location.pathname).toBe('/example/123'))
            expect(await screen.findByText('Detail page')).toBeInTheDocument()
            expect(window.location.hash).toBe('#/example/123?tab=files')

            await act(async () => {
                router.history.forward()
                await new Promise<void>((resolve) => {
                    window.addEventListener('popstate', () => resolve(), { once: true })
                })
            })
            expect(await screen.findByText('Home page')).toBeInTheDocument()
            expect(window.location.pathname).toBe('/cpa/')
        } finally {
            act(() => {
                unregisterDetail()
                unregisterHome()
            })
            scrollTo.mockRestore()
        }
    })
})
