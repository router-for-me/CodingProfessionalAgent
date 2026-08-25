import type { NativeBridge } from './types.js'
import {
    dirnamePath,
    isAbsolutePath,
    isMissingPathError,
    isPathWithinDirectory,
} from './path.js'

type RealPathBridge = Pick<NativeBridge, 'realPath'>

export interface WorktreeRunPolicy {
    enabled?: boolean
    worktreePath: string
    [key: string]: unknown
}

export interface WorktreeFileBoundary {
    readonly worktreePath: string
    readonly realWorktreePath: string
}

export async function createWorktreeFileBoundary(
    policy: WorktreeRunPolicy,
    bridge: RealPathBridge,
): Promise<WorktreeFileBoundary> {
    const realWorktreePath = await bridge.realPath(policy.worktreePath)
    return Object.freeze({
        worktreePath: policy.worktreePath,
        realWorktreePath,
    })
}

function throwRelativeReadError(boundary: WorktreeFileBoundary): never {
    throw new Error(
        `Relative read paths must stay within the active Git worktree: ${boundary.worktreePath}`,
    )
}

function throwModificationError(boundary: WorktreeFileBoundary): never {
    throw new Error(
        `File modifications must stay within the active Git worktree: ${boundary.worktreePath}`,
    )
}

async function nearestExistingRealPath(
    path: string,
    bridge: RealPathBridge,
): Promise<string> {
    let current = path
    while (true) {
        try {
            return await bridge.realPath(current)
        } catch (error) {
            if (!isMissingPathError(error)) {
                throw error
            }
            const parent = dirnamePath(current)
            if (parent === current) {
                throw error
            }
            current = parent
        }
    }
}

export async function assertRelativeReadWithinWorktree(input: {
    requestedPath: string
    resolvedPath: string
    boundary: WorktreeFileBoundary
    bridge: RealPathBridge
}): Promise<void> {
    if (isAbsolutePath(input.requestedPath)) {
        return
    }
    if (!isPathWithinDirectory(input.resolvedPath, input.boundary.worktreePath)) {
        throwRelativeReadError(input.boundary)
    }
    const realTargetPath = await input.bridge.realPath(input.resolvedPath)
    if (!isPathWithinDirectory(realTargetPath, input.boundary.realWorktreePath)) {
        throwRelativeReadError(input.boundary)
    }
}

export async function assertModificationWithinWorktree(input: {
    resolvedPath: string
    boundary: WorktreeFileBoundary
    bridge: RealPathBridge
}): Promise<void> {
    if (!isPathWithinDirectory(input.resolvedPath, input.boundary.worktreePath)) {
        throwModificationError(input.boundary)
    }
    const realTargetOrParent = await nearestExistingRealPath(
        input.resolvedPath,
        input.bridge,
    )
    if (!isPathWithinDirectory(
        realTargetOrParent,
        input.boundary.realWorktreePath,
    )) {
        throwModificationError(input.boundary)
    }
}
