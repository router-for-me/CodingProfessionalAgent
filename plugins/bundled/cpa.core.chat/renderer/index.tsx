import { definePluginEntry } from '@cpa/plugin-sdk'
import type {
    ChatRendererContribution,
    PluginContext,
    SlotContribution,
    ViewContribution,
} from '@cpa/plugin-api'
import { ChatView } from './components/ChatView.js'
import { TurnHeader } from './components/TurnHeader.js'
import { CompactionDivider } from './components/CompactionDivider.js'
import { ThinkingBlock } from './components/ThinkingBlock.js'
import { ToolCard } from './components/ToolCard.js'
import {
    UserMessageRenderer,
    AssistantMessageRenderer,
    AssistantText,
} from './components/MessageItem.js'

export {
    ChatView,
    TurnHeader,
    CompactionDivider,
    ThinkingBlock,
    ToolCard,
    UserMessageRenderer,
    AssistantMessageRenderer,
    AssistantText,
}

export const chatRendererEntry = definePluginEntry({
    runtime: 'renderer',
    activate(context: PluginContext) {
        // 1. Register Chat View
        context.register<ViewContribution>({
            kind: 'view',
            id: 'chat',
            value: {
                id: 'chat',
                path: '/chat/$sessionId',
                component: ChatView,
                layout: {
                    showComposer: true,
                    rightPanelMode: 'default',
                    reserveWindowToolbar: true,
                },
            },
        })

        // 2. Register Header Slot
        context.register<SlotContribution>({
            kind: 'slot',
            id: 'turn-header',
            target: 'chat.message.header',
            value: {
                id: 'turn-header',
                pluginId: 'cpa.core.chat',
                order: 10,
                component: TurnHeader as any,
            },
        })

        // 3. Register Chat Renderers
        context.register<ChatRendererContribution>({
            kind: 'chat-renderer',
            id: 'user-message',
            priority: 100,
            value: {
                id: 'user-message',
                priority: 100,
                matches: (msg: any) => (msg?.kind === 'message' && msg?.role === 'user') || msg?.role === 'user',
                component: UserMessageRenderer,
            },
        })

        context.register<ChatRendererContribution>({
            kind: 'chat-renderer',
            id: 'assistant-message',
            priority: 100,
            value: {
                id: 'assistant-message',
                priority: 100,
                matches: (msg: any) => (msg?.kind === 'message' && msg?.role === 'assistant') || msg?.role === 'assistant',
                component: AssistantMessageRenderer,
            },
        })

        context.register<ChatRendererContribution>({
            kind: 'chat-renderer',
            id: 'compaction-message',
            priority: 100,
            value: {
                id: 'compaction-message',
                priority: 100,
                matches: (msg: any) => msg?.kind === 'compaction',
                component: CompactionDivider,
            },
        })

        context.register<ChatRendererContribution>({
            kind: 'chat-renderer',
            id: 'thinking-part',
            priority: 100,
            value: {
                id: 'thinking-part',
                priority: 100,
                matches: (part: any) => part?.type === 'thinking',
                component: ThinkingBlock,
            },
        })

        context.register<ChatRendererContribution>({
            kind: 'chat-renderer',
            id: 'text-part',
            priority: 100,
            value: {
                id: 'text-part',
                priority: 100,
                matches: (part: any) => part?.type === 'text',
                component: AssistantText,
            },
        })

        context.register<ChatRendererContribution>({
            kind: 'chat-renderer',
            id: 'tool-call-part',
            priority: 200,
            value: {
                id: 'tool-call-part',
                priority: 200,
                matches: (part: any) => part?.type === 'tool_call',
                component: ToolCard,
            },
        })
    },
})

export const entry = chatRendererEntry
export default chatRendererEntry
