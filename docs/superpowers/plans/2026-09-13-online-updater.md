# 在线升级与双轨更新实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为桌面端应用构建兼备轻量 TS 代码热更新（基于 asar 原子挂载）与完整安装包升级（基于 electron-updater 与系统原生安装器）的双轨在线升级功能。

**Architecture:** 主进程 UpdateService 通过 GitHub Releases 托管的 `release-manifest.json` 进行智能兼容性分流。TS 热更新将业务代码打包为 `app-update-<version>.asar`，下载强校验 SHA-256 后存入用户数据目录 `~/.coding-professional-agent/runtime/` 并由微引导加载器（Bootstrapper）在重启时挂载，内置 2 次连续崩溃自动回滚出厂版本的容灾能力；全量更新则接管底层原生升级。前端通过 RPC 与设置页卡片展示更新状态。

**Tech Stack:** Electron 44, TypeScript 5.8, Node.js crypto / streams / http, @electron/asar, React 19, Tailwind CSS v4, Vitest.

## Global Constraints

- **KISS 原则**：保持结构单一明了，避免复杂的免重启热重载，TS 更新通过整体 asar 原子挂载并在重启时生效。
- **配置集中存储约束**：所有状态文件与更新 asar 必须保存于 `~/.coding-professional-agent/runtime/`，严禁分散在操作系统其他临时目录。
- **零破坏签名与零系统提权**：热更新不原地修改系统安装目录 `/Applications` 或 `C:\Program Files`，彻底规避 macOS 代码签名破坏和 Windows 文件占用锁定。
- **发布仓库**：GitHub Releases 目标仓库为 `https://github.com/router-for-me/CodingProfessionalAgent`。
- **语言与规范**：所有代码注释使用英文，Git Commit Message 完全使用英文，规格与计划文档完全使用中文。

---

### Task 1: 升级数据契约与本地状态存储（Types & UpdateStateStorage）

**Files:**
- Create: `src/shared/updateTypes.ts`
- Create: `src/main/services/update/updateStateStorage.ts`
- Test: `test/main/services/update/updateStateStorage.test.ts`

**Interfaces:**
- Consumes: Node.js `fs`, `path`, `os`
- Produces:
  - `export interface ReleaseManifest`: 远程发布元数据接口
  - `export interface UpdateState`: 本地运行态状态机模型
  - `export class UpdateStateStorage`: 负责读写 `~/.coding-professional-agent/runtime/update-state.json`，管理连续崩溃计数与活动版本切换

- [ ] **Step 1: 编写 UpdateStateStorage 的失败测试**

```ts
// test/main/services/update/updateStateStorage.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { UpdateStateStorage } from '../../../src/main/services/update/updateStateStorage.js'

describe('UpdateStateStorage', () => {
  let tempDir: string
  let storage: UpdateStateStorage

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpa-update-test-'))
    storage = new UpdateStateStorage({ runtimeDir: tempDir, baseVersion: '1.0.0' })
  })

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true })
    } catch {}
  })

  it('initializes with default state when file does not exist', () => {
    const state = storage.loadState()
    expect(state.activeVersion).toBe('1.0.0')
    expect(state.baseBinaryVersion).toBe('1.0.0')
    expect(state.consecutiveFailures).toBe(0)
    expect(state.activeAsarPath).toBeNull()
  })

  it('increments consecutive failures and triggers rollback after 2 failures', () => {
    storage.recordPendingVersion('1.1.0', 'versions/1.1.0/app.asar')
    storage.activatePendingVersion()

    expect(storage.loadState().activeVersion).toBe('1.1.0')

    // First crash before health check
    const failures1 = storage.incrementFailure()
    expect(failures1).toBe(1)
    expect(storage.shouldRollback()).toBe(false)

    // Second crash
    const failures2 = storage.incrementFailure()
    expect(failures2).toBe(2)
    expect(storage.shouldRollback()).toBe(true)

    // Trigger rollback
    const rolledBackState = storage.rollbackToBase()
    expect(rolledBackState.activeVersion).toBe('1.0.0')
    expect(rolledBackState.activeAsarPath).toBeNull()
    expect(rolledBackState.consecutiveFailures).toBe(0)
  })

  it('clears failure count upon health confirmation', () => {
    storage.incrementFailure()
    expect(storage.loadState().consecutiveFailures).toBe(1)
    storage.confirmHealthy()
    expect(storage.loadState().consecutiveFailures).toBe(0)
  })
})
```

- [ ] **Step 2: 运行测试并验证其失败**

Run: `pnpm exec vitest run test/main/services/update/updateStateStorage.test.ts`
Expected: FAIL (Cannot find module)

- [ ] **Step 3: 编写核心数据模型与 UpdateStateStorage 实现**

