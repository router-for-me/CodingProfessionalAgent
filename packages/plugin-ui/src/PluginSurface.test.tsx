import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { PluginSurface } from './PluginSurface.js'

describe('PluginSurface', () => {
    it('renders children when there is no error', () => {
        render(
            <PluginSurface pluginId="example" contributionId="view/main">
                <div data-testid="child">Normal Content</div>
            </PluginSurface>,
        )
        expect(screen.getByTestId('child')).toHaveTextContent('Normal Content')
    })

    it('reports a plugin surface render failure with identity', () => {
        const report = vi.fn()
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
        const Broken = () => {
            throw new Error('broken')
        }
        render(
            <PluginSurface pluginId="example" contributionId="view/main" onError={report}>
                <Broken />
            </PluginSurface>,
        )
        expect(report).toHaveBeenCalledWith(
            expect.objectContaining({
                pluginId: 'example',
                contributionId: 'view/main',
                error: expect.any(Error),
            }),
        )
        consoleError.mockRestore()
    })

    it('renders custom fallback element when provided', () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
        const Broken = () => {
            throw new Error('boom')
        }
        render(
            <PluginSurface
                pluginId="example"
                contributionId="view/main"
                fallback={<div data-testid="custom-fallback">Custom Error View</div>}
            >
                <Broken />
            </PluginSurface>,
        )
        expect(screen.getByTestId('custom-fallback')).toHaveTextContent('Custom Error View')
        consoleError.mockRestore()
    })

    it('renders custom fallback function with error details', () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
        const Broken = () => {
            throw new Error('failed to render')
        }
        render(
            <PluginSurface
                pluginId="example"
                contributionId="view/main"
                fallback={(err, info) => (
                    <div data-testid="custom-fn-fallback">
                        Error in {info.pluginId}: {err.message}
                    </div>
                )}
            >
                <Broken />
            </PluginSurface>,
        )
        expect(screen.getByTestId('custom-fn-fallback')).toHaveTextContent('Error in example: failed to render')
        consoleError.mockRestore()
    })

    it('renders neutral default fallback UI when render fails without custom fallback', () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
        const Broken = () => {
            throw new Error('unhandled plugin failure')
        }
        render(
            <PluginSurface pluginId="plugin.test" contributionId="panel/debug">
                <Broken />
            </PluginSurface>,
        )
        expect(screen.getByRole('alert')).toBeInTheDocument()
        expect(screen.getByRole('alert')).toHaveTextContent('plugin.test')
        consoleError.mockRestore()
    })
})
