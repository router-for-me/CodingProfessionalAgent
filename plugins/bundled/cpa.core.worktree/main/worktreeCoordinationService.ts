import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { spawn } from 'node:child_process'
import type {
    DiscoveredWorktree,
    WorktreeDeleteResult,
    WorktreeSetupInput,
    WorktreeSetupResult,
} from '@cpa/plugin-api'

export class WorktreeCoordinationService {
    private readonly emitEvent?: (event: any, rpcCtx?: any) => void

    constructor(emitEvent?: (event: any, rpcCtx?: any) => void) {
        this.emitEvent = emitEvent
    }

    resolveRootDir(configuredRootDir?: string): string {
        const trimmed = configuredRootDir?.trim()
        const homeDir = os.homedir()

        if (trimmed) {
            if (trimmed.startsWith('~')) {
                return trimmed.replace(/^~(?=$|\/|\\)/, homeDir)
            }
            return trimmed
        }

        return path.join(homeDir, '.coding-professional-agent', 'worktrees')
    }

    async listWorktrees(rootDir?: string): Promise<DiscoveredWorktree[]> {
        const resolvedDir = this.resolveRootDir(rootDir)
        if (!fs.existsSync(resolvedDir)) {
            return []
        }

        const entries = await fs.promises.readdir(resolvedDir, { withFileTypes: true }).catch(() => [])
        const results: DiscoveredWorktree[] = []

        for (const entry of entries) {
            if (!entry.isDirectory()) continue

            const wtPath = path.join(resolvedDir, entry.name)
            const gitFilePath = path.join(wtPath, '.git')

            if (!fs.existsSync(gitFilePath)) continue

            let gitFileContent = ''
            try {
                gitFileContent = await fs.promises.readFile(gitFilePath, 'utf8')
            } catch {
                continue
            }

            if (!gitFileContent.trim().startsWith('gitdir:')) continue

            let gitDirPath = gitFileContent.replace(/^gitdir:\s*/, '').trim()
            if (!path.isAbsolute(gitDirPath)) {
                gitDirPath = path.resolve(wtPath, gitDirPath)
            }

            let branch: string | undefined
            let headSha: string | undefined
            let mainRepoPath: string | undefined
            let mainRepo: string | undefined

            const headPath = path.join(gitDirPath, 'HEAD')
            if (fs.existsSync(headPath)) {
                try {
                    const headContent = (await fs.promises.readFile(headPath, 'utf8')).trim()
                    if (headContent.startsWith('ref:')) {
                        branch = headContent.replace(/^ref:\s*/, '').replace(/^refs\/heads\//, '')
                    } else {
                        headSha = headContent.slice(0, 8)
                    }
                } catch {
                    // Ignore
                }
            }

            const commondirPath = path.join(gitDirPath, 'commondir')
            if (fs.existsSync(commondirPath)) {
                try {
                    const commondirContent = (await fs.promises.readFile(commondirPath, 'utf8')).trim()
                    let fullCommonDir = commondirContent
                    if (!path.isAbsolute(fullCommonDir)) {
                        fullCommonDir = path.resolve(gitDirPath, commondirContent)
                    }
                    mainRepoPath = fullCommonDir.replace(/[/\\]\.git[/\\]?$/, '')
                    mainRepo = path.basename(mainRepoPath)
                } catch {
                    // Ignore
                }
            }

            results.push({
                name: entry.name,
                path: wtPath,
                branch,
                headSha,
                mainRepo,
                mainRepoPath,
                gitDir: gitDirPath,
                isGitWorktree: true,
            })
        }

        return results
    }

    async deleteWorktree(
        worktreePath: string,
        mainRepoPath?: string,
    ): Promise<WorktreeDeleteResult> {
        if (mainRepoPath && fs.existsSync(mainRepoPath)) {
            try {
                await this.runCommand('git', ['worktree', 'remove', '--force', worktreePath], mainRepoPath)
            } catch {
                // If git worktree remove fails, fallback to directory removal
            }
        }

        if (fs.existsSync(worktreePath)) {
            try {
                await fs.promises.rm(worktreePath, { recursive: true, force: true })
            } catch (err) {
                return {
                    ok: false,
                    error: err instanceof Error ? err.message : String(err),
                }
            }
        }

        return { ok: true }
    }

    async setup(
        input: WorktreeSetupInput,
        rpcCtx?: any,
    ): Promise<WorktreeSetupResult> {
        const {
            sourceTreePath,
            worktreePath: customWorktreePath,
            branch: requestedBranch,
            branchPrefix = 'cpa/',
            worktreeRootDir,
            fetchUpstream = false,
            onProgress,
            onLog,
        } = input

        if (!sourceTreePath || !fs.existsSync(sourceTreePath)) {
            return { ok: false, error: `Source tree path not found: ${sourceTreePath}` }
        }

        const reportStep = (step: 'preparing' | 'checking_out' | 'setting_up' | 'ready' | 'error') => {
            onProgress?.(step)
            this.emitEvent?.({ kind: 'worktree:progress', sessionId: input.sessionId, step }, rpcCtx)
        }

        const reportLog = (chunk: string) => {
            onLog?.(chunk)
            this.emitEvent?.({ kind: 'worktree:log', sessionId: input.sessionId, chunk }, rpcCtx)
        }

        reportStep('preparing')

        if (fetchUpstream) {
            try {
                reportLog('Fetching upstream updates...\n')
                await this.runCommand('git', ['fetch', '--all'], sourceTreePath)
            } catch (err) {
                reportLog(`Fetch upstream warning: ${err instanceof Error ? err.message : String(err)}\n`)
            }
        }

        const targetDir = customWorktreePath ?? path.join(
            this.resolveRootDir(worktreeRootDir),
            `wt-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        )

        const branch = requestedBranch || `${branchPrefix}session-${Date.now()}`

        reportStep('checking_out')
        try {
            await fs.promises.mkdir(path.dirname(targetDir), { recursive: true })
            reportLog(`Creating git worktree at ${targetDir} with branch ${branch}...\n`)
            await this.runCommand(
                'git',
                ['worktree', 'add', '-b', branch, targetDir],
                sourceTreePath,
            )
        } catch (err) {
            reportStep('error')
            const error = err instanceof Error ? err.message : String(err)
            return { ok: false, error, worktreePath: targetDir, branch }
        }

        reportStep('ready')
        return { ok: true, worktreePath: targetDir, branch }
    }

    private runCommand(
        command: string,
        args: readonly string[],
        cwd: string,
    ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
        return new Promise((resolve, reject) => {
            const child = spawn(command, args as string[], {
                cwd,
                stdio: ['ignore', 'pipe', 'pipe'],
                shell: false,
            })

            let stdout = ''
            let stderr = ''

            child.stdout?.on('data', (d) => {
                stdout += d.toString()
            })
            child.stderr?.on('data', (d) => {
                stderr += d.toString()
            })

            child.on('error', (err) => {
                reject(err)
            })

            child.on('close', (code) => {
                if (code === 0) {
                    resolve({ exitCode: 0, stdout, stderr })
                } else {
                    reject(new Error(`Command ${command} exited with code ${code}: ${stderr}`))
                }
            })
        })
    }

    dispose(): void {
        // No persistent resources to close
    }
}