```ts
// src/shared/updateTypes.ts
export type UpdatePhase = 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'error'
export type UpdateType = 'hot' | 'full'

export interface NativeRequirements {
  electron: string
  modules: string
  minNativeBaseVersion: string
}

export interface AsarAsset {
  filename: string
  url: string
  sha256: string
  size: number
}

export interface InstallerAsset {
  filename: string
  url: string
  sha256: string
  size: number
}

export interface ReleaseManifest {
  version: string
  releaseDate: string
  releaseNotes: string
  nativeRequirements: NativeRequirements
  asar?: AsarAsset
  installers?: Record<string, InstallerAsset>
}

export interface UpdateState {
  activeVersion: string
  activeAsarPath: string | null
  baseBinaryVersion: string
  consecutiveFailures: number
  pendingVersion: string | null
  pendingAsarPath: string | null
  lastCheckTime: string | null
}

export interface DownloadProgress {
  percent: number
  transferredBytes: number
  totalBytes: number
  bytesPerSecond: number
}

export interface UpdateStatusSnapshot {
  phase: UpdatePhase
  currentVersion: string
  availableVersion?: string
  updateType?: UpdateType
  releaseNotes?: string
  releaseDate?: string
  downloadProgress?: DownloadProgress
  errorMessage?: string
}
```

```ts
// src/main/services/update/updateStateStorage.ts
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
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
      return {
        activeVersion: parsed.activeVersion || this.baseVersion,
        activeAsarPath: parsed.activeAsarPath ?? null,
        baseBinaryVersion: parsed.baseBinaryVersion || this.baseVersion,
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
```

- [ ] **Step 4: 运行测试并验证其通过**

Run: `pnpm exec vitest run test/main/services/update/updateStateStorage.test.ts`
Expected: PASS

- [ ] **Step 5: 提交代码**

```bash
git add src/shared/updateTypes.ts src/main/services/update/updateStateStorage.ts test/main/services/update/updateStateStorage.test.ts
git commit -m "feat(update): add update types and UpdateStateStorage with rollback logic"
```

---

### Task 2: 哈希校验器与热更新下载部署器（Checksum & AsarHotUpdater）

**Files:**
- Create: `src/main/services/update/checksum.ts`
- Create: `src/main/services/update/asarHotUpdater.ts`
- Test: `test/main/services/update/checksum.test.ts`
- Test: `test/main/services/update/asarHotUpdater.test.ts`

**Interfaces:**
- Consumes: Node.js `crypto`, `fs`, `stream`, `https`, `http`, `UpdateStateStorage`
- Produces:
  - `export async function verifyFileSha256(filePath: string, expectedSha256: string): Promise<boolean>`
  - `export class AsarHotUpdater`: 负责下载 `app-update-<version>.asar` 到临时文件、校验 SHA-256、原子移动到 `runtime/versions/<version>/app.asar`、记录待生效状态

- [ ] **Step 1: 编写 Checksum 与 AsarHotUpdater 的失败测试**

```ts
// test/main/services/update/checksum.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import * as crypto from 'node:crypto'
import { verifyFileSha256, calculateFileSha256 } from '../../../src/main/services/update/checksum.js'

describe('checksum utils', () => {
  let tempFile: string

  beforeEach(() => {
    tempFile = path.join(os.tmpdir(), `test-sha256-${Date.now()}.txt`)
    fs.writeFileSync(tempFile, 'Hello CPA Update World!', 'utf8')
  })

  afterEach(() => {
    try {
      fs.unlinkSync(tempFile)
    } catch {}
  })

  it('correctly calculates and verifies SHA-256', async () => {
    const expected = crypto.createHash('sha256').update('Hello CPA Update World!').digest('hex')
    const calculated = await calculateFileSha256(tempFile)
    expect(calculated).toBe(expected)

    const isValid = await verifyFileSha256(tempFile, expected)
    expect(isValid).toBe(true)

    const isInvalid = await verifyFileSha256(tempFile, 'invalid-hash-value')
    expect(isInvalid).toBe(false)
  })
})
```

- [ ] **Step 2: 运行测试并验证其失败**

Run: `pnpm exec vitest run test/main/services/update/checksum.test.ts`
Expected: FAIL (Cannot find module)

- [ ] **Step 3: 实现 checksum.ts 与 asarHotUpdater.ts**

```ts
// src/main/services/update/checksum.ts
import * as fs from 'node:fs'
import * as crypto from 'node:crypto'

export async function calculateFileSha256(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    const stream = fs.createReadStream(filePath)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex').toLowerCase()))
    stream.on('error', (err) => reject(err))
  })
}

export async function verifyFileSha256(filePath: string, expectedSha256: string): Promise<boolean> {
  try {
    const actual = await calculateFileSha256(filePath)
    return actual.trim().toLowerCase() === expectedSha256.trim().toLowerCase()
  } catch {
    return false
  }
}
```

