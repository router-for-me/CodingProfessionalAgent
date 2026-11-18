import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import i18n from '@/i18n'
import type { DisplayMessage } from '../types.js'
import { MessageList } from './MessageList.js'

const firstMessage: DisplayMessage = {
    kind: 'message',
    id: 'u1',
    sessionId: 's1',
    role: 'user',
    content: 'Start a task',
    parts: [{ type: 'text', text: 'Start a task' }],
    createdAt: 1,
}

const handlers = {
    onApproveTool: () => undefined,
    onRejectTool: () => undefined,
}

describe.each([false, true])('MessageList system prompt build (compact=%s)', (compactActivity) => {
    beforeEach(async () => {
        await i18n.changeLanguage('en')
    })

    it.each([
        ['en', 'Building enhanced system prompt'],
        ['zh-CN', '正在构建增强性系统提示词'],
    ])('shows a localized, non-interactive live summary before any tools (%s)', async (locale, label) => {
        await i18n.changeLanguage(locale)
        const { rerender } = render(
            <MessageList
                {...handlers}
                compactActivity={compactActivity}
                messages={[]}
                isBuildingSystemPrompt
            />,
        )

        const status = screen.getByRole('status')
        expect(status).toHaveAttribute('data-testid', 'system-prompt-build-status')
        expect(status).toHaveAttribute('aria-live', 'polite')
        expect(status).toHaveAttribute('aria-atomic', 'true')
        expect(status).toHaveTextContent(label)
        expect(within(status).getByText(label)).toHaveClass('animate-text-shimmer')
        expect(status.closest('button')).toBeNull()
        expect(status).not.toHaveAttribute('tabindex')
        expect(within(status).queryByRole('button')).not.toBeInTheDocument()
        expect(screen.queryByTestId('tool-activity')).not.toBeInTheDocument()
        expect(screen.queryByTestId('turn-header')).not.toBeInTheDocument()

        rerender(
            <MessageList
                {...handlers}
                compactActivity={compactActivity}
                messages={[firstMessage]}
                isBuildingSystemPrompt
            />,
        )
        expect(screen.getByRole('status')).toHaveTextContent(label)
        expect(screen.getByText('Start a task')).toBeInTheDocument()
    })

    it('keeps completed history intact and removes only the ephemeral summary when building stops', () => {
        const messages: DisplayMessage[] = [
            firstMessage,
            {
                kind: 'message',
                id: 'a1',
                sessionId: 's1',
                role: 'assistant',
                content: 'Previous reply',
                parts: [
                    { type: 'tool_call', id: 't1', name: 'read', args: { path: 'old.ts' }, status: 'done', result: 'old content' },
                    { type: 'text', text: 'Previous reply' },
                ],
                status: 'done',
                createdAt: 2,
                completedAt: 3,
            },
        ]
        const originalMessages = structuredClone(messages)
        const view = (building: boolean) => (
            <MessageList
                {...handlers}
                compactActivity={compactActivity}
                messages={messages}
                isBuildingSystemPrompt={building}
                contentTestId="build-test-content"
            />
        )
        const { rerender } = render(view(false))
        const history = screen.getByTestId('build-test-content').innerHTML
        expect(screen.queryByTestId('system-prompt-build-status')).not.toBeInTheDocument()

        rerender(view(true))
        const status = screen.getByRole('status')
        expect(screen.getByText('Previous reply')).toBeInTheDocument()
        expect(screen.getByTestId('build-test-content').lastElementChild).toBe(status)
        expect(messages).toEqual(originalMessages)

        rerender(view(false))
        expect(screen.queryByTestId('system-prompt-build-status')).not.toBeInTheDocument()
        expect(screen.getByTestId('build-test-content').innerHTML).toBe(history)
        expect(messages).toEqual(originalMessages)
    })

    it('does not infer prompt building from an active run', () => {
        render(
            <MessageList
                {...handlers}
                compactActivity={compactActivity}
                messages={[firstMessage]}
                isRunActive
            />,
        )
        expect(screen.queryByTestId('system-prompt-build-status')).not.toBeInTheDocument()
    })

    it.each([false, true])('follows build status changes only when pinned to the bottom (pinned=%s)', (pinned) => {
        const messages = [firstMessage]
        const view = (building: boolean) => (
            <MessageList
                {...handlers}
                compactActivity={compactActivity}
                messages={messages}
                sessionKey="s1"
                isBuildingSystemPrompt={building}
            />
        )
        const { rerender } = render(view(false))
        const scroller = screen.getByTestId('message-list-scroller')
        let scrollHeight = 800
        Object.defineProperty(scroller, 'scrollHeight', { configurable: true, get: () => scrollHeight })
        Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 200 })
        scroller.scrollTop = pinned ? 600 : 20
        fireEvent.scroll(scroller)

        scrollHeight = 840
        rerender(view(true))
        expect(screen.getByRole('status')).toBeInTheDocument()
        expect(scroller.scrollTop).toBe(pinned ? 840 : 20)

        scrollHeight = 800
        rerender(view(false))
        expect(screen.queryByTestId('system-prompt-build-status')).not.toBeInTheDocument()
        expect(scroller.scrollTop).toBe(pinned ? 800 : 20)
    })
})
