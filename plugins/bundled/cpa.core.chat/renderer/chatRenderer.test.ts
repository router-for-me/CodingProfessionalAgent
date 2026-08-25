import { describe, expect, it } from 'vitest'
import { createPluginTestHarness } from '@cpa/plugin-sdk'
import type { ChatRendererContribution, SlotContribution, ViewContribution } from '@cpa/plugin-api'
import {
    chatRendererEntry,
    ChatView,
    TurnHeader,
    ThinkingBlock,
    ToolCard,
    UserMessageRenderer,
    AssistantMessageRenderer,
    AssistantText,
    CompactionDivider,
} from './index.js'
import manifest from '../manifest.json' with { type: 'json' }

describe('chatRendererEntry', () => {
    it('declares renderer runtime entry', () => {
        expect(chatRendererEntry.runtime).toBe('renderer')
    })

    it('activates and registers all declared contributions', async () => {
        const harness = createPluginTestHarness(chatRendererEntry, {
            manifest,
        })

        await harness.activate()

        const views = harness.getRegistered<ViewContribution>('view')
        expect(views).toHaveLength(1)
        expect(views[0]?.id).toBe('chat')
        expect(views[0]?.value).toMatchObject({
            id: 'chat',
            path: '/chat/$sessionId',
            component: ChatView,
            layout: {
                showComposer: true,
                rightPanelMode: 'default',
                reserveWindowToolbar: true,
            },
        })

        const slots = harness.getRegistered<SlotContribution>('slot')
        expect(slots).toHaveLength(1)
        expect(slots[0]?.id).toBe('turn-header')
        expect(slots[0]?.value).toMatchObject({
            id: 'turn-header',
            pluginId: 'cpa.core.chat',
            order: 10,
            component: TurnHeader,
        })

        const chatRenderers = harness.getRegistered<ChatRendererContribution>('chat-renderer')
        expect(chatRenderers).toHaveLength(6)

        const rendererIds = chatRenderers.map((r) => r.id)
        expect(rendererIds).toContain('user-message')
        expect(rendererIds).toContain('assistant-message')
        expect(rendererIds).toContain('compaction-message')
        expect(rendererIds).toContain('thinking-part')
        expect(rendererIds).toContain('text-part')
        expect(rendererIds).toContain('tool-call-part')

        const userMsg = chatRenderers.find((r) => r.id === 'user-message')
        expect(userMsg?.value.component).toBe(UserMessageRenderer)

        const asstMsg = chatRenderers.find((r) => r.id === 'assistant-message')
        expect(asstMsg?.value.component).toBe(AssistantMessageRenderer)

        const compMsg = chatRenderers.find((r) => r.id === 'compaction-message')
        expect(compMsg?.value.component).toBe(CompactionDivider)

        const thinkPart = chatRenderers.find((r) => r.id === 'thinking-part')
        expect(thinkPart?.value.component).toBe(ThinkingBlock)

        const textPart = chatRenderers.find((r) => r.id === 'text-part')
        expect(textPart?.value.component).toBe(AssistantText)

        const toolPart = chatRenderers.find((r) => r.id === 'tool-call-part')
        expect(toolPart?.value.component).toBe(ToolCard)
    })

    it('cleans up all registered contributions on deactivation', async () => {
        const harness = createPluginTestHarness(chatRendererEntry, {
            manifest,
        })

        await harness.activate()
        expect(harness.getRegistered('view')).toHaveLength(1)
        expect(harness.getRegistered('slot')).toHaveLength(1)
        expect(harness.getRegistered('chat-renderer')).toHaveLength(6)

        await harness.deactivate()
        expect(harness.getRegistered('view')).toHaveLength(0)
        expect(harness.getRegistered('slot')).toHaveLength(0)
        expect(harness.getRegistered('chat-renderer')).toHaveLength(0)
    })
})
