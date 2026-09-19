import * as child_process from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

export interface ShellEnvironmentOptions {
  force?: boolean
  timeoutMs?: number
  customHome?: string
  platform?: string
  shell?: string
}

let isEnvironmentSynced = false

/**
 * Returns candidate development paths commonly used on the target platform.
 */
export function getCommonDevPaths(
  platform: string = process.platform,
  homeDir: string = os.homedir(),
): string[] {
  const candidates: string[] = []
  const pathModule = platform === 'win32' ? path.win32 : path.posix

  if (platform === 'darwin') {
    candidates.push(
      '/opt/homebrew/bin',
      '/opt/homebrew/sbin',
      '/usr/local/bin',
      '/usr/local/sbin',
      '/usr/local/go/bin',
      pathModule.join(homeDir, 'go', 'bin'),
      pathModule.join(homeDir, '.cargo', 'bin'),
      pathModule.join(homeDir, '.local', 'bin'),
      pathModule.join(homeDir, '.bun', 'bin'),
      pathModule.join(homeDir, '.deno', 'bin'),
    )
  } else if (platform === 'linux') {
    candidates.push(
      '/home/linuxbrew/.linuxbrew/bin',
      '/home/linuxbrew/.linuxbrew/sbin',
      '/usr/local/bin',
      '/usr/local/sbin',
      '/usr/local/go/bin',
      pathModule.join(homeDir, 'go', 'bin'),
      pathModule.join(homeDir, '.cargo', 'bin'),
      pathModule.join(homeDir, '.local', 'bin'),
      pathModule.join(homeDir, '.bun', 'bin'),
      pathModule.join(homeDir, '.deno', 'bin'),
    )
  } else if (platform === 'win32') {
    const userProfile = homeDir || process.env.USERPROFILE || ''
    if (userProfile) {
      candidates.push(
        pathModule.join(userProfile, 'go', 'bin'),
        pathModule.join(userProfile, '.cargo', 'bin'),
        pathModule.join(userProfile, '.local', 'bin'),
      )
    }
    const programFiles = process.env.ProgramFiles || 'C:\\Program Files'
    candidates.push(pathModule.join(programFiles, 'Go', 'bin'))
  }

  return candidates
}

/**
 * Enriches a PATH string by appending common development directories if they exist on disk.
 * Preserves the original PATH ordering and removes duplicate entries.
 */
export function enrichPath(
  currentPath: string = process.env.PATH || '',
  platform: string = process.platform,
  homeDir: string = os.homedir(),
  existsSync: (p: string) => boolean = fs.existsSync,
): string {
  const delimiter = platform === 'win32' ? ';' : ':'
  const existingEntries = currentPath
    ? currentPath.split(delimiter).filter(Boolean)
    : []

  const seen = new Set<string>()
  const result: string[] = []

  // Add existing entries first to preserve user preference and order
  for (const entry of existingEntries) {
    const normalized = platform === 'win32' ? entry.toLowerCase() : entry
    if (!seen.has(normalized)) {
      seen.add(normalized)
      result.push(entry)
    }
  }

  // Probe and add existing common development paths
  const devCandidates = getCommonDevPaths(platform, homeDir)
  for (const candidate of devCandidates) {
    const normalized = platform === 'win32' ? candidate.toLowerCase() : candidate
    if (!seen.has(normalized)) {
      try {
        if (existsSync(candidate)) {
          seen.add(normalized)
          result.push(candidate)
        }
      } catch {
        // Ignore filesystem check errors
      }
    }
  }

  return result.join(delimiter)
}

/**
 * Probes the user's interactive/login shell on Unix to extract real environment variables.
 */
