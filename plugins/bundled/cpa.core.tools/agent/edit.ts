/**
 * edit tool — exact/fuzzy multi-edit via NativeBridge + mutation queue.
 */

import type { NativeBridge, AgentTool, ToolExecutionContext, ToolResult } from './types.js'
import {
    applyMatchedEditsToNormalizedContent,
    applyMatchedEditsToOriginalContent,
    bytesEqual,
    computeLineDiffStats,
    detectLineEnding,
    generateDiffString,
    generateUnifiedPatch,
    matchEditsAgainstContent,
    normalizeToLF,
    stripBom,
    type TextEdit,
} from './editDiff.js'
import { withFileMutationQueue } from './mutationQueue.js'
import { pathNeedsHomeDir, resolveToolPath } from './path.js'
import {
    assertModificationWithinWorktree,
    type WorktreeFileBoundary,
} from './worktreeBoundary.js'

export type EditArgs = {
    path: string
    edits: TextEdit[]
} & Record<string, unknown>

const replaceEditSchema: Record<string, unknown> = {
    type: 'object',
    properties: {
        oldText: {
            type: 'string',
            minLength: 1,
            description:
                'Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call.',
        },
        newText: {
            type: 'string',
            description: 'Replacement text for this targeted edit.',
        },
    },
    required: ['oldText', 'newText'],
    additionalProperties: false,
}

const editsArraySchema: Record<string, unknown> = {
    type: 'array',
    description:
        'One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits. If two changes touch the same block or nearby lines, merge them into one edit instead.',
    items: replaceEditSchema,
    minItems: 1,
}

const editsJsonStringSchema: Record<string, unknown> = {
    type: 'string',
    minLength: 1,
    description:
        'JSON string encoding the edits array. Some models emit edits as a string; both array and JSON string forms are accepted.',
}

const editParameters: Record<string, unknown> = {
    type: 'object',
    properties: {
        path: {
            type: 'string',
            minLength: 1,
            description: 'Path to the file to edit (relative or absolute)',
        },
        edits: {
            description:
                'One or more targeted replacements as an array, or a JSON string encoding that array.',
            oneOf: [editsArraySchema, editsJsonStringSchema],
        },
    },
    required: ['path', 'edits'],
    additionalProperties: false,
}

const textEncoder = new TextEncoder()
// fatal:true rejects invalid UTF-8/binary; ignoreBOM:true keeps BOM code points in the string.
const textDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

export function createEditTool(
    cwd: string,
    bridge: NativeBridge,
    worktreeBoundary?: WorktreeFileBoundary,
): AgentTool<EditArgs> {
    return {
        name: 'edit',
        label: 'edit',
        description:
            'Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file. If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. Do not include large unchanged regions just to connect distant changes.',
        parameters: editParameters,
        validate(input: unknown): EditArgs {
            return validateEditArgs(input)
        },
        async execute(
            _toolCallId: string,
            args: EditArgs,
            context: ToolExecutionContext,
        ): Promise<ToolResult> {
            return executeEdit(cwd, bridge, args, context, worktreeBoundary)
        },
    }
}

/**
 * Validate and normalize edit arguments.
 * Accepts edits as an array or as a JSON string (some models emit the latter).
 * Never mutates the caller input object.
 */
export function validateEditArgs(input: unknown): EditArgs {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
        throw new Error('edit arguments must be an object')
    }
    const source = input as Record<string, unknown>
    for (const key of Object.keys(source)) {
        if (key !== 'path' && key !== 'edits') {
            throw new Error(`unknown argument: ${key}`)
        }
    }

    if (typeof source.path !== 'string' || source.path.length === 0) {
        throw new Error('path must be a non-empty string')
    }

    const edits = parseEditsField(source.edits)
    return {
        path: source.path,
        edits,
    }
}

function parseEditsField(raw: unknown): TextEdit[] {
    let value = raw
    if (typeof value === 'string') {
        if (value.length === 0) {
            throw new Error('edits JSON string must not be empty')
        }
        try {
            value = JSON.parse(value)
        } catch {
            throw new Error('edits JSON string is invalid')
        }
    }

    if (!Array.isArray(value)) {
        throw new Error('edits must be an array')
    }
    if (value.length === 0) {
        throw new Error('edits must contain at least one replacement')
    }

    const edits: TextEdit[] = []
    for (let i = 0; i < value.length; i++) {
        const item = value[i]
        if (typeof item !== 'object' || item === null || Array.isArray(item)) {
            throw new Error(`edits[${i}] must be an object`)
        }
        const record = item as Record<string, unknown>
        for (const key of Object.keys(record)) {
            if (key !== 'oldText' && key !== 'newText') {
                throw new Error(`edits[${i}] has unknown property: ${key}`)
            }
        }
        if (typeof record.oldText !== 'string') {
            throw new Error(`edits[${i}].oldText must be a string`)
        }
        if (record.oldText.length === 0) {
            throw new Error(`edits[${i}].oldText must not be empty`)
        }
        if (typeof record.newText !== 'string') {
            throw new Error(`edits[${i}].newText must be a string`)
        }
        edits.push({
            oldText: record.oldText,
            newText: record.newText,
        })
    }
    return edits
}

