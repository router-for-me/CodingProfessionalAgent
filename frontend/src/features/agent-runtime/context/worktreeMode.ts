import {
    isAbsolutePath,
    normalizeDirectoryCacheKey,
} from '@cpa/plugin-sdk'

export { isPathWithinDirectory } from '@cpa/plugin-sdk'

const CONTROL_CHARS = /[\u0000-\u001F\u007F]/

export interface WorktreeRunPolicy {
    readonly worktreePath: string
    readonly sourceTreePath: string
}

function assertAbsolutePolicyPath(value: string, label: string): string {
    if (typeof value !== 'string' || value.length === 0 || !isAbsolutePath(value)) {
        throw new Error(`${label} must be a non-empty absolute path`)
    }
    if (CONTROL_CHARS.test(value)) {
        throw new Error(`${label} is invalid: control characters are not allowed`)
    }
    return value
}

export function createWorktreeRunPolicy(
    input: WorktreeRunPolicy,
    projectCwd: string,
): WorktreeRunPolicy {
    const worktreePath = assertAbsolutePolicyPath(input.worktreePath, 'worktreePath')
    const sourceTreePath = assertAbsolutePolicyPath(input.sourceTreePath, 'sourceTreePath')
    const cwd = assertAbsolutePolicyPath(projectCwd, 'projectCwd')
    if (
        normalizeDirectoryCacheKey(worktreePath) !==
        normalizeDirectoryCacheKey(cwd)
    ) {
        throw new Error('worktreePath must match projectCwd in Git worktree mode')
    }
    return Object.freeze({ worktreePath, sourceTreePath })
}

export function recoverWorktreeRunPolicy(input: {
    worktreePath?: string
    sourceTreePath?: string
    projectPaths: readonly string[]
}): {
    policy: WorktreeRunPolicy
    sourceTreePathRecovered: boolean
} {
    const worktreePath = input.worktreePath?.trim()
    if (!worktreePath) {
        throw new Error('Persisted Git worktree session is missing worktreePath')
    }
    const persistedSourceTreePath = input.sourceTreePath?.trim()
    const sourceTreePath = persistedSourceTreePath || input.projectPaths[0]?.trim()
    if (!sourceTreePath) {
        throw new Error('Persisted Git worktree session is missing sourceTreePath')
    }
    return {
        policy: createWorktreeRunPolicy({ worktreePath, sourceTreePath }, worktreePath),
        sourceTreePathRecovered: !persistedSourceTreePath,
    }
}

export function formatWorktreeModePrompt(policy: WorktreeRunPolicy): string {
    const worktreePath = assertAbsolutePolicyPath(
        policy.worktreePath,
        'worktreePath',
    ).replace(/\\/g, '/')
    const sourceTreePath = assertAbsolutePolicyPath(
        policy.sourceTreePath,
        'sourceTreePath',
    ).replace(/\\/g, '/')

    return [
        '<worktree_mode>',
        'Git worktree mode is active.',
        `Worktree directory: ${worktreePath}`,
        `Original source tree: ${sourceTreePath}`,
        'All relative paths resolve from the worktree directory.',
        'Relative file reads must stay within the worktree directory.',
        'All file modifications must stay within the worktree directory.',
        'The original source tree is read-only. Read it only by passing an absolute path to read or a shell command.',
        'Never use .. or symbolic links to escape the worktree directory.',
        'Do not use bash or pwsh to modify the original source tree or any path outside the worktree directory.',
        '</worktree_mode>',
    ].join('\n')
}
