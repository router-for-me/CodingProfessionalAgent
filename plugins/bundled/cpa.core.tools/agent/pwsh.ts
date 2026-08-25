/**
 * Streaming cross-platform pwsh (PowerShell) tool backed by NativeBridge process APIs.
 *
 * - PowerShell resolution via resolvePowerShell (prefers pwsh.exe / PowerShell 7).
 * - UTF-8 output encoding prefix ensures reliable non-ASCII output on Windows.
 * - Bounded WebView output via OutputAccumulator (full log on native side).
 * - Unified AbortController for user abort + timeout (single cancel owner).
 * - Stop (timer/user abort) races with iterator.next(); buffered terminal wins
 *   over an already-resolved stop in the same tick.
 * - After selectedStop wins, only await next until a real terminal (no re-race,
 *   no fixed drain count). Without an observed terminal, never remove the log.
 */

import type { NativeBridge, NativeEvent, ProcessOperation } from './types.js'
import type { AgentTool, ToolExecutionContext, ToolResult } from './types.js'
import { OutputAccumulator } from './outputAccumulator.js'
import { resolvePowerShell, UTF8_OUTPUT_PREFIX, type ShellEnv } from './shell.js'
import {
    DEFAULT_MAX_BYTES,
    DEFAULT_MAX_LINES,
    formatSize,
    type TruncateResult,
} from './truncate.js'

export const DEFAULT_PWSH_TIMEOUT_SECONDS = 30
const MAX_TIMEOUT_MS = 2_147_483_647
const MAX_TIMEOUT_SECONDS = MAX_TIMEOUT_MS / 1000
const PWSH_UPDATE_THROTTLE_MS = 100

export type PwshArgs = {
    command: string
    timeout?: number
} & Record<string, unknown>

export interface CreatePwshToolOptions {
    maxLines?: number
    maxBytes?: number
    shellPath?: string
    env?: ShellEnv
    /** Injectable clock for throttle / timeout tests. */
    now?: () => number
    schedule?: (callback: () => void, delayMs: number) => unknown
    cancelSchedule?: (handle: unknown) => void
}

export interface PwshToolDetails {
    truncation?: TruncateResult
    fullOutputPath?: string
    cleanupDiagnostic?: string
}

const pwshParameters: Record<string, unknown> = {
    type: 'object',
    properties: {
        command: {
            type: 'string',
            minLength: 1,
            description: 'PowerShell / pwsh command to execute',
        },
        timeout: {
            type: 'number',
            exclusiveMinimum: 0,
            maximum: MAX_TIMEOUT_SECONDS,
            description: `Timeout in seconds (optional, default: ${DEFAULT_PWSH_TIMEOUT_SECONDS})`,
        },
    },
    required: ['command'],
    additionalProperties: false,
}

export function createPwshTool(
    cwd: string,
    bridge: NativeBridge,
    options: CreatePwshToolOptions = {},
): AgentTool<PwshArgs> {
    const maxLines = options.maxLines ?? DEFAULT_MAX_LINES
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
    // Validate bounds early so misconfigured tools fail at construction.
    if (!Number.isInteger(maxLines) || maxLines < 1) {
        throw new Error('maxLines must be a positive integer')
    }
    if (!Number.isInteger(maxBytes) || maxBytes < 1) {
        throw new Error('maxBytes must be a positive integer')
    }

    const now = options.now ?? (() => Date.now())
    const schedule =
        options.schedule ?? ((cb: () => void, ms: number) => setTimeout(cb, ms))
    const cancelSchedule =
        options.cancelSchedule ??
        ((handle: unknown) => {
            clearTimeout(handle as ReturnType<typeof setTimeout>)
        })

    return {
        name: 'pwsh',
        label: 'pwsh',
        description: `Execute a PowerShell/pwsh command in the current working directory. Returns stdout and stderr. Output is truncated to last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds (default: ${DEFAULT_PWSH_TIMEOUT_SECONDS}).`,
        parameters: pwshParameters,
        validate(input: unknown): PwshArgs {
            return validatePwshArgs(input)
        },
        async execute(
            _toolCallId: string,
            args: PwshArgs,
            context: ToolExecutionContext,
        ): Promise<ToolResult> {
            return executePwsh(cwd, bridge, args, context, {
                maxLines,
                maxBytes,
                shellPath: options.shellPath,
                env: options.env,
                now,
                schedule,
                cancelSchedule,
            })
        },
    }
}

