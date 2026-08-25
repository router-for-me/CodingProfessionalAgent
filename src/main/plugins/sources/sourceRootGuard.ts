import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { PluginValidationError, type PluginEntryKind } from '@cpa/plugin-api'

/**
 * Validates that a target path (relative or absolute) resolves strictly within the canonical source root.
 * Resolves symlinks using realpath to prevent directory traversal and symlink escapes.
 *
 * @param targetPath The relative or absolute path to check
 * @param sourceRoot The base source root directory of the plugin
 * @returns The resolved canonical realpath of the target
 * @throws PluginValidationError if the target resolves outside the source root or does not exist
 */
export async function assertPathInsideSourceRoot(
    targetPath: string,
    sourceRoot: string,
): Promise<string> {
    let realSourceRoot: string
    try {
        realSourceRoot = await fs.realpath(sourceRoot)
    } catch (err) {
        throw new PluginValidationError(
            `Plugin source root does not exist or is inaccessible: ${sourceRoot}`,
            [String(err)],
        )
    }

    const resolvedTarget = path.isAbsolute(targetPath)
        ? path.resolve(targetPath)
        : path.resolve(realSourceRoot, targetPath)

    let realTarget: string
    try {
        realTarget = await fs.realpath(resolvedTarget)
    } catch (err) {
        throw new PluginValidationError(
            `Plugin entry or resource path does not exist: ${targetPath}`,
            [String(err)],
        )
    }

    const rel = path.relative(realSourceRoot, realTarget)
    if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
        throw new PluginValidationError(
            `Plugin entry or resource path '${targetPath}' escapes canonical source root '${realSourceRoot}' (resolved to '${realTarget}')`,
            [`Path escape violation: ${targetPath}`],
        )
    }

    return realTarget
}

/**
 * Checks whether a target path is inside the canonical source root without throwing.
 */
export async function isPathInsideSourceRoot(
    targetPath: string,
    sourceRoot: string,
): Promise<boolean> {
    try {
        await assertPathInsideSourceRoot(targetPath, sourceRoot)
        return true
    } catch {
        return false
    }
}

/**
 * Validates and canonicalizes plugin manifest runtime entries.
 * Ensures every declared entry exists and resides strictly within the plugin source root.
 */
export async function validatePluginEntries(
    sourceRoot: string,
    entries: Partial<Record<PluginEntryKind, string>>,
): Promise<Partial<Record<PluginEntryKind, string>>> {
    const validated: Partial<Record<PluginEntryKind, string>> = {}

    for (const [kind, entryRelPath] of Object.entries(entries)) {
        if (!entryRelPath || typeof entryRelPath !== 'string') {
            continue
        }
        const realEntryPath = await assertPathInsideSourceRoot(entryRelPath, sourceRoot)
        const stat = await fs.stat(realEntryPath)
        if (!stat.isFile()) {
            throw new PluginValidationError(
                `Plugin entry '${kind}' at '${entryRelPath}' is not a regular file`,
                [`Entry '${kind}' is not a file`],
            )
        }
        validated[kind as PluginEntryKind] = realEntryPath
    }

    return validated
}