function wrapEditIOError(path: string, error: unknown): Error {
    const errorMessage =
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error as { code?: unknown }).code !== undefined
            ? `Error code: ${String((error as { code?: unknown }).code)}`
            : String(error)
    return new Error(`Could not edit file: ${path}. ${errorMessage}.`)
}

async function executeEdit(
    cwd: string,
    bridge: NativeBridge,
    args: EditArgs,
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

    return withFileMutationQueue(
        absolutePath,
        (path) => bridge.realPath(path),
        async () => {
            throwIfAborted(signal)

            let stat
            try {
                stat = await bridge.stat(absolutePath)
            } catch (error) {
                throwIfAborted(signal)
                throw wrapEditIOError(args.path, error)
            }
            throwIfAborted(signal)

            if (stat.isDir) {
                throw new Error(`Could not edit file: ${args.path}. Path is a directory.`)
            }

            let initialBytes: Uint8Array
            try {
                initialBytes = await bridge.readFile(absolutePath)
            } catch (error) {
                throwIfAborted(signal)
                throw wrapEditIOError(args.path, error)
            }
            throwIfAborted(signal)

            let rawContent: string
            try {
                rawContent = textDecoder.decode(initialBytes)
            } catch (error) {
                // Fatal UTF-8 decode: refuse binary/invalid files without writing.
                throw new Error(
                    `Could not edit file: ${args.path}. File is not valid UTF-8 (${String(error)}).`,
                )
            }

            // Strip exactly one leading BOM for matching; re-add it on write.
            const { bom, text: content } = stripBom(rawContent)
            const preferredEnding = detectLineEnding(content)
            const normalizedContent = normalizeToLF(content)

            // Match once; reuse the same replacement ranges for LF diff + mixed-EOL write.
            const matched = matchEditsAgainstContent(normalizedContent, args.edits, args.path)
            const baseContent = normalizedContent
            const newContent = applyMatchedEditsToNormalizedContent(normalizedContent, matched)
            if (baseContent === newContent) {
                throw new Error(
                    args.edits.length === 1
                        ? `No changes made to ${args.path}. The replacement produced identical content. This might indicate an issue with special characters or the text not existing as expected.`
                        : `No changes made to ${args.path}. The replacements produced identical content.`,
                )
            }

            // Build final bytes from original mixed-EOL lines + matched ranges (no global restore).
            const finalWithoutBom = applyMatchedEditsToOriginalContent(
                content,
                matched,
                preferredEnding,
            )
            const finalContent = bom + finalWithoutBom
            const outBytes = textEncoder.encode(finalContent)

            throwIfAborted(signal)

            let currentBytes: Uint8Array
            try {
                currentBytes = await bridge.readFile(absolutePath)
            } catch {
                throwIfAborted(signal)
                throw new Error(`File changed during edit: ${args.path}`)
            }
            throwIfAborted(signal)

            if (!bytesEqual(currentBytes, initialBytes)) {
                throw new Error(`File changed during edit: ${args.path}`)
            }

            throwIfAborted(signal)
            await bridge.writeFile(absolutePath, outBytes)
            throwIfAborted(signal)

            // Diff/patch stay on LF-normalized base/new content.
            const diffResult = generateDiffString(baseContent, newContent)
            const patch = generateUnifiedPatch(args.path, baseContent, newContent)
            const diffStats = computeLineDiffStats(baseContent, newContent)

            if (context.sessionId) {
                if (typeof (context as any).recordChange === 'function') {
                    (context as any).recordChange(context.sessionId, {
                        path: args.path,
                        additions: diffStats.additions,
                        deletions: diffStats.deletions,
                    })
                }
            }

            return {
                content: [
                    {
                        type: 'text',
                        text: `Successfully replaced ${args.edits.length} block(s) in ${args.path}.`,
                    },
                ],
                details: {
                    diff: diffResult.diff,
                    patch,
                    firstChangedLine: diffResult.firstChangedLine,
                    additions: diffStats.additions,
                    deletions: diffStats.deletions,
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
