/**
 * read tool — text truncation + image attachments via NativeBridge.
 */

import type { ModelCatalogEntry } from '@cpa/plugin-api'
import type { NativeBridge, AgentTool, ToolExecutionContext, ToolResult } from './types.js'
import type { ImageProcessor } from './image.js'
import { detectImageMimeType } from './image.js'
import { expandPath, pathNeedsHomeDir, resolveReadPath } from './path.js'
import {
    DEFAULT_MAX_BYTES,
    DEFAULT_MAX_LINES,
    formatSize,
    splitLinesForCounting,
    truncateHead,
    utf8ByteLength,
} from './truncate.js'
import {
    assertRelativeReadWithinWorktree,
    type WorktreeFileBoundary,
} from './worktreeBoundary.js'

export type ReadArgs = {
    path: string
    offset?: number
    limit?: number
} & Record<string, unknown>

export interface CreateReadToolOptions {
    imageProcessor: ImageProcessor
    model: ModelCatalogEntry
}

const NON_VISION_IMAGE_NOTE =
    '[Current model does not support images. The image will be omitted from this request.]'

const readParameters: Record<string, unknown> = {
    type: 'object',
    properties: {
        path: {
            type: 'string',
            description: 'Path to the file to read (relative or absolute)',
        },
        offset: {
            type: 'integer',
            minimum: 1,
            description: 'Line number to start reading from (1-indexed)',
        },
        limit: {
            type: 'integer',
            minimum: 1,
            description: 'Maximum number of lines to read',
        },
    },
    required: ['path'],
    additionalProperties: false,
}

export function createReadTool(
    cwd: string,
    bridge: NativeBridge,
    imageProcessor: ImageProcessor,
    model: ModelCatalogEntry,
    worktreeBoundary?: WorktreeFileBoundary,
): AgentTool<ReadArgs> {
    return {
        name: 'read',
        label: 'read',
        description: `Read the contents of a file. Supports text files and images (jpg, png, gif, webp, bmp). Images are sent as attachments. For text files, output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.`,
        parameters: readParameters,
        validate(input: unknown): ReadArgs {
            return validateReadArgs(input)
        },
        async execute(
            _toolCallId: string,
            args: ReadArgs,
            context: ToolExecutionContext,
        ): Promise<ToolResult> {
            return executeRead(
                cwd,
                bridge,
                imageProcessor,
                model,
                args,
                context,
                worktreeBoundary,
            )
        },
    }
}

export function validateReadArgs(input: unknown): ReadArgs {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
        throw new Error('read arguments must be an object')
    }
    // Do not mutate caller args.
    const source = input as Record<string, unknown>
    for (const key of Object.keys(source)) {
        if (key !== 'path' && key !== 'offset' && key !== 'limit') {
            throw new Error(`unknown argument: ${key}`)
        }
    }

    const path = source.path
    if (typeof path !== 'string' || path.length === 0) {
        throw new Error('path must be a non-empty string')
    }

    const result: ReadArgs = { path }

    if (source.offset !== undefined) {
        if (!isPositiveInteger(source.offset)) {
            throw new Error('offset must be a 1-based positive integer')
        }
        result.offset = source.offset
    }
    if (source.limit !== undefined) {
        if (!isPositiveInteger(source.limit)) {
            throw new Error('limit must be a positive integer')
        }
        result.limit = source.limit
    }

    return result
}

async function executeRead(
    cwd: string,
    bridge: NativeBridge,
    imageProcessor: ImageProcessor,
    model: ModelCatalogEntry,
    args: ReadArgs,
    context: ToolExecutionContext,
    worktreeBoundary?: WorktreeFileBoundary,
): Promise<ToolResult> {
    const signal = context.signal
    throwIfAborted(signal)

    // Platform is always needed for darwin filename fallbacks; homeDir only when path uses ~.
    const runtime = await raceAbort(
        bridge.runtimeInfo ? bridge.runtimeInfo() : Promise.resolve({ platform: 'darwin', homeDir: '/Users/test', userConfigDir: '', tempDir: '' }),
        signal,
    )
    throwIfAborted(signal)
    const absolutePath = await raceAbort(
        resolveReadPath(args.path, cwd, bridge, {
            platform: runtime.platform,
            homeDir: pathNeedsHomeDir(args.path) ? runtime.homeDir : undefined,
        }),
        signal,
    )
    throwIfAborted(signal)

    const expandedRequestedPath = expandPath(args.path, {
        homeDir: pathNeedsHomeDir(args.path) ? runtime.homeDir : undefined,
    })

    if (worktreeBoundary) {
        await raceAbort(
            assertRelativeReadWithinWorktree({
                requestedPath: expandedRequestedPath,
                resolvedPath: absolutePath,
                boundary: worktreeBoundary,
                bridge,
            }),
            signal,
        )
    }

    await raceAbort(bridge.stat(absolutePath), signal)
    const bytes = await raceAbort(bridge.readFile(absolutePath), signal)

    const mimeType = detectImageMimeType(bytes)
    if (mimeType) {
        const result = await raceAbort(
            buildImageResult(bytes, mimeType, imageProcessor, model),
            signal,
        )
        throwIfAborted(signal)
        return result
    }

    throwIfAborted(signal)
    return buildTextResult(bytes, args)
}

