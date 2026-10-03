import { act, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import i18n from '@/i18n'
import { HostServicesProvider } from '@cpa/plugin-ui'
import { SubAgentMetaText } from './SubAgentMetaText.js'

const agent = { sessionId: 'child', modelId: 'child-model', reasoningEffort: 'high' }

function setup(speed: string | undefined, supportsFast = true, reasoningLevels: any[] = []) {
    let record = { ...agent, speed }
    const services: any = {
        settings: { getSnapshot: () => settings },
        models: { getModels: () => [{ id: 'child-model', label: 'Child Model', supportsFast, reasoningLevels }] },

    }
    const settings = { speed: 'fast', modelId: 'different-model' }
    const { rerender } = render(
        <HostServicesProvider services={services}>
            <SubAgentMetaText agent={record} className="max-w-[42%]" />
        </HostServicesProvider>,
    )
    return {
        setSpeed(nextSpeed: string) {
            record = { ...record, speed: nextSpeed }
            rerender(
                <HostServicesProvider services={services}>
                    <SubAgentMetaText agent={record} className="max-w-[42%]" />
                </HostServicesProvider>,
            )
        },
    }
}

describe('SubAgentMetaText Fast indicator', () => {
    beforeEach(async () => {
        await i18n.changeLanguage('en')
    })

    it.each([
        ['fast', true, true],
        ['max', true, true],
        ['standard', true, false],
        [undefined, true, false],
        ['fast', false, false],
    ] as const)('uses recorded execution speed %s with support=%s rather than global speed', (speed, supportsFast, visible) => {
        setup(speed, supportsFast)
        const meta = screen.getByTestId('subagent-model-meta')
        expect(Boolean(meta.querySelector('.lucide-zap'))).toBe(visible)
        expect(meta).toHaveClass('inline-flex', 'min-w-0', 'max-w-[42%]')
        expect(meta.firstElementChild).toHaveClass('truncate')
        if (visible) {
            expect(meta.querySelector('.lucide-zap')).toHaveClass('shrink-0')
            expect(meta.querySelector('.lucide-zap')?.previousElementSibling).toHaveTextContent('Child Model')
            expect(meta.title).toContain('Fast')
        }
    })

    it('updates the shared metadata when execution speed changes', () => {
        const { setSpeed } = setup('standard')
        const meta = screen.getByTestId('subagent-model-meta')
        expect(meta.querySelector('.lucide-zap')).toBeNull()
        act(() => setSpeed('fast'))
        expect(meta.querySelector('.lucide-zap')).toBeInTheDocument()
        act(() => setSpeed('standard'))
        expect(meta.querySelector('.lucide-zap')).toBeNull()
    })
})
