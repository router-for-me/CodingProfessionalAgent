import React, { memo, type ReactNode } from 'react'
import { useChatRenderers, usePartRenderer, matchChatRenderer } from './HostServicesContext.js'
import { ChatRendererErrorBoundary } from './ChatRendererErrorBoundary.js'
import { UnsupportedChatElement } from './UnsupportedChatElement.js'

export interface PluginPartHostProps {
    part?: any
    value?: any
    message?: any
    sessionKey?: string
    index?: number
    streaming?: boolean
    isLast?: boolean
    onApprove?: (toolId: string) => void
    onReject?: (toolId: string) => void
    onApproveTool?: (toolId: string) => void
    onRejectTool?: (toolId: string) => void
    toolOverlays?: Readonly<Record<string, any>>
    compactActivity?: boolean
    isRunActive?: boolean
    fallback?: ReactNode
    className?: string
    [key: string]: any
}

export const PluginPartHost = memo(function PluginPartHost(props: PluginPartHostProps) {
    const part = props.value ?? props.part
    const renderers = useChatRenderers()
    const renderer = usePartRenderer(part)

    if (!renderer || !renderer.component) {
        return props.fallback ?? <UnsupportedChatElement value={part} type="part" />
    }

    const Component = renderer.component
    const onApprove = props.onApprove ?? props.onApproveTool
    const onReject = props.onReject ?? props.onRejectTool

    const fallbackFn = () => {
        if (props.fallback) return props.fallback
        const nextRenderer = matchChatRenderer(renderers, part, {
            target: 'part',
            excludeIds: [renderer.id],
        })
        if (nextRenderer && nextRenderer.component && nextRenderer.id !== renderer.id) {
            const NextComponent = nextRenderer.component
            return (
                <ChatRendererErrorBoundary
                    id={nextRenderer.id}
                    pluginId={nextRenderer.pluginId}
                    fallback={<UnsupportedChatElement value={part} type="part" />}
                >
                    <NextComponent
                        {...props}
                        value={part}
                        part={part}
                        message={props.message}
                        onApprove={onApprove}
                        onReject={onReject}
                        onApproveTool={onApprove}
                        onRejectTool={onReject}
                    />
                </ChatRendererErrorBoundary>
            )
        }
        return <UnsupportedChatElement value={part} type="part" />
    }

    return (
        <ChatRendererErrorBoundary
            id={renderer.id}
            pluginId={renderer.pluginId}
            fallback={fallbackFn}
        >
            <Component
                {...props}
                value={part}
                part={part}
                message={props.message}
                onApprove={onApprove}
                onReject={onReject}
                onApproveTool={onApprove}
                onRejectTool={onReject}
            />
        </ChatRendererErrorBoundary>
    )
})