/** Alias for createPwshTool with name 'powershell' if needed. */
export const createPowerShellTool = createPwshTool

export function validatePwshArgs(input: unknown): PwshArgs {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
        throw new Error('pwsh arguments must be an object')
    }
    const source = input as Record<string, unknown>
    for (const key of Object.keys(source)) {
        if (key !== 'command' && key !== 'timeout') {
            throw new Error(`unknown argument: ${key}`)
        }
    }

    if (typeof source.command !== 'string' || source.command.length === 0) {
        throw new Error('command must be a non-empty string')
    }

    const result: PwshArgs = { command: source.command }

    if (source.timeout !== undefined) {
        result.timeout = resolveTimeoutSeconds(source.timeout)
    }

    return result
}

function resolveTimeoutSeconds(timeout: unknown): number {
    if (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout <= 0) {
        throw new Error('Invalid timeout: must be a finite number of seconds greater than 0')
    }
    const timeoutMs = timeout * 1000
    if (timeoutMs > MAX_TIMEOUT_MS) {
        throw new Error(`Invalid timeout: maximum is ${MAX_TIMEOUT_SECONDS} seconds`)
    }
    return timeout
}

interface ExecuteOptions {
    maxLines: number
    maxBytes: number
    shellPath?: string
    env?: ShellEnv
    now: () => number
    schedule: (callback: () => void, delayMs: number) => unknown
    cancelSchedule: (handle: unknown) => void
}

type StopReason = 'abort' | 'timeout'

type TerminalState =
    | { kind: 'done'; exitCode: number }
    | { kind: 'error'; error: string }
    | { kind: 'cancelled'; error?: string }
    | { kind: 'protocol'; error: string }

interface FinalizeResult {
    snapshot: { content: string; truncation: TruncateResult }
    text: string
    retainedPath: string | undefined
    cleanupDiagnostic: string | undefined
}

function pushDiagnostic(bucket: string[], value: string | undefined | null): void {
    if (!value) {
        return
    }
    const trimmed = value.trim()
    if (!trimmed) {
        return
    }
    if (bucket.includes(trimmed)) {
        return
    }
    bucket.push(trimmed)
}

function errorText(error: unknown, fallback: string): string {
    if (error instanceof Error && error.message) {
        return error.message
    }
    if (typeof error === 'string' && error.length > 0) {
        return error
    }
    return fallback
}