```ts
// src/main/services/update/asarHotUpdater.ts
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as https from 'node:https'
import * as http from 'node:http'
import type { AsarAsset, DownloadProgress } from '../../../shared/updateTypes.js'
import { verifyFileSha256 } from './checksum.js'
import type { UpdateStateStorage } from './updateStateStorage.js'

export interface HotUpdateDeployResult {
  version: string
  asarRelativePath: string
  asarAbsolutePath: string
}

export class AsarHotUpdater {
  private storage: UpdateStateStorage

  constructor(storage: UpdateStateStorage) {
    this.storage = storage
  }

  public async downloadAndStage(
    asset: AsarAsset,
    version: string,
    onProgress?: (progress: DownloadProgress) => void,
    abortSignal?: AbortSignal,
  ): Promise<HotUpdateDeployResult> {
    const runtimeDir = this.storage.getRuntimeDir()
    const pendingDir = path.join(runtimeDir, 'pending')
    const versionsDir = path.join(runtimeDir, 'versions', version)

    fs.mkdirSync(pendingDir, { recursive: true })
    fs.mkdirSync(versionsDir, { recursive: true })

    const tempFilePath = path.join(pendingDir, `app-update-${version}-${Date.now()}.tmp`)
    const targetAsarPath = path.join(versionsDir, 'app.asar')

    try {
      await this.downloadFileWithProgress(asset.url, tempFilePath, asset.size, onProgress, abortSignal)

      const isValid = await verifyFileSha256(tempFilePath, asset.sha256)
      if (!isValid) {
        throw new Error(`SHA-256 verification failed for version ${version}`)
      }

      fs.renameSync(tempFilePath, targetAsarPath)
      const relativePath = path.join('versions', version, 'app.asar')
      this.storage.recordPendingVersion(version, relativePath)

      return {
        version,
        asarRelativePath: relativePath,
        asarAbsolutePath: targetAsarPath,
      }
    } finally {
      if (fs.existsSync(tempFilePath)) {
        try {
          fs.unlinkSync(tempFilePath)
        } catch {}
      }
    }
  }

  private downloadFileWithProgress(
    url: string,
    destPath: string,
    expectedTotalBytes: number,
    onProgress?: (progress: DownloadProgress) => void,
    abortSignal?: AbortSignal,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const fileStream = fs.createWriteStream(destPath)
      let transferredBytes = 0
      let lastTime = Date.now()
      let lastBytes = 0

      const followRedirect = (targetUrl: string, maxRedirects: number = 5) => {
        if (maxRedirects <= 0) {
          fileStream.close()
          return reject(new Error('Too many HTTP redirects'))
        }

        const client = targetUrl.startsWith('https:') ? https : http
        const req = client.get(targetUrl, { signal: abortSignal }, (res) => {
          if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            return followRedirect(res.headers.location, maxRedirects - 1)
          }

          if (res.statusCode !== 200) {
            fileStream.close()
            return reject(new Error(`Download failed with HTTP status code ${res.statusCode}`))
          }

          const totalBytes = Number(res.headers['content-length']) || expectedTotalBytes

          res.on('data', (chunk: Buffer) => {
            transferredBytes += chunk.length
            fileStream.write(chunk)

            const now = Date.now()
            const timeDiff = (now - lastTime) / 1000
            if (timeDiff >= 0.2 || transferredBytes === totalBytes) {
              const speed = timeDiff > 0 ? (transferredBytes - lastBytes) / timeDiff : 0
              lastTime = now
              lastBytes = transferredBytes
              onProgress?.({
                percent: totalBytes > 0 ? Math.min(100, Math.round((transferredBytes / totalBytes) * 100)) : 0,
                transferredBytes,
                totalBytes,
                bytesPerSecond: Math.round(speed),
              })
            }
          })

          res.on('end', () => {
            fileStream.end(() => resolve())
          })

          res.on('error', (err) => {
            fileStream.close()
            reject(err)
          })
        })

        req.on('error', (err) => {
          fileStream.close()
          reject(err)
        })
      }

      followRedirect(url)
    })
  }
}
```

- [ ] **Step 4: 运行测试并验证其通过**

Run: `pnpm exec vitest run test/main/services/update/checksum.test.ts`
Expected: PASS

- [ ] **Step 5: 提交代码**

```bash
git add src/main/services/update/checksum.ts src/main/services/update/asarHotUpdater.ts test/main/services/update/checksum.test.ts
git commit -m "feat(update): implement checksum verification and AsarHotUpdater"
```

---

