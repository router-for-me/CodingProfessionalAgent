import React, { memo, type ReactNode } from 'react'
import { useChatRenderers, useMessageRenderer, matchChatRenderer } from './HostServicesContext.js'
import { ChatRendererErrorBoundary } from './ChatRendererErrorBoundary.js'
import { UnsupportedChatElement } from './UnsupportedChatElement.js'

export interface PluginMessageHostProps {
    message?: any
    value?: any
    sessionKey?: string
    onApproveTool?: (toolId: string) => void
    onRejectTool?: (toolId: string) => void
    onEditMessage?: (messageId: string, text: string) => void | Promise<void>
    onRetry?: () => void | Promise<void>
    onFork?: () => void | Promise<void>
    onExecuteHook?: () => void | Promise<void>
    toolOverlays?: Readonly<Record<string, any>>
    compactActivity?: boolean
    collapsedText?: string
    isRunActive?: boolean
    fallback?: ReactNode
    className?: string
    [key: string]: any
}

export const PluginMessageHost = memo(function PluginMessageHost(props: PluginMessageHostProps) {
    const message = props.value ?? props.message
    const renderers = useChatRenderers()
    const renderer = useMessageRenderer(message)

    if (!renderer || !renderer.component) {
        return props.fallback ?? <UnsupportedChatElement value={message} type="message" />
    }

    const Component = renderer.component

    const fallbackFn = () => {
        if (props.fallback) return props.fallback
        const nextRenderer = matchChatRenderer(renderers, message, {
            target: 'message',
            excludeIds: [renderer.id],
        })
        if (nextRenderer && nextRenderer.component && nextRenderer.id !== renderer.id) {
            const NextComponent = nextRenderer.component
            return (
                <ChatRendererErrorBoundary
                    id={nextRenderer.id}
                    pluginId={nextRenderer.pluginId}
                    fallback={<UnsupportedChatElement value={message} type="message" />}
                >
                    <NextComponent
                        {...props}
                        value={message}
                        message={message}
                    />
                </ChatRendererErrorBoundary>
            )
        }
        return <UnsupportedChatElement value={message} type="message" />
    }

    return (
        <ChatRendererErrorBoundary
            id={renderer.id}
            pluginId={renderer.pluginId}
            fallback={fallbackFn}
        >
            <Component
                {...props}
                value={message}
                message={message}
            />
        </ChatRendererErrorBoundary>
    )
})
