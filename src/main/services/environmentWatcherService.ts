import * as fs from 'node:fs/promises'
import * as fsSync from 'node:fs'
import * as path from 'node:path'
import type { NativeEvent } from '../../shared/types.js'

export interface ProjectEnvironmentResult {
  filePath: string
  content: string
}

export interface EnvironmentWatcherServiceOptions {
  debounceMs?: number
}

export class EnvironmentWatcherService {
  private readonly emitEvent?: (event: NativeEvent) => void
  private readonly debounceMs: number
  private readonly cache = new Map<string, ProjectEnvironmentResult | null>()
  private readonly watchers = new Map<string, fsSync.FSWatcher[]>()
  private readonly debounceTimers = new Map<string, NodeJS.Timeout>()

  constructor(
    emitEvent?: (event: NativeEvent) => void,
    options?: EnvironmentWatcherServiceOptions,
  ) {
    this.emitEvent = emitEvent
    this.debounceMs = options?.debounceMs ?? 100
  }

  /**
   * Resolve environment file candidate paths for a given project root.
   */
  private getCandidatePaths(projectPath: string): string[] {
    const normalized = path.resolve(projectPath)
    return [
      path.join(normalized, '.cpa', 'environments', 'environment.toml'),
      path.join(normalized, '.codex', 'environments', 'environment.toml'),
      path.join(normalized, 'environment.toml'),
    ]
  }

  /**
   * Safely read environment file if it exists without throwing ENOENT errors.
   */
  private async detectEnvironment(
    projectPath: string,
  ): Promise<ProjectEnvironmentResult | null> {
    const candidates = this.getCandidatePaths(projectPath)
    for (const candidate of candidates) {
      try {
        const content = await fs.readFile(candidate, 'utf8')
        return {
          filePath: candidate,
          content,
        }
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
          continue
        }
        // For permissions or other errors, log or continue
      }
    }
    return null
  }

  /**
   * Get project environment info from cache or disk.
   */
  async getProjectEnvironment(
    projectPath: string,
  ): Promise<ProjectEnvironmentResult | null> {
    if (!projectPath || typeof projectPath !== 'string') return null
    const normalized = path.resolve(projectPath)

    if (this.cache.has(normalized)) {
      return this.cache.get(normalized) ?? null
    }

    const detected = await this.detectEnvironment(normalized)
    this.cache.set(normalized, detected)
    this.ensureWatcher(normalized)
    return detected
  }

  /**
   * Synchronize list of active projects being watched.
   */
  async watchProjects(projectPaths: string[]): Promise<void> {
    if (!Array.isArray(projectPaths)) return
    const normalizedPaths = new Set(
      projectPaths.filter(Boolean).map((p) => path.resolve(p)),
    )

    // Remove watchers for unneeded paths
    for (const [watchedPath] of this.watchers) {
      if (!normalizedPaths.has(watchedPath)) {
        this.unwatch(watchedPath)
        this.cache.delete(watchedPath)
      }
    }

    // Add watchers and preload cache for new paths
    for (const p of normalizedPaths) {
      this.ensureWatcher(p)
      if (!this.cache.has(p)) {
        const detected = await this.detectEnvironment(p)
        this.cache.set(p, detected)
      }
    }
  }

  /**
   * Ensure file system watchers are attached for the project and relevant config subdirectories.
   */
  private ensureWatcher(projectPath: string): void {
    if (this.watchers.has(projectPath)) return

    try {
      if (!fsSync.existsSync(projectPath)) return
      const stat = fsSync.statSync(projectPath)
      if (!stat.isDirectory()) return
    } catch {
      return
    }

    const activeWatchers: fsSync.FSWatcher[] = []

    const attachWatcher = (dirToWatch: string) => {
      try {
        if (!fsSync.existsSync(dirToWatch)) return
        const watcher = fsSync.watch(
          dirToWatch,
          { persistent: false },
          (_eventType, filename) => {
            if (
              !filename ||
              filename === 'environment.toml' ||
              filename === 'environments' ||
              filename === '.cpa' ||
              filename === '.codex' ||
              filename.endsWith('.toml')
            ) {
              this.handleFileChange(projectPath)
            }
          },
        )
        watcher.on('error', () => {
          // Ignore watcher errors (e.g. directory deleted)
        })
        activeWatchers.push(watcher)
      } catch {
        // Ignore watcher setup errors
      }
    }

    // Watch project root
    attachWatcher(projectPath)

    // Watch .cpa and .cpa/environments if present
    const cpaDir = path.join(projectPath, '.cpa')
    attachWatcher(cpaDir)
    attachWatcher(path.join(cpaDir, 'environments'))

    // Watch .codex and .codex/environments if present
    const codexDir = path.join(projectPath, '.codex')
    attachWatcher(codexDir)
    attachWatcher(path.join(codexDir, 'environments'))

    if (activeWatchers.length > 0) {
      this.watchers.set(projectPath, activeWatchers)
    }
  }

  /**
   * Handle debounced change event for a project path.
   */
  private handleFileChange(projectPath: string): void {
    const existingTimer = this.debounceTimers.get(projectPath)
    if (existingTimer) {
      clearTimeout(existingTimer)
    }

    const timer = setTimeout(async () => {
      this.debounceTimers.delete(projectPath)
      const previous = this.cache.get(projectPath)
      const current = await this.detectEnvironment(projectPath)

      const isSame =
        (previous === null && current === null) ||
        (previous?.filePath === current?.filePath &&
          previous?.content === current?.content)

      this.cache.set(projectPath, current)

      // Refresh sub-watchers if .cpa or .codex directories were newly created
      if (!this.watchers.has(projectPath) || this.watchers.get(projectPath)!.length <= 1) {
        this.unwatch(projectPath)
        this.ensureWatcher(projectPath)
      }

      if (!isSame && this.emitEvent) {
        this.emitEvent({
          operationId: `env-watch-${Date.now()}`,
          sequence: Date.now(),
          kind: 'environment:changed',
          data: JSON.stringify({
            projectPath,
            hasEnv: current !== null,
            filePath: current?.filePath ?? null,
            content: current?.content ?? null,
          }),
        })
      }
    }, this.debounceMs)

    this.debounceTimers.set(projectPath, timer)
  }

  /**
   * Stop watching a project path and clean up timers and listeners.
   */
  private unwatch(projectPath: string): void {
    const timer = this.debounceTimers.get(projectPath)
    if (timer) {
      clearTimeout(timer)
      this.debounceTimers.delete(projectPath)
    }

    const watcherList = this.watchers.get(projectPath)
    if (watcherList) {
      for (const watcher of watcherList) {
        try {
          watcher.close()
        } catch {
          // Ignore close errors
        }
      }
      this.watchers.delete(projectPath)
    }
  }

  /**
   * Invalidate cached environment info for a project path or all projects.
   */
  invalidateCache(projectPath?: string): void {
    if (projectPath) {
      const normalized = path.resolve(projectPath)
      this.cache.delete(normalized)
    } else {
      this.cache.clear()
    }
  }

  /**
   * Dispose all active watchers and clear state.
   */
  dispose(): void {
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer)
    }
    this.debounceTimers.clear()

    for (const watcherList of this.watchers.values()) {
      for (const watcher of watcherList) {
        try {
          watcher.close()
        } catch {
          // Ignore
        }
      }
    }
    this.watchers.clear()
    this.cache.clear()
  }
}
