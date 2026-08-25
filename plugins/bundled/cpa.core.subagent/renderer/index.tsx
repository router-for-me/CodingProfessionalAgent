import React from 'react'
import { definePluginEntry } from '@cpa/plugin-sdk'
import type {
    ActionContribution,
    ChatRendererContribution,
    PanelContribution,
    PluginContext,
    SettingsSectionContribution,
    SlotContribution,
} from '@cpa/plugin-api'
import {
    Bot,
    Cat,
    ExtensionSlot,
    getDefaultHostServices,
} from '@cpa/plugin-ui'
import {
    SubAgentPanelContent,
    type SubAgentPanelContentProps,
} from './components/SubAgentPanelContent.js'
import { SubAgentTabHeaders } from './components/SubAgentTabHeaders.js'
import { SubAgentPills } from './components/SubAgentPills.js'
import { PinnedSubAgentsSection } from './components/PinnedSubAgentsSection.js'
import { SubagentsSection } from './components/SubagentsSection.js'

export { SubAgentPanelContent, SubAgentTabHeaders, SubAgentPills, PinnedSubAgentsSection, SubagentsSection }
export type { SubAgentPanelContentProps }

function isSpawnAgentName(name?: string): boolean {
    return name === 'spawn_agent' || name === 'delegate_agent' || name === 'subagent'
}

const DEFAULT_RIGHT_SIDEBAR_WIDTH = 280
const DEFAULT_RIGHT_SIDEBAR_CONVERSATION_WIDTH = 420

const SubAgentPanelSlotView = (props: any) =>
    React.createElement(ExtensionSlot, {
        name: 'layout.right_panel.content',
        props,
        fallback: React.createElement(SubAgentPanelContent, props),
    })

