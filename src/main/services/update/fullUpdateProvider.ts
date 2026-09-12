import * as electron from 'electron'
import * as child_process from 'node:child_process'
import * as path from 'node:path'
import * as fs from 'node:fs'
import type { InstallerAsset, ReleaseManifest } from '../../../shared/updateTypes.js'

export interface SpawnedProcess {
    on(event: 'error', listener: (err: Error) => void): unknown
    on(event: 'spawn', listener: () => void): unknown
    on(event: string, listener: (...args: any[]) => void): unknown
    unref(): void
}

export interface FullUpdateProviderOptions {
    platform?: NodeJS.Platform
    arch?: string
    spawn?: (command: string, args: readonly string[], options: child_process.SpawnOptions) => SpawnedProcess
    chmodSync?: (path: fs.PathLike, mode: fs.Mode) => void
    openPath?: (path: string) => Promise<string>
}

/**
 * Handles resolution and system launching of full native installer packages
 * across macOS (DMG), Windows (EXE/NSIS), and Linux (AppImage/Folder).
 */
export class FullUpdateProvider {
    private platformOverride?: NodeJS.Platform
    private archOverride?: string
    private spawnFn: (command: string, args: readonly string[], options: child_process.SpawnOptions) => SpawnedProcess
    private chmodSyncFn: (path: fs.PathLike, mode: fs.Mode) => void
    private openPathFn?: (path: string) => Promise<string>

    constructor(options?: FullUpdateProviderOptions) {
        this.platformOverride = options?.platform
        this.archOverride = options?.arch
        this.spawnFn = options?.spawn ?? ((cmd, args, opts) => child_process.spawn(cmd, args, opts))
        this.chmodSyncFn = options?.chmodSync ?? fs.chmodSync
        this.openPathFn = options?.openPath
    }

    private async openPath(targetPath: string): Promise<string> {
        if (this.openPathFn) {
            return this.openPathFn(targetPath)
        }
        const shell = (electron as any)?.shell
        if (!shell || typeof shell.openPath !== 'function') {
            throw new Error('electron.shell.openPath is not available')
        }
        return await shell.openPath(targetPath)
    }

    private get currentPlatform(): NodeJS.Platform {
        return this.platformOverride ?? process.platform
    }

    private get currentArch(): string {
        return this.archOverride ?? process.arch
    }

    /**
     * Resolves the standardized platform-arch key matching ReleaseManifest installers.
     */
    public resolvePlatformKey(): string {
        const platform = this.currentPlatform
        const arch = this.currentArch
        if (platform === 'darwin') {
            return arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64'
        }
        if (platform === 'win32') {
            return arch === 'arm64' ? 'win32-arm64' : 'win32-x64'
        }
        return arch === 'arm64' ? 'linux-arm64' : 'linux-x64'
    }

    /**
     * Resolves the matching installer asset for current platform from a release manifest.
     */
    public resolveInstaller(manifest: ReleaseManifest): InstallerAsset | undefined {
        if (!manifest.installers) {
            return undefined
        }
        const platformKey = this.resolvePlatformKey()
        return manifest.installers[platformKey]
    }

    /**
     * Launches or opens the downloaded full installer in the host OS environment.
     */
    public async launchInstaller(filePath: string): Promise<void> {
        const platform = this.currentPlatform
        if (platform === 'darwin') {
            const err = await this.openPath(filePath)
            if (err) {
                throw new Error(`Failed to open path: ${err}`)
            }
        } else if (platform === 'win32') {
            await new Promise<void>((resolve, reject) => {
                const child = this.spawnFn(filePath, [], { detached: true, stdio: 'ignore' })
                child.on('error', (err: Error) => {
                    reject(err)
                })
                child.on('spawn', () => {
                    try {
                        child.unref()
                        resolve()
                    } catch (unrefErr) {
                        reject(unrefErr)
                    }
                })
            })
        } else {
            try {
                this.chmodSyncFn(filePath, 0o755)
            } catch {}
            const err = await this.openPath(path.dirname(filePath))
            if (err) {
                throw new Error(`Failed to open path: ${err}`)
            }
        }
    }
}