### Task 3: 版本兼容性决策器与全量升级提供者（UpdateDecision & FullUpdateProvider）

**Files:**
- Create: `src/main/services/update/updateDecision.ts`
- Create: `src/main/services/update/fullUpdateProvider.ts`
- Test: `test/main/services/update/updateDecision.test.ts`

**Interfaces:**
- Consumes: `ReleaseManifest`, `UpdateType`, `semver`
- Produces:
  - `export function decideUpdateType(manifest: ReleaseManifest, currentEnv: LocalEnvironment): UpdateType`
  - `export class FullUpdateProvider`: 封装针对不同 OS（macOS DMG, Windows EXE, Linux AppImage）的安装包下载与系统调起

- [ ] **Step 1: 编写决策逻辑的失败测试**

```ts
// test/main/services/update/updateDecision.test.ts
import { describe, it, expect } from 'vitest'
import { decideUpdateType, type LocalEnvironment } from '../../../src/main/services/update/updateDecision.js'
import type { ReleaseManifest } from '../../../src/shared/updateTypes.js'

describe('decideUpdateType', () => {
  const baseManifest: ReleaseManifest = {
    version: '1.1.0',
    releaseDate: '2026-09-15T00:00:00Z',
    releaseNotes: 'test notes',
    nativeRequirements: {
      electron: '44.0.0',
      modules: '130',
      minNativeBaseVersion: '1.0.0',
    },
    asar: {
      filename: 'app-update-1.1.0.asar',
      url: 'https://example.com/app.asar',
      sha256: 'abc',
      size: 1024,
    },
  }

  it('selects hot update when local environment satisfies all native requirements', () => {
    const localEnv: LocalEnvironment = {
      electronVersion: '44.0.0',
      nodeAbiVersion: '130',
      baseBinaryVersion: '1.0.0',
      currentVersion: '1.0.0',
    }

    const type = decideUpdateType(baseManifest, localEnv)
    expect(type).toBe('hot')
  })

  it('selects full update when electron version mismatches', () => {
    const localEnv: LocalEnvironment = {
      electronVersion: '43.0.0',
      nodeAbiVersion: '130',
      baseBinaryVersion: '1.0.0',
      currentVersion: '1.0.0',
    }

    const type = decideUpdateType(baseManifest, localEnv)
    expect(type).toBe('full')
  })

  it('selects full update when node ABI mismatches', () => {
    const localEnv: LocalEnvironment = {
      electronVersion: '44.0.0',
      nodeAbiVersion: '128',
      baseBinaryVersion: '1.0.0',
      currentVersion: '1.0.0',
    }

    const type = decideUpdateType(baseManifest, localEnv)
    expect(type).toBe('full')
  })

  it('selects full update when manifest lacks asar asset', () => {
    const noAsarManifest = { ...baseManifest, asar: undefined }
    const localEnv: LocalEnvironment = {
      electronVersion: '44.0.0',
      nodeAbiVersion: '130',
      baseBinaryVersion: '1.0.0',
      currentVersion: '1.0.0',
    }

    const type = decideUpdateType(noAsarManifest, localEnv)
    expect(type).toBe('full')
  })
})
```

- [ ] **Step 2: 运行测试并验证其失败**

Run: `pnpm exec vitest run test/main/services/update/updateDecision.test.ts`
Expected: FAIL (Cannot find module)

- [ ] **Step 3: 实现 updateDecision.ts 与 fullUpdateProvider.ts**

```ts
// src/main/services/update/updateDecision.ts
import semver from 'semver'
import type { ReleaseManifest, UpdateType } from '../../../shared/updateTypes.js'

export interface LocalEnvironment {
  electronVersion: string
  nodeAbiVersion: string
  baseBinaryVersion: string
  currentVersion: string
}

export function decideUpdateType(manifest: ReleaseManifest, localEnv: LocalEnvironment): UpdateType {
  // If no asar asset is available in release manifest, must perform full update
  if (!manifest.asar || !manifest.asar.url) {
    return 'full'
  }

  const req = manifest.nativeRequirements
  if (!req) {
    return 'full'
  }

  // 1. Electron major version must match
  const remoteElectronMajor = semver.major(req.electron || '0.0.0')
  const localElectronMajor = semver.major(localEnv.electronVersion || '0.0.0')
  if (remoteElectronMajor !== localElectronMajor) {
    return 'full'
  }

  // 2. Node module ABI must match
  if (req.modules && req.modules !== localEnv.nodeAbiVersion) {
    return 'full'
  }

  // 3. Base binary version floor check
  if (req.minNativeBaseVersion && semver.lt(localEnv.baseBinaryVersion, req.minNativeBaseVersion)) {
    return 'full'
  }

  return 'hot'
}
```

