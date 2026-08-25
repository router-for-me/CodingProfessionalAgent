/**
 * Cross-platform bash and PowerShell shell resolution for the standalone agent runtime.
 * Never falls back to PowerShell/cmd when resolving bash, and resolves PowerShell (pwsh/powershell) on Windows.
 */

import type { NativeBridge } from './types.js'

export type ShellCommandTransport = 'arg' | 'stdin'

export interface ShellConfig {
    shell: string
    args: string[]
    commandTransport: ShellCommandTransport
}

export type ShellEnv = Readonly<Record<string, string | undefined>>

const DEFAULT_WINDOWS_PROGRAM_FILES = 'C:\\Program Files'
const DEFAULT_WINDOWS_PROGRAM_FILES_X86 = 'C:\\Program Files (x86)'

export const POWERSHELL_ARGS = [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
] as const

export const UTF8_OUTPUT_PREFIX =
    'try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}\n'

export function isWindowsPlatform(platform: string | undefined | null): boolean {
    if (!platform) {
        return false
    }
    const normalized = platform.toLowerCase()
    return normalized === 'windows' || normalized === 'win32'
}

/**
 * Detect the legacy Windows "bash.exe" that launches WSL and only accepts scripts on stdin.
 * Paths look like C:\Windows\System32\bash.exe or C:\Windows\Sysnative\bash.exe.
 */
