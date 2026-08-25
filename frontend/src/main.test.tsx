import { describe, expect, it, vi } from 'vitest'
import { runStartup } from './main'
import type { Root } from 'react-dom/client'
import React from 'react'
import { observeReactPerformanceMeasures } from './lib/reactPerformanceMeasures'

vi.mock('./lib/reactPerformanceMeasures', () => ({
    observeReactPerformanceMeasures: vi.fn(() => vi.fn()),
}))

describe('main startup error UI', () => {
    it('installs development timing cleanup before application startup', () => {
        expect(observeReactPerformanceMeasures).toHaveBeenCalledOnce()
    })

  it('renders fatal startup error using CSS variables and theme tokens', async () => {
    let renderedElement: React.ReactElement | null = null
    const mockRoot: Root = {
      render: vi.fn((elem: React.ReactElement) => {
        renderedElement = elem
      }),
      unmount: vi.fn(),
    }

    const failingBootstrap = vi.fn().mockRejectedValue(new Error('Test bootstrap explosion'))

    await expect(
      runStartup({
        root: mockRoot,
        waitForWebAuth: async () => {},
        initBrowserBridge: () => {},
        initReactGrab: async () => {},
        bootstrapApp: failingBootstrap,
      }),
    ).rejects.toThrow('Test bootstrap explosion')

    expect(mockRoot.render).toHaveBeenCalled()
    expect(renderedElement).not.toBeNull()

    const style = (renderedElement as any)?.props?.style ?? {}
    expect(style.fontFamily).toContain('var(--font-sans')
    expect(style.backgroundColor).toContain('var(--bg-app')
  })
})
