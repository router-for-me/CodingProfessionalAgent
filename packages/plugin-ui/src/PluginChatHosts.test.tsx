import { describe, expect, it, vi } from 'vitest'
import React from 'react'
import { render, screen } from '@testing-library/react'
import {
    HostServicesProvider,
    PluginMessageHost,
    PluginPartHost,
    matchChatRenderer,
    resolvePartGroupKey,
} from './index.js'
import type { ChatRendererContribution } from '@cpa/plugin-api'

describe('PluginChatHosts and matching logic (@cpa/plugin-ui)', () => {
    it('matches chat renderer strictly by target/scope', () => {
        const renderers: ChatRendererContribution<any>[] = [
            {
                id: 'msg-renderer',
                target: 'message',
                priority: 10,
                matches: () => true,
                component: () => <div>Msg</div>,
            },
            {
                id: 'part-renderer',
                target: 'part',
                priority: 10,
                matches: () => true,
                component: () => <div>Part</div>,
            },
        ]

        const message = { kind: 'message', role: 'user' }
        const part = { type: 'text', text: 'hi' }

        expect(matchChatRenderer(renderers, message, { target: 'message' })?.id).toBe('msg-renderer')
        expect(matchChatRenderer(renderers, part, { target: 'part' })?.id).toBe('part-renderer')
        expect(matchChatRenderer(renderers, message, { target: 'part' })?.id).toBe('part-renderer')
    })

    it('resolves part groupKey metadata correctly', () => {
        const renderers: ChatRendererContribution<any>[] = [
            {
                id: 'subagent-pills',
                target: 'part',
                priority: 50,
                groupKey: 'subagent',
                matches: (p: any) => p.type === 'tool_call' && p.name === 'spawn_agent',
                component: () => <div>Subagent</div>,
            },
            {
                id: 'function-key-renderer',
                target: 'part',
                priority: 50,
                groupKey: (p: any) => (p.name === 'custom_tool' ? 'custom_group' : undefined),
                matches: (p: any) => p.type === 'tool_call' && p.name === 'custom_tool',
                component: () => <div>Custom</div>,
            },
            {
                id: 'default-tools',
                target: 'part',
                priority: 100,
                groupKey: 'tools',
                matches: (p: any) => p.type === 'tool_call',
                component: () => <div>Tool</div>,
            },
        ]

        expect(resolvePartGroupKey({ type: 'tool_call', name: 'spawn_agent' }, renderers)).toBe('subagent')
        expect(resolvePartGroupKey({ type: 'tool_call', name: 'custom_tool' }, renderers)).toBe('custom_group')
        expect(resolvePartGroupKey({ type: 'tool_call', name: 'bash' }, renderers)).toBe('tools')
        expect(resolvePartGroupKey({ type: 'text', text: 'hello' }, renderers)).toBeUndefined()
    })

    it('handles throwing renderers gracefully in PluginPartHost', () => {
        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
        const renderers: ChatRendererContribution<any>[] = [
            {
                id: 'broken-part-renderer',
                target: 'part',
                priority: 10,
                matches: (p: any) => p.type === 'broken',
                component: () => {
                    throw new Error('Broken part component')
                },
            },
        ]

        const services: any = {
            rendererContributions: {
                getChatRenderers: () => renderers,
                selectChatRenderer: (val: any, opts: any) => matchChatRenderer(renderers, val, opts),
            },
        }

        render(
            <HostServicesProvider services={services}>
                <PluginPartHost part={{ type: 'broken' }} />
            </HostServicesProvider>,
        )

        expect(screen.getByTestId('unsupported-part')).toBeInTheDocument()
        consoleSpy.mockRestore()
    })
})