async function buildImageResult(
    bytes: Uint8Array,
    mimeType: string,
    imageProcessor: ImageProcessor,
    model: ModelCatalogEntry,
): Promise<ToolResult> {
    const nonVisionNote = modelSupportsImages(model) ? undefined : NON_VISION_IMAGE_NOTE
    const processed = await imageProcessor.process(bytes, mimeType)

    if (!processed.ok) {
        let textNote = `Read image file [${mimeType}]\n${processed.message}`
        if (nonVisionNote) {
            textNote += `\n${nonVisionNote}`
        }
        return { content: [{ type: 'text', text: textNote }] }
    }

    let textNote = `Read image file [${processed.mimeType}]`
    if (processed.hints.length > 0) {
        textNote += `\n${processed.hints.join('\n')}`
    }
    if (nonVisionNote) {
        textNote += `\n${nonVisionNote}`
        // Non-vision models must never receive image blocks.
        return { content: [{ type: 'text', text: textNote }] }
    }

    return {
        content: [
            { type: 'text', text: textNote },
            { type: 'image', data: processed.data, mimeType: processed.mimeType },
        ],
    }
}

function buildTextResult(bytes: Uint8Array, args: ReadArgs): ToolResult {
    const textContent = decodeUtf8PreserveBom(bytes)
    const allLines = splitLinesForCounting(textContent)
    const totalFileLines = allLines.length

    if (totalFileLines === 0) {
        if (args.offset !== undefined) {
            throw new Error(`Offset ${args.offset} is beyond end of file (0 lines total)`)
        }
        return { content: [{ type: 'text', text: textContent }] }
    }

    const startLine = args.offset !== undefined ? args.offset - 1 : 0
    const startLineDisplay = startLine + 1

    if (startLine >= allLines.length) {
        throw new Error(
            `Offset ${args.offset} is beyond end of file (${allLines.length} lines total)`,
        )
    }

    let selectedContent: string
    let selectedLineCount: number
    const readingToEnd =
        args.limit === undefined || startLine + args.limit >= allLines.length

    if (args.offset === undefined && args.limit === undefined) {
        // Preserve original newline layout (including trailing newline).
        selectedContent = textContent
        selectedLineCount = totalFileLines
    } else if (args.limit !== undefined) {
        const endLine = Math.min(startLine + args.limit, allLines.length)
        selectedContent = allLines.slice(startLine, endLine).join('\n')
        selectedLineCount = endLine - startLine
    } else {
        selectedContent = allLines.slice(startLine).join('\n')
        selectedLineCount = allLines.length - startLine
        // Preserve a trailing newline when reading through EOF of a trailing-NL file.
        if (textContent.endsWith('\n')) {
            selectedContent += '\n'
        }
    }

    const truncation = truncateHead(selectedContent, {
        maxLines: DEFAULT_MAX_LINES,
        maxBytes: DEFAULT_MAX_BYTES,
    })

    let outputText: string
    let details: unknown

    if (truncation.firstLineExceedsLimit) {
        const firstLineSize = formatSize(utf8ByteLength(allLines[startLine] ?? ''))
        outputText = `[Line ${startLineDisplay} is ${firstLineSize}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use bash: sed -n '${startLineDisplay}p' ${args.path} | head -c ${DEFAULT_MAX_BYTES}]`
        details = { truncation }
    } else if (truncation.truncated) {
        const endLineDisplay = startLineDisplay + truncation.outputLines - 1
        const nextOffset = endLineDisplay + 1
        outputText = truncation.content
        if (truncation.truncatedBy === 'lines') {
            outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines}. Use offset=${nextOffset} to continue.]`
        } else {
            outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Use offset=${nextOffset} to continue.]`
        }
        details = { truncation }
    } else if (!readingToEnd) {
        const remaining = allLines.length - (startLine + selectedLineCount)
        const nextOffset = startLine + selectedLineCount + 1
        outputText = `${truncation.content}\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`
    } else {
        outputText = truncation.content
    }

    return {
        content: [{ type: 'text', text: outputText }],
        details,
    }
}

/**
 * Decode UTF-8 keeping every BOM code point (including double BOM).
 * ignoreBOM:true means the decoder does not strip a leading BOM.
 */
export function decodeUtf8PreserveBom(bytes: Uint8Array): string {
    return new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes)
}

function modelSupportsImages(model: ModelCatalogEntry): boolean {
    return model.input ? model.input.includes('image') : false
}

function isPositiveInteger(value: unknown): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value >= 1
}

function throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) {
        throw new Error('Operation aborted')
    }
}

/**
 * Race a promise against abort. Rejects immediately on abort and never returns
 * success after abort. Underlying settlement is always observed (no unhandled).
 */
function raceAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) {
        return promise
    }
    if (signal.aborted) {
        void promise.then(
            () => undefined,
            () => undefined,
        )
        return Promise.reject(new Error('Operation aborted'))
    }

    return new Promise<T>((resolve, reject) => {
        let settled = false
        const onAbort = () => {
            if (settled) {
                return
            }
            settled = true
            signal.removeEventListener('abort', onAbort)
            void promise.then(
                () => undefined,
                () => undefined,
            )
            reject(new Error('Operation aborted'))
        }

        signal.addEventListener('abort', onAbort)
        promise.then(
            (value) => {
                if (settled) {
                    return
                }
                settled = true
                signal.removeEventListener('abort', onAbort)
                if (signal.aborted) {
                    reject(new Error('Operation aborted'))
                    return
                }
                resolve(value)
            },
            (error) => {
                if (settled) {
                    return
                }
                settled = true
                signal.removeEventListener('abort', onAbort)
                reject(error)
            },
        )
    })
}
