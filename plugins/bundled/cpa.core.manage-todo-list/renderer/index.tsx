import { definePluginEntry } from '@cpa/plugin-sdk'
import type {
    ChatRendererContribution,
    FloatingContribution,
    PluginContext,
} from '@cpa/plugin-api'
import { MANAGE_TODO_LIST_TOOL_NAME } from '../agent/todoTool.js'
import { TodoProgressBar } from './components/TodoProgressBar.js'
import { TodoToolCard } from './components/TodoToolCard.js'
import { useTodoListStore } from '../shared/todoStore.js'

export { TodoProgressBar, TodoToolCard }

export const manageTodoListRendererEntry = definePluginEntry({
    runtime: 'renderer',
    activate(context: PluginContext) {
        context.register<FloatingContribution>({
            kind: 'floating',
            id: 'todo-progress-bar',
            value: {
                id: 'todo-progress-bar',
                pluginId: 'cpa.core.manage-todo-list',
                anchor: '[data-element="composer-container"]',
                placement: 'top-center',
                offset: { y: -8 },
                visible: (ctx: any) => {
                    if (ctx && 'sessionId' in ctx) {
                        return Boolean(ctx.sessionId)
                    }
                    return true
                },
                component: TodoProgressBar,
            },
        })

        context.register<ChatRendererContribution>({
            kind: 'chat-renderer',
            id: 'manage-todo-list-tool-card',
            value: {
                id: 'manage-todo-list-tool-card',
                priority: 50,
                matches: (part: any) =>
                    (part?.type === 'tool_call' || part?.type === 'toolCall') &&
                    (part?.name === MANAGE_TODO_LIST_TOOL_NAME ||
                        part?.toolName === MANAGE_TODO_LIST_TOOL_NAME ||
                        part?.name === 'manage_todo_list' ||
                        part?.toolName === 'manage_todo_list'),
                component: TodoToolCard,
            },
        })
    },
    deactivate() {
        useTodoListStore.getState().clearAll()
    },
})

export const entry = manageTodoListRendererEntry
export default manageTodoListRendererEntry
