import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import semver from 'semver'
import type { UpdateState } from '../../../shared/updateTypes.js'

export interface UpdateStateStorageOptions {
    runtimeDir?: string
    baseVersion?: string
}

export class UpdateStateStorage {
    private runtimeDir: string
    private stateFilePath: string
    private baseVersion: string

    constructor(options?: UpdateStateStorageOptions) {
        this.baseVersion = options?.baseVersion || '1.0.0'
        this.runtimeDir =
            options?.runtimeDir ||
            path.join(os.homedir(), '.coding-professional-agent', 'runtime')
        this.stateFilePath = path.join(this.runtimeDir, 'update-state.json')
        this.ensureDirectory()
    }

    private ensureDirectory(): void {
        try {
            if (!fs.existsSync(this.runtimeDir)) {
                fs.mkdirSync(this.runtimeDir, { recursive: true })
            }
        } catch {}
    }

    public getRuntimeDir(): string {
        return this.runtimeDir
    }

    public loadState(): UpdateState {
        this.ensureDirectory()
        if (!fs.existsSync(this.stateFilePath)) {
            const defaultState: UpdateState = {
                activeVersion: this.baseVersion,
                activeAsarPath: null,
                baseBinaryVersion: this.baseVersion,
                consecutiveFailures: 0,
                pendingVersion: null,
                pendingAsarPath: null,
                lastCheckTime: null,
            }
            this.saveState(defaultState)
            return defaultState
        }

        try {
            const content = fs.readFileSync(this.stateFilePath, 'utf8')
            const parsed = JSON.parse(content) as Partial<UpdateState>
            let storedBaseBinary = parsed.baseBinaryVersion || this.baseVersion

            // Check if user installed a newer full binary installer.
            // Guard against the active hot-patch version being incorrectly treated as a new base installer.
            let isNewerBase = false
            try {
                if (semver.valid(this.baseVersion) && semver.valid(storedBaseBinary)) {
                    const isPatchVersion =
                        (parsed.activeVersion && this.baseVersion === parsed.activeVersion) ||
                        (parsed.pendingVersion && this.baseVersion === parsed.pendingVersion)

                    if (!isPatchVersion && semver.gt(this.baseVersion, storedBaseBinary)) {
                        isNewerBase = true
                    }
                }
            } catch {}

            if (isNewerBase) {
                const refreshedState: UpdateState = {
                    activeVersion: this.baseVersion,
                    activeAsarPath: null,
                    baseBinaryVersion: this.baseVersion,
                    consecutiveFailures: 0,
                    pendingVersion: null,
                    pendingAsarPath: null,
                    lastCheckTime: parsed.lastCheckTime ?? null,
                }
                this.saveState(refreshedState)
                return refreshedState
            }

            // Auto-heal: if baseBinaryVersion was previously corrupted to match the patch version
            // while runtime this.baseVersion is the genuine lower base binary, restore genuine baseBinaryVersion
            if (
                semver.valid(this.baseVersion) &&
                semver.valid(storedBaseBinary) &&
                semver.lt(this.baseVersion, storedBaseBinary) &&
                storedBaseBinary === parsed.activeVersion
            ) {
                storedBaseBinary = this.baseVersion
            }

            // Auto-heal: if activeAsarPath was incorrectly cleared or null, but activeVersion exists,
            // the corresponding asar file exists on disk, and activeVersion is strictly newer than baseBinary,
            // recover activeAsarPath so cold start loads the latest patched version seamlessly.
            let activeAsarPath = parsed.activeAsarPath ?? null
            if (
                !activeAsarPath &&
                parsed.activeVersion &&
                parsed.activeVersion !== storedBaseBinary &&
                semver.valid(parsed.activeVersion) &&
                semver.valid(storedBaseBinary) &&
                semver.gt(parsed.activeVersion, storedBaseBinary)
            ) {
                const candidateRelPath = path.join('versions', parsed.activeVersion, 'app.asar')
                const candidateAbsPath = path.join(this.runtimeDir, candidateRelPath)
                if (fs.existsSync(candidateAbsPath)) {
                    activeAsarPath = candidateRelPath
                    const healedState: UpdateState = {
                        activeVersion: parsed.activeVersion,
                        activeAsarPath,
                        baseBinaryVersion: storedBaseBinary,
                        consecutiveFailures: 0,
                        pendingVersion: parsed.pendingVersion ?? null,
                        pendingAsarPath: parsed.pendingAsarPath ?? null,
                        lastCheckTime: parsed.lastCheckTime ?? null,
                    }
                    this.saveState(healedState)
                    return healedState
                }
            }

            return {
                activeVersion: parsed.activeVersion || this.baseVersion,
                activeAsarPath,
                baseBinaryVersion: storedBaseBinary,
                consecutiveFailures: typeof parsed.consecutiveFailures === 'number' ? parsed.consecutiveFailures : 0,
                pendingVersion: parsed.pendingVersion ?? null,
                pendingAsarPath: parsed.pendingAsarPath ?? null,
                lastCheckTime: parsed.lastCheckTime ?? null,
            }
        } catch {
            return {
                activeVersion: this.baseVersion,
                activeAsarPath: null,
                baseBinaryVersion: this.baseVersion,
                consecutiveFailures: 0,
                pendingVersion: null,
                pendingAsarPath: null,
                lastCheckTime: null,
            }
        }
    }

    public saveState(state: UpdateState): void {
        this.ensureDirectory()
        const tempPath = `${this.stateFilePath}.tmp`
        fs.writeFileSync(tempPath, JSON.stringify(state, null, 2), 'utf8')
        fs.renameSync(tempPath, this.stateFilePath)
    }

    public recordPendingVersion(version: string, asarRelativePath: string): void {
        const state = this.loadState()
        state.pendingVersion = version
        state.pendingAsarPath = asarRelativePath
        this.saveState(state)
    }

    public activatePendingVersion(): void {
        const state = this.loadState()
        if (state.pendingVersion && state.pendingAsarPath) {
            state.activeVersion = state.pendingVersion
            state.activeAsarPath = state.pendingAsarPath
            state.pendingVersion = null
            state.pendingAsarPath = null
            state.consecutiveFailures = 0
            this.saveState(state)
        }
    }

    public incrementFailure(): number {
        const state = this.loadState()
        state.consecutiveFailures += 1
        this.saveState(state)
        return state.consecutiveFailures
    }

    public shouldRollback(): boolean {
        const state = this.loadState()
        return state.consecutiveFailures >= 2 && state.activeAsarPath !== null
    }

    public rollbackToBase(): UpdateState {
        const state = this.loadState()
        state.activeVersion = state.baseBinaryVersion
        state.activeAsarPath = null
        state.consecutiveFailures = 0
        state.pendingVersion = null
        state.pendingAsarPath = null
        this.saveState(state)
        return state
    }

    public confirmHealthy(): void {
        const state = this.loadState()
        if (state.consecutiveFailures > 0) {
            state.consecutiveFailures = 0
            this.saveState(state)
        }
    }
}
