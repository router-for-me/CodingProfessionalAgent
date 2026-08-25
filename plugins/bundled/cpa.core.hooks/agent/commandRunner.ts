/**
 * Command runner for executing hook command handlers.
 * Spawns shell processes, pipes JSON stdin, enforces timeouts, and collects output.
 */

import type { NativeBridge } from './types.js'
import { isTerminalEventKind } from './testUtils.js'
import type { CommandHookHandlerConfig } from './types.js'

export interface CommandRunResult {
    stdout: string
    stderr: string
    exitCode: number
    durationMs: number
}

function decodeData(data?: string, encoding?: string): string {
    if (!data) return ''
    if (encoding === 'base64') {
        try {
            const binary = atob(data)
            const bytes = new Uint8Array(binary.length)
            for (let i = 0; i < binary.length; i++) {
                bytes[i] = binary.charCodeAt(i)
            }
            return new TextDecoder().decode(bytes)
        } catch {
            return data
        }
    }
    return data
}

export async function runHookCommand(
    bridge: NativeBridge,
    handler: CommandHookHandlerConfig,
    inputJson: string,
    cwd: string,
    extraEnv?: Record<string, string>,
    signal?: AbortSignal,
): Promise<CommandRunResult> {
    const runtimeInfo = await bridge.runtimeInfo().catch(() => ({
        platform: 'darwin',
        userConfigDir: '',
        tempDir: '',
        homeDir: '',
    }))

    const isWindows = runtimeInfo.platform === 'win32'
    const command = handler.command

    const operationId = `hook_cmd_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const timeoutMs = (handler.timeout ?? 30) * 1000

    let executable: string
    let args: string[]

    if (isWindows) {
        executable = 'cmd.exe'
        args = ['/d', '/s', '/c', command]
    } else {
        executable = '/bin/sh'
        args = ['-c', command]
    }

    const env: Record<string, string> = {
        ...(extraEnv ?? {}),
        CODEX_HOOK_PAYLOAD: inputJson,
        CODEX_HOOK: '1',
    }

    const abortController = new AbortController()
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null

    if (timeoutMs > 0) {
        timeoutTimer = setTimeout(() => {
            abortController.abort(new Error(`Hook command timed out after ${handler.timeout ?? 30}s`))
        }, timeoutMs)
    }

    const onSignalAbort = () => {
        abortController.abort(signal?.reason ?? new Error('Aborted'))
    }

    if (signal) {
        signal.addEventListener('abort', onSignalAbort, { once: true })
    }

    const startTime = Date.now()
    let stdout = ''
    let stderr = ''
    let exitCode = 0

    try {
        const operation = await bridge.startProcess({
            operationId,
            executable,
            args,
            cwd,
            env,
            stdin: inputJson,
            signal: abortController.signal,
        })

        for await (const event of operation.events) {
            if (event.kind === 'process-stdout') {
                stdout += decodeData(event.data, event.encoding)
            } else if (event.kind === 'process-stderr') {
                stderr += decodeData(event.data, event.encoding)
            } else if (event.kind === 'done' || event.kind === 'error' || event.kind === 'cancelled') {
                exitCode = event.exitCode ?? (event.kind === 'done' ? 0 : 1)
                if (event.error) {
                    stderr += `\n${event.error}`
                }
                break
            } else if (isTerminalEventKind(event.kind)) {
                exitCode = event.exitCode ?? 0
                break
            }
        }
    } catch (err) {
        const isAbort = abortController.signal.aborted || signal?.aborted
        const errMessage = err instanceof Error ? err.message : String(err)
        stderr += `\n${errMessage}`
        exitCode = isAbort ? 130 : 1
    } finally {
        if (timeoutTimer) {
            clearTimeout(timeoutTimer)
        }
        if (signal) {
            signal.removeEventListener('abort', onSignalAbort)
        }
    }

    const durationMs = Date.now() - startTime

    return {
        stdout,
        stderr,
        exitCode,
        durationMs,
    }
}
