import {
    createBrowserImageProcessor,
    createCapabilityNativeAdapter,
    definePluginEntry,
} from '@cpa/plugin-sdk'
import type {
    PluginContext,
    ToolFactoryContribution,
    ToolFactoryContext,
} from '@cpa/plugin-api'
import { createReadTool } from './read.js'
import { createBashTool } from './bash.js'
import { createPwshTool } from './pwsh.js'
import { createEditTool } from './edit.js'
import { createWriteTool } from './write.js'
import { isWindowsPlatform } from './shell.js'
import { createWorktreeFileBoundary } from './worktreeBoundary.js'

export {
    createReadTool,
    createBashTool,
    createPwshTool,
    createEditTool,
    createWriteTool,
}

export const READ_TOOL_PARAMETERS = {
    type: 'object',
    properties: {
        path: { type: 'string', description: 'Path to the file to read (relative or absolute)' },
        offset: { type: 'number', description: 'Line number to start reading from (1-indexed)' },
        limit: { type: 'number', description: 'Maximum number of lines to read' },
    },
    required: ['path'],
} as const

export const SHELL_TOOL_PARAMETERS = {
    type: 'object',
    properties: {
        command: { type: 'string', description: 'Shell command to execute' },
        timeout: { type: 'number', description: 'Timeout in seconds (optional, no default timeout)' },
    },
    required: ['command'],
} as const

export const EDIT_TOOL_PARAMETERS = {
    type: 'object',
    properties: {
        path: { type: 'string', description: 'Path to the file to edit (relative or absolute)' },
        edits: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    oldText: {
                        type: 'string',
                        description:
                            'Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call.',
                    },
                    newText: { type: 'string', description: 'Replacement text for this targeted edit.' },
                },
                required: ['oldText', 'newText'],
            },
            description:
                'One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits. If two changes touch the same block or nearby lines, merge them into one edit instead.',
        },
    },
    required: ['path', 'edits'],
} as const

export const WRITE_TOOL_PARAMETERS = {
    type: 'object',
    properties: {
        path: { type: 'string', description: 'Path to the file to write (relative or absolute)' },
        content: { type: 'string', description: 'Content to write to the file' },
    },
    required: ['path', 'content'],
} as const

export const toolsAgentEntry = definePluginEntry({
    runtime: 'agent',
    activate(context: PluginContext) {
        const client = context.capabilityClient ?? ((context as any).capabilities?.invoke ? (context as any).capabilities : undefined)
        const scopedBridge = client ? createCapabilityNativeAdapter(client) : undefined

        context.register<ToolFactoryContribution>({
            kind: 'tool-factory',
            id: 'read',
            value: {
                id: 'read',
                name: 'read',
                label: 'Read File',
                description: 'Read the contents of a file. Supports text files and images (jpg, png, gif, webp, bmp).',
                parameters: READ_TOOL_PARAMETERS as unknown as Record<string, unknown>,
                order: 10,
                targets: ['main', 'subagent', 'all'],
                riskLevel: 'read',
                requiresApproval: false,
                approvalCategory: 'filesystem-read',
                create: async (ctx: ToolFactoryContext) => {
                    const bridge = (ctx as any).bridge ?? scopedBridge
                    if (!bridge) {
                        throw new Error('No bridge or capabilities available for read tool')
                    }
                    const cwd = ctx.cwd ?? ''
                    const model = (ctx as any).model ?? {
                        id: 'default-model',
                        label: 'Default Model',
                        supportsFast: true,
                        reasoningLevels: [],
                        input: ['text', 'image'],
                        contextWindow: 128_000,
                        maxTokens: 8_192,
                    }
                    const imageProcessor = (ctx as any).imageProcessor ?? createBrowserImageProcessor()
                    const worktreeBoundary = (ctx as any).worktreePolicy
                        ? await createWorktreeFileBoundary((ctx as any).worktreePolicy, bridge)
                        : undefined

                    return createReadTool(cwd, bridge, imageProcessor, model, worktreeBoundary)
                },
            },
        })

        context.register<ToolFactoryContribution>({
            kind: 'tool-factory',
            id: 'shell',
            value: {
                id: 'shell',
                name: 'shell',
                label: 'Execute Shell Command',
                description:
                    'Execute a command in the user shell (bash / pwsh) with live streaming output and cancellation support.',
                parameters: SHELL_TOOL_PARAMETERS as unknown as Record<string, unknown>,
                order: 20,
                targets: ['main', 'subagent', 'all'],
                riskLevel: 'process',
                requiresApproval: true,
                approvalCategory: 'shell-execution',
                aliases: ['pwsh', 'powershell', 'bash'],
                create: async (ctx: ToolFactoryContext) => {
                    const bridge = (ctx as any).bridge ?? scopedBridge
                    if (!bridge) {
                        throw new Error('No bridge or capabilities available for shell tool')
                    }
                    const cwd = ctx.cwd ?? ''
                    const isWindows = isWindowsPlatform(ctx.platform)
                    return isWindows ? createPwshTool(cwd, bridge) : createBashTool(cwd, bridge)
                },
            },
        })

        context.register<ToolFactoryContribution>({
            kind: 'tool-factory',
            id: 'edit',
            value: {
                id: 'edit',
                name: 'edit',
                label: 'Edit File',
                description: 'Targeted text file modification via exact search-and-replace blocks.',
                parameters: EDIT_TOOL_PARAMETERS as unknown as Record<string, unknown>,
                order: 30,
                targets: ['main', 'subagent', 'all'],
                riskLevel: 'write',
                requiresApproval: true,
                approvalCategory: 'filesystem-write',
                create: async (ctx: ToolFactoryContext) => {
                    const bridge = (ctx as any).bridge ?? scopedBridge
                    if (!bridge) {
                        throw new Error('No bridge or capabilities available for edit tool')
                    }
                    const cwd = ctx.cwd ?? ''
                    const worktreeBoundary = (ctx as any).worktreePolicy
                        ? await createWorktreeFileBoundary((ctx as any).worktreePolicy, bridge)
                        : undefined
                    return createEditTool(cwd, bridge, worktreeBoundary)
                },
            },
        })

        context.register<ToolFactoryContribution>({
            kind: 'tool-factory',
            id: 'write',
            value: {
                id: 'write',
                name: 'write',
                label: 'Write File',
                description: 'Write full text content to a file, creating any parent directories automatically.',
                parameters: WRITE_TOOL_PARAMETERS as unknown as Record<string, unknown>,
                order: 40,
                targets: ['main', 'subagent', 'all'],
                riskLevel: 'write',
                requiresApproval: true,
                approvalCategory: 'filesystem-write',
                create: async (ctx: ToolFactoryContext) => {
                    const bridge = (ctx as any).bridge ?? scopedBridge
                    if (!bridge) {
                        throw new Error('No bridge or capabilities available for write tool')
                    }
                    const cwd = ctx.cwd ?? ''
                    const worktreeBoundary = (ctx as any).worktreePolicy
                        ? await createWorktreeFileBoundary((ctx as any).worktreePolicy, bridge)
                        : undefined
                    return createWriteTool(cwd, bridge, worktreeBoundary)
                },
            },
        })
    },
})

export const entry = toolsAgentEntry
export default toolsAgentEntry
