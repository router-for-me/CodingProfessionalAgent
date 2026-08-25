// @vitest-environment jsdom

import { act, render, screen } from '@testing-library/react'
import { RouterProvider } from '@tanstack/react-router'
import { describe, expect, it, vi } from 'vitest'
import { viewRegistry } from '@/application/views/viewRegistry'

vi.hoisted(() => {
    // Change the URL after environment setup so jsdom can initialize localStorage.
    const environment = globalThis as unknown as {
        jsdom: { reconfigure: (options: { url: string }) => void }
    }
    environment.jsdom.reconfigure({
        url: 'file:///Applications/CPA.app/Contents/Resources/app.asar/frontend/dist/index.html',
    })
})

vi.mock('@/components/layout/AppShell', async () => {
    const { Outlet } = await import('@tanstack/react-router')
    return { AppShell: Outlet }
})
vi.mock('@/application/services/createHostServices', () => ({
    setHostRouter: vi.fn(),
}))

import { router } from './router'

describe('Packaged Electron routing', () => {
    it('renders the registered home view from a file URL and keeps navigation in the hash', async () => {
        const documentPath = window.location.pathname
        const unregisterHome = viewRegistry.registerView({
            id: 'test-home',
            path: '/',
            component: () => <div>New session page</div>,
            layout: {
                showComposer: true,
                rightPanelMode: 'default',
                reserveWindowToolbar: true,
            },
        })

        try {
            expect(router.history.location.pathname).toBe('/')
            render(<RouterProvider router={router} />)
            expect(await screen.findByText('New session page')).toBeInTheDocument()

            expect(router.history.createHref('/example/123')).toBe(
                `${documentPath}#/example/123`,
            )
            expect(window.location.pathname).toBe(documentPath)
        } finally {
            act(() => unregisterHome())
        }
    })
})
