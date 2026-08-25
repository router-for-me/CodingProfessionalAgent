import * as fs from 'node:fs/promises'
import { constants } from 'node:fs'
import * as path from 'node:path'
import {
    PluginError,
    PluginValidationError,
    type ResolvedPluginPackage,
} from '@cpa/plugin-api'

export interface PluginResourceResponse {
    contentType: string
    body: Buffer
    statusCode: number
    etag?: string
}

const MIME_TYPES: Record<string, string> = {
    '.js': 'text/javascript',
    '.mjs': 'text/javascript',
    '.cjs': 'text/javascript',
    '.json': 'application/json',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.otf': 'font/otf',
    '.wasm': 'application/wasm',
    '.map': 'application/json',
    '.html': 'text/html; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
}

export function detectMimeType(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase()
    return MIME_TYPES[ext] ?? 'application/octet-stream'
}

/**
 * Service managing access and boundary validation for plugin assets, chunks, and entries.
 */
export class PluginResourceService {
    private readonly packages = new Map<string, ResolvedPluginPackage>()
    private activeRevision?: string

    constructor(initialPackages?: Iterable<ResolvedPluginPackage>, revision?: string) {
        if (initialPackages) {
            this.setPackages(initialPackages, revision)
        } else if (revision) {
            this.activeRevision = revision
        }
    }

    /**
     * Get currently active graph revision if set.
     */
    getRevision(): string | undefined {
        return this.activeRevision
    }

    /**
     * Register a resolved plugin package for resource serving.
     */
    registerPackage(pkg: ResolvedPluginPackage): void {
        this.packages.set(pkg.manifest.id, pkg)
    }

    /**
     * Unregister a plugin package by ID.
     */
    unregisterPackage(packageId: string): void {
        this.packages.delete(packageId)
    }

    /**
     * Replace all registered packages and update active revision.
     */
    setPackages(packages: Iterable<ResolvedPluginPackage>, revision?: string): void {
        this.packages.clear()
        if (revision !== undefined) {
            this.activeRevision = revision
        }
        for (const pkg of packages) {
            this.packages.set(pkg.manifest.id, pkg)
        }
    }

    /**
     * Get a registered plugin package by key.
     */
    getPackage(packageKey: string): ResolvedPluginPackage | undefined {
        const decoded = decodeURIComponent(packageKey)
        return this.packages.get(decoded) ?? this.packages.get(packageKey)
    }

    /**
     * Resolves the canonical realpath of a plugin resource while strictly guarding source root boundaries.
     */
    async getResourcePath(packageKey: string, relativeResourcePath: string): Promise<string> {
        const pkg = this.getPackage(packageKey)
        if (!pkg) {
            throw new PluginError(`Plugin package '${packageKey}' not found`, {
                pluginId: packageKey,
            })
        }

        // Defensive normalization against raw / multi-encoded traversal
        let cleanRelPath = relativeResourcePath
        for (let i = 0; i < 5; i++) {
            try {
                const next = decodeURIComponent(cleanRelPath)
                if (next === cleanRelPath) break
                cleanRelPath = next
            } catch {
                break
            }
        }
        cleanRelPath = cleanRelPath.replace(/^(\/|\\)+/, '')

        const realSourceRoot = await fs.realpath(pkg.sourceRoot).catch(() => pkg.sourceRoot)

        // Logical boundary check before disk resolution
        const resolvedPath = path.resolve(realSourceRoot, cleanRelPath)
        const logicalRel = path.relative(realSourceRoot, resolvedPath)
        if (
            logicalRel === '..' ||
            logicalRel.startsWith(`..${path.sep}`) ||
            path.isAbsolute(logicalRel) ||
            cleanRelPath.includes(`..${path.sep}`) ||
            cleanRelPath.includes(`..${path.posix.sep}`) ||
            cleanRelPath === '..' ||
            relativeResourcePath.includes('..')
        ) {
            throw new PluginValidationError(
                `Plugin resource escapes source root: '${relativeResourcePath}' (resolved to '${resolvedPath}')`,
                [`Path escape violation: ${relativeResourcePath}`],
                { pluginId: pkg.manifest.id },
            )
        }

        // Real filesystem canonicalization to block symlink escapes
        let realTarget: string
        try {
            realTarget = await fs.realpath(resolvedPath)
        } catch (err: any) {
            if (err?.code === 'ENOENT') {
                throw new PluginError(
                    `Plugin resource not found: '${cleanRelPath}' in package '${pkg.manifest.id}'`,
                    { pluginId: pkg.manifest.id, cause: err },
                )
            }
            throw err
        }

        const realRel = path.relative(realSourceRoot, realTarget)
        if (
            realRel === '..' ||
            realRel.startsWith(`..${path.sep}`) ||
            path.isAbsolute(realRel)
        ) {
            throw new PluginValidationError(
                `Plugin resource escapes source root: '${relativeResourcePath}' (symlink escaped to '${realTarget}')`,
                [`Path escape violation: ${relativeResourcePath}`],
                { pluginId: pkg.manifest.id },
            )
        }

        const stat = await fs.stat(realTarget)
        if (!stat.isFile()) {
            throw new PluginError(
                `Plugin resource not found: '${cleanRelPath}' is not a file`,
                { pluginId: pkg.manifest.id },
            )
        }

        return realTarget
    }