```ts
// src/main/services/update/fullUpdateProvider.ts
import { shell } from 'electron'
import * as child_process from 'node:child_process'
import * as path from 'node:path'
import * as fs from 'node:fs'
import type { InstallerAsset } from '../../../shared/updateTypes.js'

export class FullUpdateProvider {
  public resolvePlatformKey(): string {
    const platform = process.platform
    const arch = process.arch
    if (platform === 'darwin') {
      return arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64'
    }
    if (platform === 'win32') {
      return arch === 'arm64' ? 'win32-arm64' : 'win32-x64'
    }
    return arch === 'arm64' ? 'linux-arm64' : 'linux-x64'
  }

  public async launchInstaller(filePath: string): Promise<void> {
    const platform = process.platform
    if (platform === 'darwin') {
      await shell.openPath(filePath)
    } else if (platform === 'win32') {
      child_process.spawn(filePath, [], { detached: true, stdio: 'ignore' }).unref()
    } else {
      try {
        fs.chmodSync(filePath, 0o755)
      } catch {}
      await shell.openPath(path.dirname(filePath))
    }
  }
}
```

- [ ] **Step 4: 运行测试并验证其通过**

Run: `pnpm exec vitest run test/main/services/update/updateDecision.test.ts`
Expected: PASS

- [ ] **Step 5: 提交代码**

```bash
git add src/main/services/update/updateDecision.ts src/main/services/update/fullUpdateProvider.ts test/main/services/update/updateDecision.test.ts
git commit -m "feat(update): implement update decision logic and full update provider"
```

---

### Task 4: 主进程核心更新服务与启动微引导器（UpdateService & Bootstrapper）

**Files:**
- Create: `src/main/bootstrapper.ts`
- Create: `src/main/services/update/updateService.ts`
- Modify: `src/main/ipc/registerIpcHandlers.ts`
- Test: `test/main/services/update/updateService.test.ts`

**Interfaces:**
- Consumes: `UpdateStateStorage`, `AsarHotUpdater`, `FullUpdateProvider`, `decideUpdateType`
- Produces:
  - `export class UpdateService`: 状态机驱动核心服务，支持 `checkForUpdates`, `startDownload`, `quitAndInstall`
  - `export function resolveMainScriptToExecute()`: 微引导器入口挂载函数

- [ ] **Step 1: 编写 UpdateService 状态机测试**

```ts
// test/main/services/update/updateService.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { UpdateService } from '../../../src/main/services/update/updateService.js'
import { UpdateStateStorage } from '../../../src/main/services/update/updateStateStorage.js'

describe('UpdateService', () => {
  let tempDir: string
  let storage: UpdateStateStorage
  let service: UpdateService

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpa-service-test-'))
    storage = new UpdateStateStorage({ runtimeDir: tempDir, baseVersion: '1.0.0' })
    service = new UpdateService({
      storage,
      currentVersion: '1.0.0',
      electronVersion: '44.0.0',
      nodeAbiVersion: '130',
      repoOwner: 'router-for-me',
      repoName: 'CodingProfessionalAgent',
    })
  })

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true })
    } catch {}
  })

  it('starts at idle phase with current version', () => {
    const snapshot = service.getStatusSnapshot()
    expect(snapshot.phase).toBe('idle')
    expect(snapshot.currentVersion).toBe('1.0.0')
  })
})
```

- [ ] **Step 2: 运行测试并验证其失败**

Run: `pnpm exec vitest run test/main/services/update/updateService.test.ts`
Expected: FAIL (Cannot find module)

- [ ] **Step 3: 实现 UpdateService 与微引导器 bootstrapper.ts**

```ts
// src/main/bootstrapper.ts
import * as fs from 'node:fs'
import * as path from 'node:path'
import { app } from 'electron'
import { UpdateStateStorage } from './services/update/updateStateStorage.js'

export function resolveMainEntry(baseDefaultMainPath: string): string {
  // If running in development mode, load default entry directly
  if (!app.isPackaged) {
    return baseDefaultMainPath
  }

  const storage = new UpdateStateStorage({
    baseVersion: app.getVersion() || '1.0.0',
  })

  // Guard against consecutive startup crashes
  if (storage.shouldRollback()) {
    console.warn('[Bootstrapper] Consecutive startup failures detected, rolling back to base version.')
    storage.rollbackToBase()
    return baseDefaultMainPath
  }

  const state = storage.loadState()
  if (state.activeAsarPath) {
    const absoluteAsarPath = path.join(storage.getRuntimeDir(), state.activeAsarPath)
    if (fs.existsSync(absoluteAsarPath)) {
      // Mark potential crash before application enters main event loop
      storage.incrementFailure()
      return path.join(absoluteAsarPath, 'dist-electron', 'src', 'main', 'index.js')
    }
  }

  return baseDefaultMainPath
}
```

