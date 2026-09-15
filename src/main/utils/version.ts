import * as electron from 'electron'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import * as os from 'node:os'
import {
  DEFAULT_APP_CONFIG_DIR_NAME,
  DEV_APP_CONFIG_DIR_NAME,
} from '../../shared/types.js'
import { UpdateStateStorage } from '../services/update/updateStateStorage.js'

let cachedAppVersion: string | null = null

function getElectronApp(): any {
  try {
    return (electron as any).default?.app ?? (electron as any).app
  } catch {
    return undefined
  }
}

function trySetElectronAppVersion(version: string): void {
  try {
    const app = getElectronApp()
    if (typeof app === 'object' && app !== null && typeof app.setVersion === 'function' && version !== 'dev') {
      app.setVersion(version)
    }
  } catch {}
}

export function isDevEnvironment(): boolean {
  if (process.env.CPA_DEV === '1' || process.env.CPA_DEV === 'true') {
    return true
  }
  if (process.env.CPA_DEV === '0' || process.env.CPA_DEV === 'false') {
    return false
  }
  const app = getElectronApp()
  if (typeof app === 'object' && app !== null && typeof app.isPackaged === 'boolean') {
    return !app.isPackaged
  }
  return process.env.NODE_ENV === 'development'
}

export function getAppConfigDirName(isDev?: boolean): string {
  if (typeof isDev === 'boolean') {
    return isDev ? DEV_APP_CONFIG_DIR_NAME : DEFAULT_APP_CONFIG_DIR_NAME
  }
  if (process.env.CPA_CONFIG_DIR_NAME) {
    return process.env.CPA_CONFIG_DIR_NAME
  }
  const dev = isDevEnvironment()
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

  // 2. Try reading package.json by walking up from current module directory.
  // When running from an active patched ASAR, this correctly resolves to the updated package.json.
  try {
    let currDir: string | null = null
    try {
      currDir = path.dirname(fileURLToPath(import.meta.url))
    } catch {}

    if (currDir) {
      let current = currDir
      for (let i = 0; i < 6; i++) {
        const pkgPath = path.join(current, 'package.json')
        if (fs.existsSync(pkgPath)) {
          const pkgContent = fs.readFileSync(pkgPath, 'utf8')
          const pkgJson = JSON.parse(pkgContent) as { name?: unknown; version?: unknown }
          if (
            typeof pkgJson.version === 'string' &&
            pkgJson.version.trim().length > 0 &&
            (pkgJson.name === 'coding-professional-agent-root' || !pkgJson.name || i >= 2)
          ) {
            const trimmed = pkgJson.version.trim()
            cachedAppVersion = trimmed
            trySetElectronAppVersion(trimmed)
            return trimmed
          }
        }
        const parent = path.dirname(current)
        if (parent === current) break
        current = parent
      }
    }
  } catch {
    // Ignore file read/parse errors
  }

  // 3. Try reading activeVersion from UpdateStateStorage
  try {
    const storage = new UpdateStateStorage()
    const state = storage.loadState()
    if (state.activeVersion && typeof state.activeVersion === 'string' && state.activeVersion.trim().length > 0) {
      const trimmed = state.activeVersion.trim()
      cachedAppVersion = trimmed
      trySetElectronAppVersion(trimmed)
      return trimmed
    }
  } catch {
    // Ignore storage errors
  }

  // 4. Try reading package.json in process.cwd()
  try {
    const cwdPkgPath = path.resolve(process.cwd(), 'package.json')
    if (fs.existsSync(cwdPkgPath)) {
      const pkgContent = fs.readFileSync(cwdPkgPath, 'utf8')
      const pkgJson = JSON.parse(pkgContent) as { version?: unknown }
      if (typeof pkgJson.version === 'string' && pkgJson.version.trim().length > 0) {
        const trimmed = pkgJson.version.trim()
        cachedAppVersion = trimmed
        trySetElectronAppVersion(trimmed)
        return trimmed
      }
    }
  } catch {
    // Ignore file read/parse errors
  }

  // 5. In packaged electron environment, try electron app.getVersion()
  try {
    const app = getElectronApp()
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

  // 6. Fallback default version
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