async function executePwsh(
    cwd: string,
    bridge: NativeBridge,
    args: PwshArgs,
    context: ToolExecutionContext,
    options: ExecuteOptions,
): Promise<ToolResult> {
    const timeoutSeconds = args.timeout ?? DEFAULT_PWSH_TIMEOUT_SECONDS
    const timeoutMs = Math.floor(timeoutSeconds * 1000)

    const output = new OutputAccumulator({
        maxLines: options.maxLines,
        maxBytes: options.maxBytes,
    })

    const onUpdate = context.onUpdate
    let updateTimer: unknown
    let updateDirty = false
    let lastUpdateAt = 0
    let fullOutputPath: string | undefined
    let acceptingOutput = true
    let finalized = false

    const safeUpdate = (partial: ToolResult): void => {
        if (!onUpdate) {
            return
        }
        try {
            onUpdate(partial)
        } catch {
            // Isolate UI callback failures so the process lifecycle still completes.
        }
    }

    const emitOutputUpdate = (): void => {
        if (!onUpdate || !updateDirty) {
            return
        }
        updateDirty = false
        lastUpdateAt = options.now()
        const snapshot = output.snapshot()
        const details: PwshToolDetails = {}
        if (snapshot.truncation.truncated) {
            details.truncation = snapshot.truncation
            if (fullOutputPath) {
                details.fullOutputPath = fullOutputPath
            }
        }
        safeUpdate({
            content: snapshot.content
                ? [{ type: 'text', text: snapshot.content }]
                : [],
            details: Object.keys(details).length > 0 ? details : undefined,
        })
    }

    const clearUpdateTimer = (): void => {
        if (updateTimer !== undefined) {
            options.cancelSchedule(updateTimer)
            updateTimer = undefined
        }
    }

    const scheduleOutputUpdate = (): void => {
        if (!onUpdate) {
            return
        }
        updateDirty = true
        const delay = PWSH_UPDATE_THROTTLE_MS - (options.now() - lastUpdateAt)
        if (delay <= 0) {
            clearUpdateTimer()
            emitOutputUpdate()
            return
        }
        if (updateTimer === undefined) {
            updateTimer = options.schedule(() => {
                updateTimer = undefined
                emitOutputUpdate()
            }, delay)
        }
    }

    if (onUpdate) {
        safeUpdate({ content: [], details: undefined })
    }

    const internal = new AbortController()
    let selectedStop: StopReason | null = null
    let stopArmed = false

    let resolveStopPromise: ((reason: StopReason) => void) | undefined
    const stopPromise = new Promise<StopReason>((resolve) => {
        resolveStopPromise = resolve
    })
    void stopPromise.then(
        () => undefined,
        () => undefined,
    )

    const signalStop = (reason: StopReason): void => {
        if (stopArmed) {
            return
        }
        stopArmed = true
        resolveStopPromise?.(reason)
    }

    const armSelectedStop = (reason: StopReason): void => {
        if (selectedStop !== null) {
            return
        }
        selectedStop = reason
        if (!internal.signal.aborted) {
            internal.abort()
        }
    }

    const onUserAbort = (): void => {
        signalStop('abort')
    }

    let timeoutHandle: unknown
    const userSignal = context.signal
    if (userSignal) {
        if (userSignal.aborted) {
            signalStop('abort')
        } else {
            userSignal.addEventListener('abort', onUserAbort)
        }
    }

    if (timeoutMs !== undefined) {
        timeoutHandle = options.schedule(() => {
            signalStop('timeout')
        }, timeoutMs)
    }

    const cleanupListeners = (): void => {
        if (userSignal) {
            userSignal.removeEventListener('abort', onUserAbort)
        }
        if (timeoutHandle !== undefined) {
            options.cancelSchedule(timeoutHandle)
            timeoutHandle = undefined
        }
        clearUpdateTimer()
    }

    let operation: ProcessOperation | undefined
    let iterator: AsyncIterator<NativeEvent> | undefined
    let terminal: TerminalState | null = null
    let outputError: unknown = null
    let streamError: unknown = null
    let pendingNext: Promise<IteratorResult<NativeEvent>> | undefined
    let streamEnded = false

    const recordTerminal = (next: TerminalState): void => {
        if (terminal !== null) {
            return
        }
        terminal = next
        acceptingOutput = false
    }

    const getTerminal = (): TerminalState | null => terminal

    const requestCancel = (): void => {
        if (!internal.signal.aborted) {
            internal.abort()
        }
    }

    const handleEvent = (event: NativeEvent): void => {
        if (event.kind === 'process-stdout' || event.kind === 'process-stderr') {
            if (!acceptingOutput) {
                return
            }
            let bytes: Uint8Array
            try {
                bytes = decodeEventData(event)
            } catch (decodeError) {
                outputError =
                    decodeError instanceof Error
                        ? decodeError
                        : new Error('malformed process output')
                acceptingOutput = false
                requestCancel()
                return
            }
            if (event.kind === 'process-stdout') {
                output.appendStdout(bytes)
            } else {
                output.appendStderr(bytes)
            }
            scheduleOutputUpdate()
            return
        }

        if (event.kind === 'done') {
            if (typeof event.exitCode !== 'number' || !Number.isInteger(event.exitCode)) {
                recordTerminal({
                    kind: 'protocol',
                    error: 'protocol error: done event missing integer exitCode',
                })
                return
            }
            recordTerminal({ kind: 'done', exitCode: event.exitCode })
            return
        }

        if (event.kind === 'cancelled') {
            recordTerminal({
                kind: 'cancelled',
                error: typeof event.error === 'string' ? event.error : undefined,
            })
            return
        }

        if (event.kind === 'error') {
            recordTerminal({
                kind: 'error',
                error: event.error ?? 'process error',
            })
        }
    }

    const handleIteratorResult = (result: IteratorResult<NativeEvent>): void => {
        if (result.done) {
            streamEnded = true
            if (terminal === null) {
                streamError = new Error('Process stream closed before terminal event')
            }
            return
        }
        if (!result.value) {
            return
        }
        handleEvent(result.value)
    }

    const consumeUntilSettled = async (): Promise<void> => {
        if (!iterator) {
            return
        }

        while (terminal === null && streamError === null && !streamEnded) {
            if (!pendingNext) {
                pendingNext = iterator.next()
            }

            if (selectedStop !== null) {
                try {
                    const result = await pendingNext
                    pendingNext = undefined
                    handleIteratorResult(result)
                } catch (error) {
                    streamError = error
                    break
                }
                continue
            }

            type RaceOutcome =
                | { source: 'next'; result: IteratorResult<NativeEvent> }
                | { source: 'stop'; reason: StopReason }
                | { source: 'reject'; error: unknown }

            let outcome: RaceOutcome
            try {
                outcome = await Promise.race([
                    pendingNext.then(
                        (result) => ({ source: 'next' as const, result }),
                        (error: unknown) => ({ source: 'reject' as const, error }),
                    ),
                    stopPromise.then((reason) => ({ source: 'stop' as const, reason })),
                ])
            } catch (error) {
                streamError = error
                break
            }

            if (outcome.source === 'stop') {
                armSelectedStop(outcome.reason)
                continue
            }

            if (outcome.source === 'reject') {
                pendingNext = undefined
                streamError = outcome.error
                break
            }

            pendingNext = undefined
            handleIteratorResult(outcome.result)
        }
    }

    const finalize = async (opts?: {
        forceRetainPath?: boolean
        retainReason?: string
    }): Promise<FinalizeResult> => {
        if (!finalized) {
            finalized = true
            acceptingOutput = false
            try {
                output.finish()
            } catch {
                // ignore finish errors
            }
            clearUpdateTimer()
            updateDirty = true
            emitOutputUpdate()
        }

        const snapshot = output.snapshot()
        const formatted = formatOutput(snapshot, output.getLastLineBytes(), fullOutputPath)

        let cleanupDiagnostic: string | undefined
        let retainedPath: string | undefined
        const mustRetain =
            opts?.forceRetainPath === true ||
            terminal === null ||
            snapshot.truncation.truncated

        if (fullOutputPath) {
            if (mustRetain) {
                retainedPath = fullOutputPath
                if (opts?.retainReason) {
                    cleanupDiagnostic = opts.retainReason
                } else if (terminal === null) {
                    cleanupDiagnostic =
                        `Retained full output path ${fullOutputPath}: process stream ended without a terminal event`
                }
            } else {
                try {
                    await bridge.removeFile(fullOutputPath)
                } catch (error) {
                    cleanupDiagnostic = formatCleanupDiagnostic(fullOutputPath, error)
                    retainedPath = fullOutputPath
                }
            }
        }

        return {
            snapshot,
            text: formatted.text,
            retainedPath,
            cleanupDiagnostic,
        }
    }

    const collectDiagnostics = (
        finalizedResult: FinalizeResult,
        extras: Array<string | undefined | null> = [],
    ): string[] => {
        const diagnostics: string[] = []
        for (const extra of extras) {
            pushDiagnostic(diagnostics, extra)
        }
        if (outputError !== null) {
            pushDiagnostic(diagnostics, errorText(outputError, 'malformed process output'))
        }
        if (streamError !== null) {
            pushDiagnostic(diagnostics, errorText(streamError, 'process stream error'))
        }
        const currentTerminal = getTerminal()
        if (currentTerminal?.kind === 'protocol') {
            pushDiagnostic(diagnostics, currentTerminal.error)
        }
        if (currentTerminal?.kind === 'error') {
            pushDiagnostic(diagnostics, currentTerminal.error)
        }
        if (currentTerminal?.kind === 'cancelled' && currentTerminal.error) {
            pushDiagnostic(diagnostics, currentTerminal.error)
        }
        if (currentTerminal?.kind === 'done') {
            pushDiagnostic(
                diagnostics,
                `Command exited with code ${currentTerminal.exitCode}`,
            )
        }
        if (finalizedResult.cleanupDiagnostic) {
            pushDiagnostic(diagnostics, finalizedResult.cleanupDiagnostic)
        }
        if (finalizedResult.retainedPath && terminal === null) {
            pushDiagnostic(diagnostics, finalizedResult.retainedPath)
        }
        return diagnostics
    }

    const buildErrorMessage = (
        finalizedResult: FinalizeResult,
        status: string,
        extras: Array<string | undefined | null> = [],
    ): string => {
        let message = appendStatus(finalizedResult.text, status)
        const diagnostics = collectDiagnostics(finalizedResult, extras).filter(
            (item) => item !== status,
        )
        if (diagnostics.length > 0) {
            message = appendStatus(message, diagnostics.join('\n'))
        }
        return message
    }

    const throwClassified = (finalizedResult: FinalizeResult): never => {
        const currentTerminal = getTerminal()

        if (selectedStop === 'timeout') {
            throw new Error(
                buildErrorMessage(
                    finalizedResult,
                    `Command timed out after ${timeoutSeconds} seconds`,
                ),
            )
        }
        if (selectedStop === 'abort') {
            throw new Error(buildErrorMessage(finalizedResult, 'Command aborted'))
        }

        if (outputError !== null) {
            throw new Error(
                buildErrorMessage(
                    finalizedResult,
                    errorText(outputError, 'malformed process output'),
                ),
            )
        }

        if (streamError !== null) {
            throw new Error(
                buildErrorMessage(
                    finalizedResult,
                    errorText(streamError, 'process stream error'),
                ),
            )
        }

        if (currentTerminal?.kind === 'protocol') {
            throw new Error(buildErrorMessage(finalizedResult, currentTerminal.error))
        }

        if (currentTerminal?.kind === 'error') {
            throw new Error(buildErrorMessage(finalizedResult, currentTerminal.error))
        }

        if (currentTerminal?.kind === 'done') {
            if (currentTerminal.exitCode !== 0) {
                throw new Error(
                    buildErrorMessage(
                        finalizedResult,
                        `Command exited with code ${currentTerminal.exitCode}`,
                    ),
                )
            }
            throw new Error(
                buildErrorMessage(finalizedResult, 'unexpected success classification'),
            )
        }

        if (currentTerminal?.kind === 'cancelled') {
            throw new Error(buildErrorMessage(finalizedResult, 'Command aborted'))
        }

        throw new Error(
            buildErrorMessage(
                finalizedResult,
                'Process stream closed before terminal event',
            ),
        )
    }

    try {
        const runtime = await bridge.runtimeInfo()
        const shell = await resolvePowerShell(
            runtime.platform,
            bridge,
            options.shellPath,
            options.env,
        )

        // Prepend UTF-8 output encoding prefix to ensure clean Unicode handling
        const fullCommand = `${UTF8_OUTPUT_PREFIX}${args.command}`

        const operationId = createOperationId()
        const startInput = {
            operationId,
            executable: shell.shell,
            cwd,
            signal: internal.signal,
            ...(shell.commandTransport === 'stdin'
                ? {
                      args: shell.args,
                      stdin: fullCommand,
                  }
                : {
                      args: [...shell.args, fullCommand],
                  }),
        }

        operation = await bridge.startProcess(startInput)
        fullOutputPath = operation.fullOutputPath
        iterator = operation.events[Symbol.asyncIterator]()

        await consumeUntilSettled()

        const forceRetainPath = terminal === null
        const finalizedResult = await finalize({
            forceRetainPath,
            retainReason: forceRetainPath && fullOutputPath
                ? `Retained full output path ${fullOutputPath}: process stream ended without a terminal event`
                : undefined,
        })

        const observedTerminal = getTerminal()
        const success =
            selectedStop === null &&
            observedTerminal !== null &&
            observedTerminal.kind === 'done' &&
            observedTerminal.exitCode === 0 &&
            outputError === null &&
            streamError === null

        if (success) {
            const details: PwshToolDetails = {}
            if (finalizedResult.snapshot.truncation.truncated) {
                details.truncation = finalizedResult.snapshot.truncation
            }
            if (finalizedResult.retainedPath) {
                details.fullOutputPath = finalizedResult.retainedPath
            }
            if (finalizedResult.cleanupDiagnostic) {
                details.cleanupDiagnostic = finalizedResult.cleanupDiagnostic
            }
            return {
                content: [{ type: 'text', text: finalizedResult.text }],
                details: Object.keys(details).length > 0 ? details : undefined,
            }
        }

        return throwClassified(finalizedResult)
    } catch (error) {
        if (finalized) {
            if (iterator) {
                try {
                    await iterator.return?.()
                } catch {
                    // ignore
                }
                iterator = undefined
            }
            throw error
        }

        if (operation && terminal === null) {
            requestCancel()
        }
        if (iterator && terminal === null && streamError === null && !streamEnded) {
            try {
                await consumeUntilSettled()
            } catch (drainError) {
                if (streamError === null) {
                    streamError = drainError
                }
            }
        }

        let finalizedResult: FinalizeResult | undefined
        try {
            finalizedResult = await finalize({
                forceRetainPath: terminal === null,
                retainReason:
                    terminal === null && fullOutputPath
                        ? `Retained full output path ${fullOutputPath}: process stream ended without a terminal event`
                        : undefined,
            })
        } catch {
            finalizedResult = undefined
        }

        if (iterator) {
            try {
                await iterator.return?.()
            } catch {
                // ignore
            }
            iterator = undefined
        }

        if (finalizedResult && error instanceof Error) {
            if (
                selectedStop !== null ||
                outputError !== null ||
                streamError !== null ||
                terminal !== null
            ) {
                try {
                    return throwClassified(finalizedResult)
                } catch (classified) {
                    throw classified
                }
            }
            if (
                finalizedResult.text &&
                finalizedResult.text !== '(no output)' &&
                !error.message.includes(finalizedResult.text)
            ) {
                throw new Error(
                    buildErrorMessage(finalizedResult, error.message),
                )
            }
            if (
                finalizedResult.cleanupDiagnostic &&
                !error.message.includes(finalizedResult.cleanupDiagnostic)
            ) {
                throw new Error(
                    appendStatus(error.message, finalizedResult.cleanupDiagnostic),
                )
            }
            if (
                finalizedResult.retainedPath &&
                !error.message.includes(finalizedResult.retainedPath)
            ) {
                throw new Error(
                    appendStatus(error.message, finalizedResult.retainedPath),
                )
            }
        }

        throw error
    } finally {
        cleanupListeners()
        if (iterator) {
            try {
                await iterator.return?.()
            } catch {
                // ignore
            }
        }
    }
}

