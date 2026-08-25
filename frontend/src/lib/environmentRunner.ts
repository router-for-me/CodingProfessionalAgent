/**
 * Environment setup and execution runner.
 * Resolves project environment scripts and executes them with standard CPA/CPA environment variables.
 */

import {
    type ReadFileBridge,
    readProjectEnvironment,
    type ProjectEnvironmentConfig,
} from '@/lib/environmentToml'
import { getProjectPaths } from '@/lib/projectPaths'
import {
    base64ToBytes,
    ElectronNativeBridge,
} from '@/features/agent-runtime/native/electronNativeBridge'
import type { NativeEvent } from '@/features/agent-runtime/native/types'
import { createId } from '@/lib/id'
import type { Project, ProjectEnvironmentScripts } from '@/types/models'
import { getHostBridge } from '@/application/services/hostTransport'
import i18n from '@/i18n'

export type ProcessRunner = (options: {
    executable: string
    args: string[]
    cwd: string
    env: Record<string, string>
    onStdout?: (data: string) => void
    onStderr?: (data: string) => void
    signal?: AbortSignal
}) => Promise<{ exitCode: number; output: string }>

export interface RunEnvironmentSetupOptions {
    sourceTreePath: string
    worktreePath: string
    project?: Project | null
    environmentConfig?: ProjectEnvironmentConfig | null
    readFileBridge?: ReadFileBridge
    processRunner?: ProcessRunner
    onLog?: (chunk: string) => void
    onProgress?: (message: string) => void
    signal?: AbortSignal
}

export interface RunEnvironmentSetupResult {
    ok: boolean
    scriptRan: boolean
    script?: string
    exitCode?: number
    output: string
    error?: string
}

/** Detect current OS platform for script resolution. */
export function getCurrentPlatform(): 'macos' | 'linux' | 'windows' {
    if (typeof navigator !== 'undefined') {
        const ua = navigator.userAgent.toLowerCase()
        if (ua.includes('mac')) return 'macos'
        if (ua.includes('win')) return 'windows'
        if (ua.includes('linux')) return 'linux'
    }
    if (typeof process !== 'undefined' && process.platform) {
        if (process.platform === 'darwin') return 'macos'
        if (process.platform === 'win32') return 'windows'
        return 'linux'
    }
    return 'macos'
}

/** Resolve the effective setup script for the current platform. */
export function resolveSetupScript(
    scripts?: ProjectEnvironmentScripts | null,
    fallbackScript?: string,
    platform: 'macos' | 'linux' | 'windows' = getCurrentPlatform(),
): string | null {
    if (scripts) {
        const platScript = scripts[platform]?.trim()
        if (platScript) return platScript
        const defScript = scripts.default?.trim()
        if (defScript) return defScript
    }
    if (fallbackScript && fallbackScript.trim()) {
        return fallbackScript.trim()
    }
    return null
}

function decodeEventText(event: NativeEvent): string {
    if (event.data === undefined || event.data === '') return ''
    if (event.encoding === 'base64') {
        return new TextDecoder('utf-8').decode(base64ToBytes(event.data))
    }
    if (event.encoding === 'utf8') return event.data
    return event.data
}

/** Default process runner using ElectronNativeBridge. */
export async function runProcessViaNativeBridge(options: {
    executable: string
    args: string[]
    cwd: string
    env: Record<string, string>
    onStdout?: (data: string) => void
    onStderr?: (data: string) => void
    signal?: AbortSignal
}): Promise<{ exitCode: number; output: string }> {
    const bridge = new ElectronNativeBridge()
    let combinedOutput = ''

    try {
        const operation = await bridge.startProcess({
            operationId: createId(),
            executable: options.executable,
            args: options.args,
            cwd: options.cwd,
            env: options.env,
        })

        let exitCode = 0
        let terminalKind = 'done'

        try {
            for await (const event of operation.events) {
                if (options.signal?.aborted) {
                    try {
                        const bridge = getHostBridge()
                        if (bridge?.CancelOperation) {
                            void bridge.CancelOperation(operation.operationId)
                        }
                    } catch {
                        // Ignore
                    }
                    throw new Error(
                        i18n.t('worktree.setupAborted', 'Environment setup aborted by user'),
                    )
                }

                if (event.kind === 'process-stdout') {
                    const text = decodeEventText(event)
                    combinedOutput += text
                    options.onStdout?.(text)
                } else if (event.kind === 'process-stderr') {
                    const text = decodeEventText(event)
                    combinedOutput += text
                    options.onStderr?.(text)
                } else if (event.kind === 'done') {
                    terminalKind = 'done'
                    exitCode = typeof event.exitCode === 'number' ? event.exitCode : 0
                    break
                } else if (event.kind === 'error' || event.kind === 'cancelled') {
                    terminalKind = event.kind
                    const extra = event.error || event.reason || event.kind
                    combinedOutput += `\n${extra}`
                    exitCode = typeof event.exitCode === 'number' ? event.exitCode : 1
                    break
                }
            }
        } finally {
            try {
                await bridge.removeFile(operation.fullOutputPath)
            } catch {
                // Best effort
            }
        }

        if (terminalKind !== 'done' && exitCode === 0) {
            exitCode = 1
        }

        return { exitCode, output: combinedOutput }
    } finally {
        await bridge.dispose()
    }
}