export function probeLoginShellEnv(options?: {
  shell?: string
  timeoutMs?: number
  platform?: string
}): Record<string, string> | null {
  const platform = options?.platform ?? process.platform
  if (platform === 'win32') {
    return null
  }

  const timeoutMs = options?.timeoutMs ?? 1500
  let shell = options?.shell ?? process.env.SHELL

  if (!shell || !fs.existsSync(shell)) {
    const fallbackCandidates = ['/bin/zsh', '/bin/bash', '/bin/sh']
    for (const candidate of fallbackCandidates) {
      if (fs.existsSync(candidate)) {
        shell = candidate
        break
      }
    }
  }

  if (!shell) {
    return null
  }

  const markerStart = '__CPA_ENV_START__'
  const markerEnd = '__CPA_ENV_END__'

  // First try env -0 which is robust against multiline variables
  const probeCommands = [
    `printf "${markerStart}\\0"; env -0; printf "${markerEnd}\\0"`,
    `printf "${markerStart}\\n"; env; printf "\\n${markerEnd}\\n"`,
  ]

  for (const command of probeCommands) {
    try {
      const result = child_process.spawnSync(shell, ['-l', '-c', command], {
        encoding: 'buffer',
        timeout: timeoutMs,
        stdio: ['ignore', 'pipe', 'ignore'],
        maxBuffer: 4 * 1024 * 1024,
      })

      if (result.error || result.status !== 0 || !result.stdout) {
        continue
      }

      const output = result.stdout
      const isNullDelimited = command.includes('-0')
      const envMap: Record<string, string> = {}

      if (isNullDelimited) {
        const nullSep = Buffer.from([0])
        const startBuf = Buffer.from(markerStart)
        const endBuf = Buffer.from(markerEnd)

        const startIdx = output.indexOf(startBuf)
        const endIdx = output.indexOf(endBuf)

        if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
          continue
        }

        const payload = output.subarray(startIdx + startBuf.length, endIdx)
        let offset = 0
        while (offset < payload.length) {
          let nextZero = payload.indexOf(nullSep, offset)
          if (nextZero === -1) {
            nextZero = payload.length
          }
          const chunk = payload.subarray(offset, nextZero).toString('utf8').trim()
          offset = nextZero + 1

          const eqIndex = chunk.indexOf('=')
          if (eqIndex > 0) {
            const key = chunk.substring(0, eqIndex)
            const val = chunk.substring(eqIndex + 1)
            envMap[key] = val
          }
        }
      } else {
        const text = output.toString('utf8')
        const startIdx = text.indexOf(markerStart)
        const endIdx = text.indexOf(markerEnd)

        if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
          continue
        }

        const payload = text.substring(startIdx + markerStart.length, endIdx)
        const lines = payload.split('\n')
        for (const line of lines) {
          const trimmed = line.trim()
          const eqIndex = trimmed.indexOf('=')
          if (eqIndex > 0) {
            const key = trimmed.substring(0, eqIndex)
            const val = trimmed.substring(eqIndex + 1)
            envMap[key] = val
          }
        }
      }

      if (envMap.PATH && envMap.PATH.length > 0) {
        return envMap
      }
    } catch {
      // Continue to next probe command
    }
  }

  return null
}

const PROTECTED_VARS = new Set([
  'ELECTRON_RUN_AS_NODE',
  'ELECTRON_NO_ASAR',
  'NODE_ENV',
  'CPA_DEV',
  'CPA_CONFIG_DIR_NAME',
  'CPA_HOT_PATCH_ACTIVE',
])

/**
 * Synchronizes the current process environment with the user's login shell environment.
 * Enriches PATH with existing developer tool directories.
 */
export function syncUserShellEnvironment(options?: ShellEnvironmentOptions): void {
  if (isEnvironmentSynced && !options?.force) {
    return
  }
  isEnvironmentSynced = true

  const platform = options?.platform ?? process.platform
  const homeDir = options?.customHome ?? os.homedir()
  const delimiter = platform === 'win32' ? ';' : ':'

  // 1. If on Unix, probe login shell environment
  let shellEnv: Record<string, string> | null = null
  if (platform !== 'win32') {
    shellEnv = probeLoginShellEnv(options)
  }

  // 2. Merge non-protected environment variables if probed
  if (shellEnv) {
    for (const [key, value] of Object.entries(shellEnv)) {
      if (!PROTECTED_VARS.has(key) && value !== undefined) {
        // Do not overwrite existing variables unless it is PATH or user shell variables
        if (!process.env[key] || key === 'PATH' || key === 'GOPATH' || key === 'GOROOT') {
          if (key === 'PATH') {
            // Merge shell PATH with current PATH
            const currentParts = (process.env.PATH || '').split(delimiter).filter(Boolean)
            const shellParts = value.split(delimiter).filter(Boolean)
            const mergedParts: string[] = []
            const seen = new Set<string>()

            for (const part of shellParts) {
              if (!seen.has(part)) {
                seen.add(part)
                mergedParts.push(part)
              }
            }
            for (const part of currentParts) {
              if (!seen.has(part)) {
                seen.add(part)
                mergedParts.push(part)
              }
            }
            process.env.PATH = mergedParts.join(delimiter)
          } else {
            process.env[key] = value
          }
        }
      }
    }
  }

  // 3. Guarantee that common development paths are included
  process.env.PATH = enrichPath(process.env.PATH, platform, homeDir)
}

/**
 * Resets the environment synchronization flag (primarily for unit tests).
 */
export function resetEnvironmentSyncState(): void {
  isEnvironmentSynced = false
}
