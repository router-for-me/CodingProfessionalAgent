import { app } from 'electron'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import * as os from 'node:os'
import {
  DEFAULT_APP_CONFIG_DIR_NAME,
  DEV_APP_CONFIG_DIR_NAME,
} from '../../shared/types.js'

let cachedAppVersion: string | null = null

export function isDevEnvironment(): boolean {
  if (process.env.CPA_DEV === '1' || process.env.CPA_DEV === 'true') {
    return true
  }
  if (process.env.CPA_DEV === '0' || process.env.CPA_DEV === 'false') {
    return false
  }
  if (typeof app === 'object' && app !== null && typeof app.isPackaged === 'boolean') {
    return !app.isPackaged
  }
  return process.env.NODE_ENV === 'development'
}

export function getAppConfigDirName(isDev?: boolean): string {
  if (process.env.CPA_CONFIG_DIR_NAME) {
    return process.env.CPA_CONFIG_DIR_NAME
  }
  const dev = isDev ?? isDevEnvironment()
  return dev ? DEV_APP_CONFIG_DIR_NAME : DEFAULT_APP_CONFIG_DIR_NAME
}

export function getAppConfigDir(homeDir: string = os.homedir(), isDev?: boolean): string {
  return path.join(homeDir, getAppConfigDirName(isDev))
}

export function getAppVersion(): string {
  if (cachedAppVersion) {
    return cachedAppVersion
  }

  // 1. In development environment, always return 'dev'
  if (isDevEnvironment()) {
    cachedAppVersion = 'dev'
    return cachedAppVersion
  }

  // 2. In packaged electron environment, try electron app.getVersion()
  try {
    if (typeof app === 'object' && app !== null && typeof app.getVersion === 'function') {
      const version = app.getVersion()
      if (typeof version === 'string' && version.trim().length > 0 && version !== '0.0.0') {
        cachedAppVersion = version.trim()
        return cachedAppVersion
      }
    }
  } catch {
    // Ignore error if app is not initialized or unavailable
  }

  // 3. Fallback: try reading package.json
  try {
    const candidatePaths: string[] = []

    try {
      const currentDir = path.dirname(fileURLToPath(import.meta.url))
      candidatePaths.push(
        path.resolve(currentDir, '../../package.json'),
        path.resolve(currentDir, '../../../package.json'),
      )
    } catch {
      // Ignore ESM resolve errors
    }

    candidatePaths.push(path.resolve(process.cwd(), 'package.json'))

    for (const pkgPath of candidatePaths) {
      if (fs.existsSync(pkgPath)) {
        const pkgContent = fs.readFileSync(pkgPath, 'utf8')
        const pkgJson = JSON.parse(pkgContent) as { version?: unknown }
        if (typeof pkgJson.version === 'string' && pkgJson.version.trim().length > 0) {
          const trimmed = pkgJson.version.trim()
          cachedAppVersion = trimmed
          return trimmed
        }
      }
    }
  } catch {
    // Ignore file read/parse errors
  }

  // 4. Fallback default version
  cachedAppVersion = '1.0.0'
  return cachedAppVersion
}

export function getUserAgent(): string {
  const version = getAppVersion()
  return `CodingProfessionalAgent/${version}`
}

/**
 * Resets cached app version (primarily for testing purposes).
 */
export function resetCachedAppVersion(): void {
  cachedAppVersion = null
}