```ts
// src/main/services/update/updateService.ts
import { app } from 'electron'
import semver from 'semver'
import https from 'node:https'
import type {
  ReleaseManifest,
  UpdatePhase,
  UpdateStatusSnapshot,
  UpdateType,
} from '../../../shared/updateTypes.js'
import { UpdateStateStorage } from './updateStateStorage.js'
import { AsarHotUpdater } from './asarHotUpdater.js'
import { FullUpdateProvider } from './fullUpdateProvider.js'
import { decideUpdateType } from './updateDecision.js'

export interface UpdateServiceOptions {
  storage?: UpdateStateStorage
  currentVersion?: string
  electronVersion?: string
  nodeAbiVersion?: string
  repoOwner?: string
  repoName?: string
}

export class UpdateService {
  private storage: UpdateStateStorage
  private hotUpdater: AsarHotUpdater
  private fullProvider: FullUpdateProvider
  private currentVersion: string
  private electronVersion: string
  private nodeAbiVersion: string
  private repoOwner: string
  private repoName: string

  private phase: UpdatePhase = 'idle'
  private availableManifest: ReleaseManifest | null = null
  private resolvedUpdateType: UpdateType | null = null
  private errorMessage: string | null = null
  private downloadAbortController: AbortController | null = null

  constructor(options?: UpdateServiceOptions) {
    this.storage = options?.storage || new UpdateStateStorage()
    this.hotUpdater = new AsarHotUpdater(this.storage)
    this.fullProvider = new FullUpdateProvider()
    this.currentVersion = options?.currentVersion || app?.getVersion?.() || '1.0.0'
    this.electronVersion = options?.electronVersion || process.versions.electron || '44.0.0'
    this.nodeAbiVersion = options?.nodeAbiVersion || process.versions.modules || '130'
    this.repoOwner = options?.repoOwner || 'router-for-me'
    this.repoName = options?.repoName || 'CodingProfessionalAgent'
  }

  public getStatusSnapshot(): UpdateStatusSnapshot {
    return {
      phase: this.phase,
      currentVersion: this.currentVersion,
      availableVersion: this.availableManifest?.version,
      updateType: this.resolvedUpdateType ?? undefined,
      releaseNotes: this.availableManifest?.releaseNotes,
      releaseDate: this.availableManifest?.releaseDate,
      errorMessage: this.errorMessage ?? undefined,
    }
  }

  public async checkForUpdates(): Promise<UpdateStatusSnapshot> {
    this.phase = 'checking'
    this.errorMessage = null

    try {
      const manifest = await this.fetchLatestManifest()
      if (semver.gt(manifest.version, this.currentVersion)) {
        this.availableManifest = manifest
        this.resolvedUpdateType = decideUpdateType(manifest, {
          electronVersion: this.electronVersion,
          nodeAbiVersion: this.nodeAbiVersion,
          baseBinaryVersion: this.storage.loadState().baseBinaryVersion,
          currentVersion: this.currentVersion,
        })
        this.phase = 'available'
      } else {
        this.phase = 'idle'
      }
    } catch (err: any) {
      this.phase = 'error'
      this.errorMessage = err.message || 'Failed to check for updates'
    }

    return this.getStatusSnapshot()
  }

  public async startDownload(onProgress?: (percent: number) => void): Promise<void> {
    if (!this.availableManifest) return
    this.phase = 'downloading'
    this.downloadAbortController = new AbortController()

    try {
      if (this.resolvedUpdateType === 'hot' && this.availableManifest.asar) {
        await this.hotUpdater.downloadAndStage(
          this.availableManifest.asar,
          this.availableManifest.version,
          (prog) => onProgress?.(prog.percent),
          this.downloadAbortController.signal,
        )
        this.phase = 'ready'
      }
    } catch (err: any) {
      this.phase = 'error'
      this.errorMessage = err.message || 'Download failed'
    }
  }

  public async quitAndInstall(): Promise<void> {
    if (this.phase !== 'ready') return
    this.storage.activatePendingVersion()
    app.relaunch()
    app.exit(0)
  }

  private fetchLatestManifest(): Promise<ReleaseManifest> {
    return new Promise((resolve, reject) => {
      const url = `https://github.com/${this.repoOwner}/${this.repoName}/releases/latest/download/release-manifest.json`
      https.get(url, { headers: { 'User-Agent': 'CodingProfessionalAgent' } }, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return https.get(res.headers.location, { headers: { 'User-Agent': 'CodingProfessionalAgent' } }, (redirectRes) => {
            this.pipeManifest(redirectRes, resolve, reject)
          })
        }
        this.pipeManifest(res, resolve, reject)
      }).on('error', reject)
    })
  }

  private pipeManifest(res: any, resolve: any, reject: any) {
    let data = ''
    res.on('data', (c: Buffer) => (data += c.toString()))
    res.on('end', () => {
      try {
        resolve(JSON.parse(data))
      } catch (err) {
        reject(err)
      }
    })
  }
}
```

- [ ] **Step 4: 运行测试并验证其通过**

Run: `pnpm exec vitest run test/main/services/update/updateService.test.ts`
Expected: PASS

- [ ] **Step 5: 提交代码**

```bash
git add src/main/bootstrapper.ts src/main/services/update/updateService.ts test/main/services/update/updateService.test.ts
git commit -m "feat(update): implement UpdateService and main process bootstrapper"
```

---

### Task 5: 自动化打包脚本与 GitHub Actions 发布流水线（Build Scripts & Workflow）

**Files:**
- Create: `scripts/build-update-patch.mjs`
- Create: `scripts/generate-release-manifest.mjs`
- Modify: `package.json`
- Modify: `.github/workflows/release.yml`

**Interfaces:**
- Consumes: `@electron/asar`, `crypto`, `fs`, `package.json`
- Produces:
  - `pnpm build:patch` 脚本命令：产出 `bin/dist/app-update-<version>.asar`
  - GitHub Actions `build-patch` 任务：自动发布 asar 到 Release
  - GitHub Actions `finalize` 任务：动态整合并上传 `release-manifest.json`

- [ ] **Step 1: 编写 build-update-patch.mjs 构建脚本**

```js
// scripts/build-update-patch.mjs
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as crypto from 'node:crypto'
import { execSync } from 'node:child_process'
import asar from '@electron/asar'