export const subagentRendererEntry = definePluginEntry({
    runtime: 'renderer',
    activate(context: PluginContext) {
        // 1. Right Panel Content Slot Contribution
        context.register<SlotContribution>({
            kind: 'slot',
            id: 'subagent-content',
            target: 'layout.right_panel.content',
            value: {
                id: 'subagent-content',
                pluginId: 'cpa.core.subagent',
                order: 10,
                component: SubAgentPanelContent,
            },
        })

        // 1b. Chat message subagent pills slot (used by compact Activity MessageItem)
        context.register<SlotContribution>({
            kind: 'slot',
            id: 'subagent-pills-slot',
            target: 'chat.message.subagents',
            value: {
                id: 'subagent-pills-slot',
                pluginId: 'cpa.core.subagent',
                order: 10,
                component: SubAgentPills,
            },
        })

        // 1c. Pinned summary sub-agent section (avatar, model meta, status)
        context.register<SlotContribution>({
            kind: 'slot',
            id: 'pinned-summary-subagents',
            target: 'pinned.summary.subagents',
            value: {
                id: 'pinned-summary-subagents',
                pluginId: 'cpa.core.subagent',
                order: 10,
                component: PinnedSubAgentsSection,
            },
        })

        // 2. Right Sidebar Panel Contribution
        context.register<PanelContribution>({
            kind: 'panel',
            id: 'subagent',
            value: {
                id: 'subagent',
                pluginId: 'cpa.core.subagent',
                title: 'Subagents',
                titleKey: 'subagent.title',
                icon: Bot,
                order: 10,
                preferredWidth: (ctx: any) => {
                    const services = ctx?.services ?? (context as any).services ?? getDefaultHostServices()
                    const sessionId = ctx?.activeSessionId
                    if (!sessionId) return DEFAULT_RIGHT_SIDEBAR_CONVERSATION_WIDTH
                    const focusedId = services?.subAgents?.getFocusedId?.(sessionId)
                    return focusedId ? DEFAULT_RIGHT_SIDEBAR_CONVERSATION_WIDTH : DEFAULT_RIGHT_SIDEBAR_WIDTH
                },
                instancePolicy: 'multiple',
                headerActionsComponent: SubAgentTabHeaders,
                hasOpenTabs: (sessionId?: string | null) => {
                    if (!sessionId) return false
                    const services = (context as any).services ?? getDefaultHostServices()
                    const agents = services?.subAgents?.getAgents
                        ? services.subAgents.getAgents(sessionId)
                        : []
                    return agents.length > 0
                },
                component: SubAgentPanelSlotView,
                onOpen: (_ctx: any) => {},
                onClose: (ctx: any) => {
                    if (ctx?.instanceId && ctx.activeSessionId && ctx.instanceId !== 'subagent') {
                        const services = ctx?.services ?? (context as any).services ?? getDefaultHostServices()
                        services?.subAgents?.closeTab?.(ctx.activeSessionId, ctx.instanceId)
                    }
                },
            },
        })

        // 3. Action: Toggle Activity View
        context.register<ActionContribution>({
            kind: 'action',
            id: 'toggle-activity-view',
            value: {
                id: 'toggle-activity-view',
                title: 'shortcuts.item.toggleActivityView.title',
                description: 'shortcuts.item.toggleActivityView.desc',
                defaultShortcuts: ['Meta+Alt+U'],
                handler: (actionCtx: any) => {
                    const uiService = (actionCtx?.services as any)?.ui ?? (context as any).services?.ui
                    uiService?.openRightPanelTab?.('subagent')
                },
            },
        })

        // 4. Action: Show Pet
        context.register<ActionContribution>({
            kind: 'action',
            id: 'show-pet',
            value: {
                id: 'show-pet',
                title: 'user.showPet',
                description: 'shortcuts.item.showPet.desc',
                icon: Cat,
                placements: [{ surface: 'menu.user', order: 20 }],
                handler: (actionCtx: any) => {
                    const uiService = (actionCtx?.services as any)?.ui ?? (context as any).services?.ui
                    uiService?.pushToast?.('toast.comingSoon')
                },
            },
        })

        // 5. Chat Renderer: Subagent Pills (groupKey drives compact spawn segments)
        context.register<ChatRendererContribution>({
            kind: 'chat-renderer',
            id: 'subagent-pills',
            priority: 50,
            value: {
                id: 'subagent-pills',
                priority: 50,
                target: 'part',
                groupKey: 'subagent',
                matches: (part: any) => part?.type === 'tool_call' && isSpawnAgentName(part?.name),
                component: SubAgentPills,
            },
        })

        // 6. Settings Section: Subagents
        context.register<SettingsSectionContribution>({
            kind: 'settings',
            id: 'subagents',
            value: {
                id: 'subagents',
                groupId: 'code',
                order: 25,
                labelKey: 'settings.nav.subagents',
                icon: Bot,
                component: SubagentsSection,
                keywords: ['subagent', 'subagents', 'concurrency', 'level', 'depth'],
                items: [
                    {
                        id: 'subagentsEnabled',
                        labelKey: 'settings.subagents.enabled',
                        descriptionKey: 'settings.subagents.enabledDesc',
                        keywords: ['subagent', 'enable'],
                    },
                    {
                        id: 'subagentsConcurrency',
                        labelKey: 'settings.subagents.concurrency',
                        descriptionKey: 'settings.subagents.concurrencyDesc',
                        keywords: ['concurrency', 'global'],
                    },
                    {
                        id: 'subagentsMaxPerSession',
                        labelKey: 'settings.subagents.maxPerSession',
                        descriptionKey: 'settings.subagents.maxPerSessionDesc',
                        keywords: ['max per session', 'subagent'],
                    },
                    {
                        id: 'subagentsMaxDepth',
                        labelKey: 'settings.subagents.maxDepth',
                        descriptionKey: 'settings.subagents.maxDepthDesc',
                        keywords: ['max level', 'max depth'],
                    },
                ],
            },
        })
    },
})

export const entry = subagentRendererEntry
export default subagentRendererEntry
