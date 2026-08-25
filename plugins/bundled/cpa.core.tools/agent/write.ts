/**
 * write tool — create/overwrite files via NativeBridge + mutation queue.
 */

import type { NativeBridge, AgentTool, ToolExecutionContext, ToolResult } from './types.js'
import {
    computeLineDiffStats,
    generateDiffString,
    generateUnifiedPatch,
    normalizeToLF,
} from './editDiff.js'
import { withFileMutationQueue } from './mutationQueue.js'
import { dirnamePath, pathNeedsHomeDir, resolveToolPath } from './path.js'
import {
    assertModificationWithinWorktree,
    type WorktreeFileBoundary,
} from './worktreeBoundary.js'

export type WriteArgs = {
    path: string
    content: string
} & Record<string, unknown>

const writeParameters: Record<string, unknown> = {
    type: 'object',
    properties: {
        path: {
            type: 'string',
            description: 'Path to the file to write (relative or absolute)',
        },
        content: {
            type: 'string',
            description: 'Content to write to the file',
        },
    },
    required: ['path', 'content'],
    additionalProperties: false,
}

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true })

export function createWriteTool(
    cwd: string,
    bridge: NativeBridge,
    worktreeBoundary?: WorktreeFileBoundary,
): AgentTool<WriteArgs> {
    return {
        name: 'write',
        label: 'write',
        description:
            'Write content to a file. Creates the file if it doesn\'t exist, overwrites if it does. Automatically creates parent directories.',
        parameters: writeParameters,
        validate(input: unknown): WriteArgs {
            return validateWriteArgs(input)
        },
        async execute(
            _toolCallId: string,
            args: WriteArgs,
            context: ToolExecutionContext,
        ): Promise<ToolResult> {
            return executeWrite(cwd, bridge, args, context, worktreeBoundary)
        },
    }
}

export function validateWriteArgs(input: unknown): WriteArgs {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
        throw new Error('write arguments must be an object')
    }
    const source = input as Record<string, unknown>
    for (const key of Object.keys(source)) {
        if (key !== 'path' && key !== 'content') {
            throw new Error(`unknown argument: ${key}`)
        }
    }
    if (typeof source.path !== 'string' || source.path.length === 0) {
        throw new Error('path must be a non-empty string')
    }
    if (typeof source.content !== 'string') {
        throw new Error('content must be a string')
    }
    // Return a fresh object so callers cannot observe mutation of input.
    return {
        path: source.path,
        content: source.content,
    }
}

async function executeWrite(
    cwd: string,
    bridge: NativeBridge,
    args: WriteArgs,
    context: ToolExecutionContext,
    worktreeBoundary?: WorktreeFileBoundary,
): Promise<ToolResult> {
    const signal = context.signal
    throwIfAborted(signal)

    let homeDir: string | undefined
    if (pathNeedsHomeDir(args.path)) {
        const runtime = await bridge.runtimeInfo()
        throwIfAborted(signal)
        homeDir = runtime.homeDir
    }
    // Normal path semantics only — no macOS filename fuzzy matching.
    const absolutePath = resolveToolPath(args.path, cwd, { homeDir })

    if (worktreeBoundary) {
        await assertModificationWithinWorktree({
            resolvedPath: absolutePath,
            boundary: worktreeBoundary,
            bridge,
        })
        throwIfAborted(signal)
    }

    const parent = dirnamePath(absolutePath)
    const bytes = textEncoder.encode(args.content)

    return withFileMutationQueue(
        absolutePath,
        (path) => bridge.realPath(path),
        async () => {
            // Observe aborts after queue wait / before any filesystem mutation.
            throwIfAborted(signal)

            let existingContent: string | null = null
            try {
                const existingBytes = await bridge.readFile(absolutePath)
                existingContent = textDecoder.decode(existingBytes)
            } catch {
                existingContent = null
            }
            throwIfAborted(signal)

            if (parent && parent !== absolutePath) {
                await bridge.mkdirAll(parent)
            }
            throwIfAborted(signal)

            await bridge.writeFile(absolutePath, bytes)
            throwIfAborted(signal)

            let additions = 0
            let deletions = 0
            let diff: string | undefined
            let patch: string | undefined

            const newContentLf = normalizeToLF(args.content)
            if (existingContent === null) {
                const lines = newContentLf.split('\n')
                additions = args.content.length > 0 ? lines.length : 0
                deletions = 0
                patch = generateUnifiedPatch(args.path, '', newContentLf)
            } else {
                const oldContentLf = normalizeToLF(existingContent)
                const stats = computeLineDiffStats(oldContentLf, newContentLf)
                additions = stats.additions
                deletions = stats.deletions
                const diffResult = generateDiffString(oldContentLf, newContentLf)
                diff = diffResult.diff
                patch = generateUnifiedPatch(args.path, oldContentLf, newContentLf)
            }

            if (context.sessionId) {
                if (typeof (context as any).recordChange === 'function') {
                    (context as any).recordChange(context.sessionId, {
                        path: args.path,
                        additions,
                        deletions,
                    })
                }
            }

            return {
                content: [
                    {
                        type: 'text',
                        text: `Successfully wrote ${bytes.byteLength} bytes to ${absolutePath}`,
                    },
                ],
                details: {
                    additions,
                    deletions,
                    diff,
                    patch,
                },
            }
        },
        signal,
    )
}

function throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) {
        throw new Error('Operation aborted')
    }
}
