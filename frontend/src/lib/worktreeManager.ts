/**
 * Worktree manager for creating and managing Git worktrees.
 */

import { createId } from '@/lib/id'
import {
    runGitViaNativeBridge,
    type GitCommandRunner,
} from '@/lib/gitBranches'
import {
    resolveWorktreeRootDir,
    type WorktreeFsBridge,
} from '@/lib/worktrees'
import { getHostBridge } from '@/application/services/hostTransport'

export interface CreateWorktreeOptions {
    sourceTreePath: string
    branch?: string | null
    branchPrefix?: string | null
    worktreeRootDir?: string
    fetchUpstream?: boolean
    fsBridge?: WorktreeFsBridge
    gitRunner?: GitCommandRunner
    onProgress?: (step: 'preparing' | 'checking_out' | 'done', message?: string) => void
}

export interface CreateWorktreeResult {
    worktreePath: string
    branch: string
    isNewBranch: boolean
}

/** Sanitize a string to be a valid path/folder segment. */
export function sanitizeFolderName(name: string): string {
    return name
        .replace(/[/\\?%*:|"<>]/g, '-')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
}

/** Normalize branch prefix ensuring it ends with a slash. */
export function normalizeBranchPrefix(prefix?: string | null): string {
    const trimmed = (prefix ?? 'cpa/').trim()
    if (!trimmed) return 'cpa/'
    return trimmed.endsWith('/') ? trimmed : `${trimmed}/`
}

/**
 * Create a new Git worktree under the configured worktree root directory.
 */
export async function createWorktreeForProject(
    options: CreateWorktreeOptions,
): Promise<CreateWorktreeResult> {
    const {
        sourceTreePath,
        branch: requestedBranch,
        branchPrefix = 'cpa/',
        worktreeRootDir: configuredRootDir,
        fetchUpstream = true,
        gitRunner = runGitViaNativeBridge,
        onProgress,
    } = options

    if (!sourceTreePath || !sourceTreePath.trim()) {
        throw new Error('sourceTreePath is required to create a worktree')
    }

    onProgress?.('preparing', 'Preparing workspace')

    // 1. Resolve worktree root directory
    const resolvedRootDir = await resolveWorktreeRootDir(configuredRootDir)

    // Ensure root directory exists
    const bridge = getHostBridge()
    if (bridge?.MkdirAll) {
        try {
            await bridge.MkdirAll(resolvedRootDir)
        } catch {
            // Ignore if directory already exists
        }
    }

    // 2. Derive unique folder name
    const sourceParts = sourceTreePath.split(/[/\\]/).filter(Boolean)
    const projectName = sanitizeFolderName(sourceParts[sourceParts.length - 1] || 'project')
    const shortId = createId().slice(0, 8)
    const branchSegment = requestedBranch ? sanitizeFolderName(requestedBranch) : 'wt'
    const folderName = `${projectName}-${branchSegment}-${shortId}`

    const sep = resolvedRootDir.includes('\\') ? '\\' : '/'
    const worktreePath = resolvedRootDir.endsWith('/') || resolvedRootDir.endsWith('\\')
        ? `${resolvedRootDir}${folderName}`
        : `${resolvedRootDir}${sep}${folderName}`

    onProgress?.('checking_out', 'Checking out files')

    // 3. Optional upstream fetch before checkout
    if (fetchUpstream) {
        try {
            await gitRunner(sourceTreePath, ['fetch', '--all'])
        } catch {
            // Best-effort fetch; continue even if offline or no remote
        }
    }

    // 4. Create git worktree
    const normalizedPrefix = normalizeBranchPrefix(branchPrefix)
    let targetBranch = requestedBranch?.trim() || ''
    let isNewBranch = false

    if (targetBranch) {
        // Try checking out the existing branch first
        const addResult = await gitRunner(sourceTreePath, [
            'worktree',
            'add',
            worktreePath,
            targetBranch,
        ])

        if (addResult.exitCode === 0) {
            isNewBranch = false
        } else {
            // If checking out existing branch failed:
            // 1. If it's a new custom branch name, try creating it with -b
            const addWithBranchResult = await gitRunner(sourceTreePath, [
                'worktree',
                'add',
                '-b',
                targetBranch,
                worktreePath,
            ])

            if (addWithBranchResult.exitCode === 0) {
                isNewBranch = true
            } else {
                // 2. targetBranch exists and is already checked out elsewhere (e.g. main/dev)
                // Create a new branch using configured branchPrefix based on targetBranch
                const newBranchName = `${normalizedPrefix}${shortId}`
                const addWithPrefixResult = await gitRunner(sourceTreePath, [
                    'worktree',
                    'add',
                    '-b',
                    newBranchName,
                    worktreePath,
                    targetBranch,
                ])

                if (addWithPrefixResult.exitCode === 0) {
                    targetBranch = newBranchName
                    isNewBranch = true
                } else {
                    // Fallback to detached worktree if all branch creation fails
                    const fallbackResult = await gitRunner(sourceTreePath, [
                        'worktree',
                        'add',
                        '--detach',
                        worktreePath,
                        targetBranch,
                    ])
                    if (fallbackResult.exitCode !== 0) {
                        throw new Error(
                            `Failed to create worktree: ${addWithPrefixResult.stderr || addWithBranchResult.stderr || addResult.stderr || fallbackResult.stderr}`,
                        )
                    }
                }
            }
        }
    } else {
        // No branch specified: generate a new branch with configured branchPrefix
        targetBranch = `${normalizedPrefix}${shortId}`
        const addResult = await gitRunner(sourceTreePath, [
            'worktree',
            'add',
            '-b',
            targetBranch,
            worktreePath,
        ])

        if (addResult.exitCode === 0) {
            isNewBranch = true
        } else {
            // Fallback to detached worktree
            const detachedResult = await gitRunner(sourceTreePath, [
                'worktree',
                'add',
                '--detach',
                worktreePath,
            ])
            if (detachedResult.exitCode !== 0) {
                throw new Error(
                    `Failed to create worktree: ${addResult.stderr || detachedResult.stderr}`,
                )
            }
        }
    }

    onProgress?.('done', 'Worktree checkout complete')

    return {
        worktreePath,
        branch: targetBranch,
        isNewBranch,
    }
}