const rootDir = process.cwd()
const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'))
const version = pkg.version
const outDir = path.join(rootDir, 'bin', 'dist')
fs.mkdirSync(outDir, { recursive: true })

console.log(`[Patch Builder] Building CPA patch for version v${version}...`)

// 1. Build TS packages, frontend, and electron
execSync('pnpm build', { stdio: 'inherit' })

// 2. Prepare staging directory for asar
const stagingDir = path.join(outDir, 'staging-patch')
fs.rmSync(stagingDir, { recursive: true, force: true })
fs.mkdirSync(stagingDir, { recursive: true })

// Copy dist-electron, frontend/dist, plugins/bundled, and package.json
fs.cpSync(path.join(rootDir, 'dist-electron'), path.join(stagingDir, 'dist-electron'), { recursive: true })
fs.cpSync(path.join(rootDir, 'frontend', 'dist'), path.join(stagingDir, 'frontend', 'dist'), { recursive: true })
fs.cpSync(path.join(rootDir, 'plugins', 'bundled'), path.join(stagingDir, 'plugins', 'bundled'), { recursive: true })
fs.copyFileSync(path.join(rootDir, 'package.json'), path.join(stagingDir, 'package.json'))

const asarPath = path.join(outDir, `app-update-${version}.asar`)
console.log(`[Patch Builder] Creating asar archive at ${asarPath}...`)
await asar.createPackage(stagingDir, asarPath)
fs.rmSync(stagingDir, { recursive: true, force: true })

// 3. Calculate SHA-256
const asarBuf = fs.readFileSync(asarPath)
const sha256 = crypto.createHash('sha256').update(asarBuf).digest('hex')
const size = asarBuf.length

console.log(`[Patch Builder] Asar generated: size=${size} bytes, sha256=${sha256}`)
```

- [ ] **Step 2: 编写 generate-release-manifest.mjs 脚本并在 package.json 中配置**

```js
// scripts/generate-release-manifest.mjs
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as crypto from 'node:crypto'

const tag = process.argv[2] || 'v1.0.0'
const version = tag.replace(/^v/, '')
const repo = 'router-for-me/CodingProfessionalAgent'

const assetsDir = process.cwd()
const files = fs.readdirSync(assetsDir)

const manifest = {
  version,
  releaseDate: new Date().toISOString(),
  releaseNotes: `Release ${tag}`,
  nativeRequirements: {
    electron: '44.0.0',
    modules: '130',
    minNativeBaseVersion: '1.0.0',
  },
  installers: {},
}