function formatCleanupDiagnostic(path: string, error: unknown): string {
    const message = error instanceof Error ? error.message : String(error ?? 'unknown error')
    return `Failed to remove full output file ${path}: ${message}`
}

function formatOutput(
    snapshot: { content: string; truncation: TruncateResult },
    lastLineBytes: number,
    fullOutputPath: string | undefined,
    emptyText = '(no output)',
): { text: string; details?: PwshToolDetails } {
    const truncation = snapshot.truncation
    let text = snapshot.content || emptyText
    let details: PwshToolDetails | undefined

    if (truncation.truncated) {
        details = {
            truncation,
            fullOutputPath,
        }
        const startLine = Math.max(1, truncation.totalLines - truncation.outputLines + 1)
        const endLine = truncation.totalLines
        if (truncation.lastLinePartial) {
            const lastLineSize = formatSize(lastLineBytes)
            text += `\n\n[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine} (line is ${lastLineSize}). Full output: ${fullOutputPath}]`
        } else if (truncation.truncatedBy === 'lines') {
            text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}. Full output: ${fullOutputPath}]`
        } else {
            text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(truncation.maxBytes)} limit). Full output: ${fullOutputPath}]`
        }
    }

    return { text, details }
}

function appendStatus(text: string, status: string): string {
    return `${text ? `${text}\n\n` : ''}${status}`
}

function decodeEventData(event: NativeEvent): Uint8Array {
    if (event.data === undefined || event.data === '') {
        return new Uint8Array()
    }
    if (event.encoding === 'base64') {
        try {
            return base64ToBytes(event.data)
        } catch {
            throw new Error('malformed base64 process output')
        }
    }
    if (event.encoding === 'utf8') {
        return new TextEncoder().encode(event.data)
    }
    throw new Error(
        `unsupported process output encoding: ${event.encoding ?? '(missing)'}`,
    )
}

function base64ToBytes(dataBase64: string): Uint8Array {
    const binary = atob(dataBase64)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index)
    }
    return bytes
}

function createOperationId(): string {
    if (typeof globalThis.crypto?.randomUUID === 'function') {
        return globalThis.crypto.randomUUID()
    }
    return `pwsh-${Date.now()}-${Math.random().toString(16).slice(2)}`
}