export function isLegacyWslBashPath(path: string): boolean {
    const normalized = path.replace(/\//g, '\\').toLowerCase()
    return /^[a-z]:\\windows\\(?:system32|sysnative)\\bash\.exe$/.test(normalized)
}

function shellConfigFor(shell: string): ShellConfig {
    if (isLegacyWslBashPath(shell)) {
        return {
            shell,
            args: ['-s'],
            commandTransport: 'stdin',
        }
    }
    return {
        shell,
        args: ['-c'],
        commandTransport: 'arg',
    }
}

/**
 * Missing-path classification (aligned with mutationQueue):
 * - When error has a `code` field, only ENOENT/ENOTDIR are missing.
 * - Code-less errors use precise OS predicates (no generic "not found").
 */
function isMissingPathError(error: unknown): boolean {
    if (typeof error === 'object' && error !== null && 'code' in error) {
        const code = (error as { code?: unknown }).code
        return code === 'ENOENT' || code === 'ENOTDIR'
    }

    const message =
        typeof error === 'object' &&
        error !== null &&
        'message' in error &&
        typeof (error as { message?: unknown }).message === 'string'
            ? (error as { message: string }).message
            : String(error)

    if (/no such file or directory/i.test(message)) {
        return true
    }
    if (/\bnot a directory\b/i.test(message)) {
        return true
    }
    if (/The system cannot find the file specified/i.test(message)) {
        return true
    }
    if (/The system cannot find the path specified/i.test(message)) {
        return true
    }
    // FakeNativeBridge and similar "stat …: not found" helpers.
    if (/^stat .+: not found$/i.test(message)) {
        return true
    }
    return false
}

function errorMessage(error: unknown): string {
    if (error instanceof Error) {
        return error.message
    }
    return String(error ?? 'unknown error')
}

/**
 * Read an env value with case-insensitive key match (Windows env keys vary).
 */
function getEnvCaseInsensitive(env: ShellEnv | undefined, key: string): string | undefined {
    if (!env) {
        return undefined
    }
    if (Object.prototype.hasOwnProperty.call(env, key) && env[key]) {
        return env[key]
    }
    const target = key.toLowerCase()
    for (const [entryKey, value] of Object.entries(env)) {
        if (entryKey.toLowerCase() === target && value) {
            return value
        }
    }
    return undefined
}

function windowsGitBashCandidates(env: ShellEnv | undefined): string[] {
    const paths: string[] = []
    const seen = new Set<string>()
    const add = (candidate: string): void => {
        const key = candidate.toLowerCase()
        if (seen.has(key)) {
            return
        }
        seen.add(key)
        paths.push(candidate)
    }

    const programFiles = getEnvCaseInsensitive(env, 'ProgramFiles')
    const programFilesX86 = getEnvCaseInsensitive(env, 'ProgramFiles(x86)')

    // Injected values first (host-specific install roots).
    if (programFiles) {
        add(`${programFiles}\\Git\\bin\\bash.exe`)
    }
    if (programFilesX86) {
        add(`${programFilesX86}\\Git\\bin\\bash.exe`)
    }

    // Always merge conventional defaults so one injected root does not hide the other.
    add(`${DEFAULT_WINDOWS_PROGRAM_FILES}\\Git\\bin\\bash.exe`)
    add(`${DEFAULT_WINDOWS_PROGRAM_FILES_X86}\\Git\\bin\\bash.exe`)

    return paths
}

/**
 * Stat a candidate shell path.
 * Only exact missing errors are treated as absent; permission/other rethrow.
 */
async function statShellCandidate(
    bridge: NativeBridge,
    path: string,
): Promise<'file' | 'directory' | 'missing'> {
    try {
        const st = await bridge.stat(path)
        return st.isDir ? 'directory' : 'file'
    } catch (error) {
        if (isMissingPathError(error)) {
            return 'missing'
        }
        throw error
    }
}

/**
 * Resolve a bash-compatible shell for the given GOOS platform.
 *
 * Order:
 * 1. custom path (must exist as a file)
 * 2. Windows: known Git Bash locations → lookPath('bash.exe') → clear error
 * 3. Unix: /bin/bash → lookPath('bash') → sh
 */
export async function resolveShell(
    platform: string,
    bridge: NativeBridge,
    customPath?: string,
    env?: ShellEnv,
): Promise<ShellConfig> {
    if (customPath) {
        let kind: 'file' | 'directory' | 'missing'
        try {
            kind = await statShellCandidate(bridge, customPath)
        } catch (error) {
            throw new Error(
                `Custom shell path inaccessible: ${customPath}: ${errorMessage(error)}`,
            )
        }
        if (kind === 'missing') {
            throw new Error(`Custom shell path not found: ${customPath}`)
        }
        if (kind === 'directory') {
            throw new Error(`Custom shell path is a directory: ${customPath}`)
        }
        return shellConfigFor(customPath)
    }

    const isWindows = isWindowsPlatform(platform)

    if (isWindows) {
        const candidates = windowsGitBashCandidates(env)
        for (const candidate of candidates) {
            // Permission/other stat errors must surface; only missing is skipped.
            const kind = await statShellCandidate(bridge, candidate)
            if (kind === 'file') {
                return shellConfigFor(candidate)
            }
        }

        const bashOnPath = await bridge.lookPath('bash.exe')
        if (bashOnPath) {
            return shellConfigFor(bashOnPath)
        }

        throw new Error(
            `No bash shell found. Options:\n` +
                `  1. Install Git for Windows: https://git-scm.com/download/win\n` +
                `  2. Add your bash to PATH (Cygwin, MSYS2, etc.)\n` +
                `  3. Set shellPath in settings\n\n` +
                `Searched Git Bash in:\n${candidates.map((p) => `  ${p}`).join('\n')}`,
        )
    }

    // Unix (darwin / linux / other non-windows)
    const binBash = await statShellCandidate(bridge, '/bin/bash')
    if (binBash === 'file') {
        return shellConfigFor('/bin/bash')
    }

    const bashOnPath = await bridge.lookPath('bash')
    if (bashOnPath) {
        return shellConfigFor(bashOnPath)
    }

    return {
        shell: 'sh',
        args: ['-c'],
        commandTransport: 'arg',
    }
}

function windowsPwshCandidates(env: ShellEnv | undefined): string[] {
    const paths: string[] = []
    const seen = new Set<string>()
    const add = (candidate: string): void => {
        const key = candidate.toLowerCase()
        if (seen.has(key)) {
            return
        }
        seen.add(key)
        paths.push(candidate)
    }

    const programFiles = getEnvCaseInsensitive(env, 'ProgramFiles')
    const programFilesX86 = getEnvCaseInsensitive(env, 'ProgramFiles(x86)')
    const localAppData = getEnvCaseInsensitive(env, 'LOCALAPPDATA')

    if (programFiles) {
        add(`${programFiles}\\PowerShell\\7\\pwsh.exe`)
        add(`${programFiles}\\PowerShell\\pwsh.exe`)
    }
    if (programFilesX86) {
        add(`${programFilesX86}\\PowerShell\\7\\pwsh.exe`)
        add(`${programFilesX86}\\PowerShell\\pwsh.exe`)
    }
    if (localAppData) {
        add(`${localAppData}\\Microsoft\\PowerShell\\7\\pwsh.exe`)
    }

    add(`${DEFAULT_WINDOWS_PROGRAM_FILES}\\PowerShell\\7\\pwsh.exe`)
    add(`${DEFAULT_WINDOWS_PROGRAM_FILES_X86}\\PowerShell\\7\\pwsh.exe`)
    add(`${DEFAULT_WINDOWS_PROGRAM_FILES}\\PowerShell\\pwsh.exe`)

    return paths
}

function windowsPowerShellCandidates(env: ShellEnv | undefined): string[] {
    const paths: string[] = []
    const seen = new Set<string>()
    const add = (candidate: string): void => {
        const key = candidate.toLowerCase()
        if (seen.has(key)) {
            return
        }
        seen.add(key)
        paths.push(candidate)
    }

    const systemRoot =
        getEnvCaseInsensitive(env, 'SystemRoot') ??
        getEnvCaseInsensitive(env, 'WINDIR')
    if (systemRoot) {
        add(`${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`)
        add(`${systemRoot}\\SysWOW64\\WindowsPowerShell\\v1.0\\powershell.exe`)
    }

    add('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    add('C:\\Windows\\SysWOW64\\WindowsPowerShell\\v1.0\\powershell.exe')

    return paths
}

/**
 * Resolve a PowerShell executable (pwsh / powershell.exe).
 * Prefers PowerShell 7 (pwsh.exe) over legacy Windows PowerShell.
 */
export async function resolvePowerShell(
    platform: string,
    bridge: NativeBridge,
    customPath?: string,
    env?: ShellEnv,
): Promise<ShellConfig> {
    if (customPath) {
        let kind: 'file' | 'directory' | 'missing'
        try {
            kind = await statShellCandidate(bridge, customPath)
        } catch (error) {
            throw new Error(
                `Custom shell path inaccessible: ${customPath}: ${errorMessage(error)}`,
            )
        }
        if (kind === 'missing') {
            throw new Error(`Custom shell path not found: ${customPath}`)
        }
        if (kind === 'directory') {
            throw new Error(`Custom shell path is a directory: ${customPath}`)
        }
        return {
            shell: customPath,
            args: [...POWERSHELL_ARGS],
            commandTransport: 'arg',
        }
    }

    const isWindows = isWindowsPlatform(platform)

    if (isWindows) {
        // 1. pwsh.exe on PATH
        const pwshOnPath = await bridge.lookPath('pwsh.exe')
        if (pwshOnPath) {
            return {
                shell: pwshOnPath,
                args: [...POWERSHELL_ARGS],
                commandTransport: 'arg',
            }
        }

        // 2. pwsh in known installation locations
        const pwshCandidates = windowsPwshCandidates(env)
        for (const candidate of pwshCandidates) {
            const kind = await statShellCandidate(bridge, candidate)
            if (kind === 'file') {
                return {
                    shell: candidate,
                    args: [...POWERSHELL_ARGS],
                    commandTransport: 'arg',
                }
            }
        }

        // 3. powershell.exe on PATH
        const powershellOnPath = await bridge.lookPath('powershell.exe')
        if (powershellOnPath) {
            return {
                shell: powershellOnPath,
                args: [...POWERSHELL_ARGS],
                commandTransport: 'arg',
            }
        }

        // 4. powershell in known system locations
        const powershellCandidates = windowsPowerShellCandidates(env)
        for (const candidate of powershellCandidates) {
            const kind = await statShellCandidate(bridge, candidate)
            if (kind === 'file') {
                return {
                    shell: candidate,
                    args: [...POWERSHELL_ARGS],
                    commandTransport: 'arg',
                }
            }
        }

        throw new Error(
            'No PowerShell executable found. Install PowerShell 7 (https://github.com/PowerShell/PowerShell) or add powershell.exe/pwsh.exe to PATH.',
        )
    }

    // Non-Windows (pwsh on Linux / macOS if available)
    const pwshOnPath = await bridge.lookPath('pwsh')
    if (pwshOnPath) {
        return {
            shell: pwshOnPath,
            args: [...POWERSHELL_ARGS],
            commandTransport: 'arg',
        }
    }

    const powershellOnPath = await bridge.lookPath('powershell')
    if (powershellOnPath) {
        return {
            shell: powershellOnPath,
            args: [...POWERSHELL_ARGS],
            commandTransport: 'arg',
        }
    }

    throw new Error('PowerShell is only supported when pwsh is available on PATH.')
}
