import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { UsageRing } from './UsageRing.js'
import * as pluginUiExports from './index.js'

describe('UsageRing Neutral UI Primitive', () => {
    it('renders a neutral SVG progress ring with clamped percentage', () => {
        const { rerender } = render(<UsageRing percent={42} size={20} strokeWidth={3} testId="test-ring" />)
        const ring = screen.getByTestId('test-ring')
        expect(ring).toBeDefined()
        const svg = ring.querySelector('svg')
        expect(svg).toBeDefined()
        expect(svg?.getAttribute('width')).toBe('20')
        expect(svg?.getAttribute('height')).toBe('20')

        // Clamps below 0 to 0% and above 100 to 100%
        rerender(<UsageRing percent={-10} testId="test-ring" />)
        expect(screen.getByTestId('test-ring')).toBeDefined()

        rerender(<UsageRing percent={150} testId="test-ring" />)
        expect(screen.getByTestId('test-ring')).toBeDefined()
    })

    it('renders custom title and aria-label', () => {
        render(
            <UsageRing
                percent={75}
                title="75% used"
                aria-label="Memory usage 75%"
                testId="test-ring"
            />,
        )
        const ring = screen.getByTestId('test-ring')
        expect(ring.getAttribute('title')).toBe('75% used')
        expect(ring.getAttribute('aria-label')).toBe('Memory usage 75%')
    })

    it('plugin-ui package boundary: keeps context-usage domain logic out of shared UI', () => {
        // Must NOT export composer/context token estimation (lives in @cpa/context-usage)
        expect((pluginUiExports as any).computeContextUsageBreakdown).toBeUndefined()
        expect((pluginUiExports as any).estimateTokens).toBeUndefined()
        expect((pluginUiExports as any).estimateContextTokens).toBeUndefined()
        expect((pluginUiExports as any).DEFAULT_CONTEXT_WINDOW).toBeUndefined()
        // Shared skill input primitives are intentionally exported from plugin-ui
        expect(typeof (pluginUiExports as any).parseSkillDraft).toBe('function')
        expect(typeof (pluginUiExports as any).SkillMenu).toBe('function')
        expect(typeof (pluginUiExports as any).SkillDraftEditor).toBe('function')
    })
})
