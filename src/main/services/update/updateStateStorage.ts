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
            const storedBaseBinary = parsed.baseBinaryVersion || this.baseVersion

            // Check if user installed a newer full binary installer
            let isNewerBase = false
            try {
                if (semver.valid(this.baseVersion) && semver.valid(storedBaseBinary)) {
                    isNewerBase = semver.gt(this.baseVersion, storedBaseBinary)
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

            return {
                activeVersion: parsed.activeVersion || this.baseVersion,
                activeAsarPath: parsed.activeAsarPath ?? null,
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