    /**
     * Opens a FileHandle for reading. Can be overridden in tests to simulate race conditions.
     */
    protected async openFileHandle(filePath: string, flags: number): Promise<fs.FileHandle> {
        return fs.open(filePath, flags)
    }

    /**
     * Read a resource from a plugin package using secured FileHandles and race-swap protection.
     */
    async readResource(
        packageKey: string,
        relativeResourcePath: string,
        expectedRevision?: string,
    ): Promise<PluginResourceResponse> {
        // 1. Initial revision and package verification BEFORE open
        if (
            expectedRevision !== undefined &&
            this.activeRevision !== undefined &&
            expectedRevision !== this.activeRevision
        ) {
            throw new PluginError(
                `Plugin resource revision mismatch: expected '${expectedRevision}', active is '${this.activeRevision}'`,
                { pluginId: packageKey },
            )
        }

        const pkgBefore = this.getPackage(packageKey)
        if (!pkgBefore) {
            throw new PluginError(`Plugin package '${packageKey}' not found`, {
                pluginId: packageKey,
            })
        }

        const realPath = await this.getResourcePath(packageKey, relativeResourcePath)
        const preStat = await fs.stat(realPath)
        if (!preStat.isFile()) {
            throw new PluginError(
                `Plugin resource not found: '${relativeResourcePath}' is not a file`,
                { pluginId: pkgBefore.manifest.id },
            )
        }

        const openFlags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
        const fileHandle = await this.openFileHandle(realPath, openFlags)

        try {
            // 2. Re-verify revision and package registration AFTER open
            if (
                expectedRevision !== undefined &&
                this.activeRevision !== undefined &&
                expectedRevision !== this.activeRevision
            ) {
                throw new PluginError(
                    `Plugin resource revision invalidated during read: expected '${expectedRevision}', active is '${this.activeRevision}'`,
                    { pluginId: packageKey },
                )
            }

            const pkgAfter = this.getPackage(packageKey)
            if (!pkgAfter) {
                throw new PluginError(
                    `Plugin package '${packageKey}' unregistered or not found during read`,
                    { pluginId: packageKey },
                )
            }

            // 3. fstat dev/ino comparison to detect TOCTOU race / symlink swap
            const postStat = await fileHandle.stat()
            if (!postStat.isFile()) {
                throw new PluginError(
                    `Plugin resource not found: '${relativeResourcePath}' is not a file`,
                    { pluginId: pkgAfter.manifest.id },
                )
            }

            if (preStat.dev !== postStat.dev || preStat.ino !== postStat.ino) {
                throw new PluginValidationError(
                    `Detected file swap or symlink modification during read (dev/ino mismatch)`,
                    ['FileHandle stat mismatch'],
                    { pluginId: pkgAfter.manifest.id },
                )
            }

            const body = await fileHandle.readFile()
            const contentType = detectMimeType(realPath)

            return {
                contentType,
                body,
                statusCode: 200,
            }
        } finally {
            await fileHandle.close()
        }
    }
}