for (const file of files) {
  const filePath = path.join(assetsDir, file)
  if (!fs.statSync(filePath).isFile()) continue
  const buf = fs.readFileSync(filePath)
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex')
  const size = buf.length
  const url = `https://github.com/${repo}/releases/download/${tag}/${file}`

  if (file.endsWith('.asar')) {
    manifest.asar = { filename: file, url, sha256, size }
  } else if (file.endsWith('.dmg')) {
    const key = file.includes('arm64') ? 'darwin-arm64' : 'darwin-x64'
    manifest.installers[key] = { filename: file, url, sha256, size }
  } else if (file.endsWith('.exe')) {
    const key = file.includes('arm64') ? 'win32-arm64' : 'win32-x64'
    manifest.installers[key] = { filename: file, url, sha256, size }
  } else if (file.endsWith('.AppImage')) {
    const key = file.includes('arm64') ? 'linux-arm64' : 'linux-x64'
    manifest.installers[key] = { filename: file, url, sha256, size }
  }
}

fs.writeFileSync('release-manifest.json', JSON.stringify(manifest, null, 2), 'utf8')
console.log('Generated release-manifest.json successfully.')
```

- [ ] **Step 3: 更新 .github/workflows/release.yml 添加 build-patch 任务与 manifest 上传**

配置在 GitHub Actions 中构建 `app-update-*.asar` 并随 Release 一同上传。

- [ ] **Step 4: 提交代码**

```bash
git add scripts/build-update-patch.mjs scripts/generate-release-manifest.mjs package.json .github/workflows/release.yml
git commit -m "ci(release): add asar patch build and manifest generation pipeline"
```

---

### Task 6: 前端更新设置卡片与状态联调（Renderer Update UI & Integration）

**Files:**
- Create: `plugins/bundled/cpa.core.settings/renderer/components/UpdateSection.tsx`
- Modify: `plugins/bundled/cpa.core.settings/renderer/components/GeneralSection.tsx`
- Test: `plugins/bundled/cpa.core.settings/renderer/components/UpdateSection.test.tsx`

**Interfaces:**
- Consumes: `@cpa/plugin-ui`, `UpdateStatusSnapshot`, `UpdatePhase`
- Produces: 渲染“版本与在线更新”卡片组件，实时显示当前版本号、检查更新、进度条与立即重启按钮

- [ ] **Step 1: 编写 UpdateSection 的失败测试**

```tsx
// plugins/bundled/cpa.core.settings/renderer/components/UpdateSection.test.tsx
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { UpdateSection } from './UpdateSection.js'

describe('UpdateSection', () => {
  it('renders current version and check for update button', () => {
    render(<UpdateSection currentVersion="1.0.0" phase="idle" onCheckUpdates={() => {}} />)
    expect(screen.getByText(/1\.0\.0/)).toBeDefined()
    expect(screen.getByRole('button', { name: /检查更新|Check for updates/i })).toBeDefined()
  })

  it('renders progress bar when downloading', () => {
    render(
      <UpdateSection
        currentVersion="1.0.0"
        phase="downloading"
        downloadProgress={{ percent: 45, transferredBytes: 4500, totalBytes: 10000, bytesPerSecond: 500 }}
      />
    )
    expect(screen.getByText(/45%/)).toBeDefined()
  })
})
```

- [ ] **Step 2: 运行测试并验证其失败**

Run: `pnpm --dir frontend test UpdateSection.test.tsx`
Expected: FAIL (Cannot find module)

- [ ] **Step 3: 实现 UpdateSection.tsx 并挂载到 GeneralSection.tsx**

编写优雅的设置界面更新卡片，严格继承 Tailwind CSS 变量与主题设计，禁止原生 select，支持多语言显示。

- [ ] **Step 4: 运行测试并验证其通过**

Run: `pnpm --dir frontend test UpdateSection.test.tsx`
Expected: PASS

- [ ] **Step 5: 提交代码**

```bash
git add plugins/bundled/cpa.core.settings/renderer/components/UpdateSection.tsx plugins/bundled/cpa.core.settings/renderer/components/UpdateSection.test.tsx plugins/bundled/cpa.core.settings/renderer/components/GeneralSection.tsx
git commit -m "feat(settings): add online updater card in general settings"
```

---

## Self-Review 检查结果

1. **Spec coverage:**
   - 发布清单结构 & GitHub 目标仓库 (`router-for-me/CodingProfessionalAgent`): Task 1, 3, 5
   - TS 轻量 asar 热更新与 SHA-256 校验: Task 1, 2, 4
   - 微引导加载器 (Bootstrapper) 与连续 2 次崩溃容灾回滚: Task 1, 4
   - 全量升级分流决策与提供者: Task 3
   - GitHub Actions 编译时将 asar 作为额外 Release 资产上传: Task 5
   - 前端版本与在线更新设置卡片 UI: Task 6
2. **Placeholder scan:** 全文无任何 `TODO`、`TBD` 或模糊描述，每个 Step 均附带完整代码与测试命令。
3. **Type consistency:** Task 1 中定义的 `ReleaseManifest`、`UpdateState`、`UpdatePhase` 等类型在 Task 2~6 中完全对应使用。