/**
 * Execute environment setup script for the created worktree.
 */
export async function runEnvironmentSetup(
    options: RunEnvironmentSetupOptions,
): Promise<RunEnvironmentSetupResult> {
    const {
        sourceTreePath,
        worktreePath,
        project,
        environmentConfig: customConfig,
        readFileBridge,
        processRunner = runProcessViaNativeBridge,
        onLog,
        onProgress,
        signal,
    } = options

    onProgress?.(
        i18n.t('worktree.checkingEnvironmentConfig', 'Checking environment configuration'),
    )

    // 1. Resolve environment config from file or project (only when config or project is provided)
    let config = customConfig
    if (!config && project) {
        const projectPaths = getProjectPaths(project)
        const primaryPath = projectPaths[0] || sourceTreePath
        if (primaryPath) {
            try {
                const detected = await readProjectEnvironment(primaryPath, readFileBridge)
                if (detected) {
                    config = detected.config
                }
            } catch {
                // Ignore config read error
            }
        }
    }

    const platform = getCurrentPlatform()
    const script = resolveSetupScript(
        config?.setupScripts ?? project?.setupScripts,
        project?.setupScript,
        platform,
    )

    if (!script) {
        return {
            ok: true,
            scriptRan: false,
            output: i18n.t(
                'worktree.noEnvironmentScript',
                'No environment setup script configured, skipping environment preparation.',
            ),
        }
    }

    onProgress?.(i18n.t('worktree.settingEnvironment', 'Setting up environment'))

    // 2. Prepare environment variables
    const env: Record<string, string> = {
        CODEX_WORKTREE_PATH: worktreePath,
        CODEX_SOURCE_TREE_PATH: sourceTreePath,
        CPA_WORKTREE_PATH: worktreePath,
        CPA_SOURCE_TREE_PATH: sourceTreePath,
    }

    // Include path & home from process if available
    if (typeof process !== 'undefined' && process.env) {
        if (process.env.PATH) env.PATH = process.env.PATH
        if (process.env.HOME) env.HOME = process.env.HOME
        if (process.env.USER) env.USER = process.env.USER
        if (process.env.SHELL) env.SHELL = process.env.SHELL
    }

    // 3. Choose shell executable and args
    const isWindows = platform === 'windows'
    const executable = isWindows ? 'powershell.exe' : '/bin/bash'
    const args = isWindows
        ? ['-NoProfile', '-NonInteractive', '-Command', script]
        : ['-c', script]

    // Formatted initial command log matching CPA
    const headerLog = `+ . ${script.split('\n')[0] || 'setup'}\n`
    onLog?.(headerLog)

    try {
        const result = await processRunner({
            executable,
            args,
            cwd: sourceTreePath || worktreePath,
            env,
            onStdout: (chunk) => onLog?.(chunk),
            onStderr: (chunk) => onLog?.(chunk),
            signal,
        })

        const combinedOutput = headerLog + result.output
        const ok = result.exitCode === 0

        if (ok) {
            onLog?.(
                `\n${i18n.t('worktree.environmentSetupCompleted', 'Environment setup completed successfully.')}\n`,
            )
        } else {
            onLog?.(
                `\n${i18n.t('worktree.setupScriptExitedWithCode', {
                    exitCode: result.exitCode,
                    defaultValue: `Setup script exited with code ${result.exitCode}`,
                })}\n`,
            )
        }

        const errorMessage = ok
            ? undefined
            : i18n.t('worktree.setupScriptExitedWithCode', {
                  exitCode: result.exitCode,
                  defaultValue: `Setup script exited with code ${result.exitCode}`,
              })

        return {
            ok,
            scriptRan: true,
            script,
            exitCode: result.exitCode,
            output: combinedOutput,
            error: errorMessage,
        }
    } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error)
        const output = `${headerLog}\nError: ${errorMsg}\n`
        onLog?.(`\nError: ${errorMsg}\n`)
        return {
            ok: false,
            scriptRan: true,
            script,
            exitCode: 1,
            output,
            error: errorMsg,
        }
    }
}
