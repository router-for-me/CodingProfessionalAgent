import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { createHash } from 'node:crypto'
import type pacote from 'pacote'
import { PluginError } from '@cpa/plugin-api'
import {
    PluginPackageLock,
    type ManagedNpmPackage,
    type PluginPackageLockEntry,
} from './PluginPackageLock.js'

export type { ManagedNpmPackage }

export interface ManagedNpmInstallerOptions {
    pluginsDir: string
    lockfilePath?: string
    npmDir?: string
    registry?: string
    offline?: boolean
    fetchManifest?: (spec: string, opts?: Record<string, unknown>) => Promise<any>
    extractPackage?: (spec: string, dest: string, opts?: Record<string, unknown>) => Promise<any>
}

export interface ParsedNpmSpec {
    rawSpec: string
    normalizedSpec: `npm:${string}`
    name: string
    range: string
    pacoteSpec: string
}

export interface ParseNpmSpecOptions {
    strictExact?: boolean
}

const EXACT_SEMVER_REGEX = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

/**
 * Checks whether a given version string is an exact semver (e.g. "1.2.3" or "1.2.3-alpha.1").
 */
export function isExactSemver(version: string): boolean {
    return EXACT_SEMVER_REGEX.test(version.trim())
}

/**
 * Escapes scoped and unscoped npm package names for filesystem directory safety.
 * e.g. '@example/cpa-plugin' -> '@example+cpa-plugin'
 */
export function escapePackageName(name: string): string {
    return name.replace(/\//g, '+')
}

/**
 * Computes a deterministic SHA-256 content digest for a directory and all its files.
 */
export async function computeDirectoryContentDigest(dirPath: string): Promise<string> {
    const files: Array<{ relativePath: string; hash: string }> = []

    async function walk(currentDir: string, relativeDir: string): Promise<void> {
        let entries
        try {
            entries = await fs.readdir(currentDir, { withFileTypes: true })
        } catch {
            return
        }

        for (const entry of entries) {
            const fullPath = path.join(currentDir, entry.name)
            const relPath = relativeDir ? path.join(relativeDir, entry.name) : entry.name
            if (entry.isDirectory()) {
                await walk(fullPath, relPath)
            } else if (entry.isFile()) {
                try {
                    const content = await fs.readFile(fullPath)
                    const fileHash = createHash('sha256').update(content).digest('hex')
                    files.push({ relativePath: relPath, hash: fileHash })
                } catch {
                    // Ignore unreadable file during digest
                }
            }
        }
    }

    await walk(dirPath, '')
    files.sort((a, b) => a.relativePath.localeCompare(b.relativePath))

    const overallHash = createHash('sha256')
    for (const f of files) {
        overallHash.update(`${f.relativePath}:${f.hash}\n`)
    }
    return overallHash.digest('hex')
}

/**
 * Validates extracted package structure, manifest presence, and ensures no entry paths
 * violate source root boundaries.
 */
export async function validateExtractedPackage(packageRoot: string): Promise<void> {
    let manifestData: any
    const manifestPath = path.join(packageRoot, 'manifest.json')
    const packageJsonPath = path.join(packageRoot, 'package.json')

    try {
        const content = await fs.readFile(manifestPath, 'utf-8')
        manifestData = JSON.parse(content)
    } catch {
        try {
            const pkgJsonContent = await fs.readFile(packageJsonPath, 'utf-8')
            const parsedPkgJson = JSON.parse(pkgJsonContent)
            manifestData = parsedPkgJson.cpa || parsedPkgJson
        } catch (err: any) {
            throw new PluginError(
                `Managed npm package is missing valid manifest.json or package.json at '${packageRoot}'`,
                { cause: err },
            )
        }
    }

    if (!manifestData || typeof manifestData !== 'object') {
        throw new PluginError(
            `Managed npm package contains invalid manifest at '${packageRoot}'`,
        )
    }

    const entries = manifestData.entries
    if (entries && typeof entries === 'object') {
        const normalizedRoot = path.resolve(packageRoot)
        for (const [key, entryPath] of Object.entries(entries)) {
            if (typeof entryPath === 'string') {
                const resolvedEntry = path.resolve(packageRoot, entryPath)
                if (
                    resolvedEntry !== normalizedRoot &&
                    !resolvedEntry.startsWith(normalizedRoot + path.sep)
                ) {
                    throw new PluginError(
                        `Source guard violation in entry '${key}' ('${entryPath}'): resolves outside package root '${packageRoot}'`,
                    )
                }
            }
        }
    }
}

/**
 * Parse an npm plugin specifier like 'npm:@example/plugin@1.2.0' into its components.
 * Rejects invalid protocols (git, file, http) and enforces exact semver in strict mode.
 */
export function parseNpmSpec(
    spec: string,
    options?: ParseNpmSpecOptions,
): ParsedNpmSpec {
    const raw = spec.trim()
    if (
        raw.includes('git:') ||
        raw.includes('file:') ||
        raw.includes('http:') ||
        raw.includes('https:') ||
        raw.includes('git+') ||
        raw.includes('://')
    ) {
        throw new PluginError(`Invalid npm package specifier with unsupported scheme/url: '${spec}'`)
    }

    const withoutPrefix = raw.startsWith('npm:') ? raw.slice(4).trim() : raw

    let name = ''
    let range = 'latest'

    if (withoutPrefix.startsWith('@')) {
        // Scoped package: @scope/name or @scope/name@range
        const slashIdx = withoutPrefix.indexOf('/')
        if (slashIdx === -1) {
            throw new PluginError(`Invalid npm package specifier: '${spec}'`)
        }
        const atAfterSlash = withoutPrefix.indexOf('@', slashIdx + 1)
        if (atAfterSlash !== -1) {
            name = withoutPrefix.slice(0, atAfterSlash)
            range = withoutPrefix.slice(atAfterSlash + 1) || 'latest'
        } else {
            name = withoutPrefix
            range = 'latest'
        }
    } else {
        // Unscoped package: name or name@range
        const atIdx = withoutPrefix.indexOf('@')
        if (atIdx !== -1) {
            name = withoutPrefix.slice(0, atIdx)
            range = withoutPrefix.slice(atIdx + 1) || 'latest'
        } else {
            name = withoutPrefix
            range = 'latest'
        }
    }

    if (!name) {
        throw new PluginError(`Invalid npm package specifier: '${spec}'`)
    }

    if (options?.strictExact) {
        if (!range || range === 'latest' || !isExactSemver(range)) {
            throw new PluginError(
                `Invalid npm package version '${range}' in '${spec}': only exact semver is allowed in strict mode`,
            )
        }
    }

    const pacoteSpec = range ? `${name}@${range}` : name
    const normalizedSpec: `npm:${string}` =
        range && range !== 'latest' ? `npm:${name}@${range}` : `npm:${name}`

    return {
        rawSpec: spec,
        normalizedSpec,
        name,
        range,
        pacoteSpec,
    }
}

async function getPacote(): Promise<typeof pacote> {
    const mod = await import('pacote')
    return (mod as any).default ?? mod
}

export class ManagedNpmInstaller {
    readonly pluginsDir: string
    readonly lockfilePath: string
    readonly npmDir: string
    readonly registry?: string
    readonly offline: boolean
    private readonly fetchManifest: (spec: string, opts?: Record<string, unknown>) => Promise<any>
    private readonly extractPackage: (
        spec: string,
        dest: string,
        opts?: Record<string, unknown>,
    ) => Promise<any>

    private readonly specInFlight = new Map<string, Promise<ManagedNpmPackage>>()
    private readonly exactInFlight = new Map<string, Promise<ManagedNpmPackage>>()

    constructor(options: ManagedNpmInstallerOptions) {
        this.pluginsDir = options.pluginsDir
        this.lockfilePath =
            options.lockfilePath ?? path.join(options.pluginsDir, 'plugin-lock.json')
        this.npmDir = options.npmDir ?? path.join(options.pluginsDir, 'npm')
        this.registry = options.registry
        this.offline = options.offline ?? false
        this.fetchManifest =
            options.fetchManifest ??
            (async (spec: string, opts?: Record<string, unknown>) => {
                const p = await getPacote()
                return p.manifest(spec, opts as any)
            })
        this.extractPackage =
            options.extractPackage ??
            (async (spec: string, dest: string, opts?: Record<string, unknown>) => {
                const p = await getPacote()
                return p.extract(spec, dest, opts as any)
            })
    }

    /**
     * Install or resolve a managed npm plugin package.
     * Guarantees that install scripts are never executed (`runScripts: false`),
     * validates subresource integrity, verifies content digests, and records resolution to `plugin-lock.json`.
     */
    async install(
        spec: `npm:${string}` | string,
        options?: { strictExact?: boolean },
    ): Promise<ManagedNpmPackage> {
        const parsed = parseNpmSpec(spec, options)
        const inFlightKey = parsed.normalizedSpec

        const existingPromise = this.specInFlight.get(inFlightKey)
        if (existingPromise) {
            return existingPromise
        }

        const runPromise = this._installInternal(spec, parsed)
        this.specInFlight.set(inFlightKey, runPromise)
        try {
            return await runPromise
        } finally {
            this.specInFlight.delete(inFlightKey)
        }
    }

    private async _installInternal(
        spec: `npm:${string}` | string,
        parsed: ParsedNpmSpec,
    ): Promise<ManagedNpmPackage> {
        const lock = new PluginPackageLock(this.lockfilePath)

        let lockFile
        try {
            lockFile = await lock.load()
        } catch (err) {
            if (this.offline) {
                throw err
            }
            lockFile = { version: 1 as const, packages: {} }
        }

        const lockedEntry: PluginPackageLockEntry | undefined =
            lockFile.packages[spec] ?? lockFile.packages[parsed.normalizedSpec]

        // Check if cached package directory exists on disk and matches lockfile.
        // Early cache short-circuit is only allowed when an exact semver was requested
        // or when running in offline mode. If no exact version was specified (e.g. 'latest')
        // and online, query the registry to resolve the latest version.
        const canUseEarlyCache = this.offline || isExactSemver(parsed.range)
        if (canUseEarlyCache && lockedEntry && lockedEntry.packageRoot) {
            try {
                const stat = await fs.stat(lockedEntry.packageRoot)
                if (stat.isDirectory()) {
                    // Re-verify content digest for tamper resistance
                    if (lockedEntry.contentDigest) {
                        const currentDigest = await computeDirectoryContentDigest(
                            lockedEntry.packageRoot,
                        )
                        if (currentDigest !== lockedEntry.contentDigest) {
                            throw new PluginError(
                                `Tampered package detected: content digest mismatch for '${spec}' at '${lockedEntry.packageRoot}'`,
                            )
                        }
                    }

                    // Cache hit - if in offline mode, verify integrity is present
                    if (this.offline && !lockedEntry.integrity) {
                        throw new PluginError(
                            `Cannot install npm package '${spec}' in offline mode: missing locked integrity`,
                        )
                    }

                    return {
                        name: parsed.name,
                        version: lockedEntry.resolvedVersion,
                        integrity: lockedEntry.integrity,
                        packageRoot: lockedEntry.packageRoot,
                        contentDigest: lockedEntry.contentDigest,
                    }
                }
            } catch (statErr: any) {
                if (statErr instanceof PluginError) {
                    throw statErr
                }
                if (this.offline) {
                    throw new PluginError(
                        `Cannot install npm package '${spec}' in offline mode: package directory '${lockedEntry.packageRoot}' not found on disk`,
                        { cause: statErr },
                    )
                }
            }
        }

        if (this.offline) {
            throw new PluginError(
                `Cannot install npm package '${spec}' in offline mode: package not found in cache or lockfile`,
            )
        }

        // Fetch manifest from npm registry
        let manifest: any
        try {
            manifest = await this.fetchManifest(parsed.pacoteSpec, {
                registry: this.registry,
            })
        } catch (err: any) {
            throw new PluginError(
                `Failed to fetch manifest for npm package '${spec}': ${err.message}`,
                { cause: err },
            )
        }

        const resolvedName = manifest.name || parsed.name
        const resolvedVersion = manifest.version

        if (!resolvedVersion || !isExactSemver(resolvedVersion)) {
            throw new PluginError(
                `Invalid resolved package version '${resolvedVersion}' for '${spec}': exact semver required`,
            )
        }

        const exactKey = `${resolvedName}@${resolvedVersion}`
        const exactInFlightPromise = this.exactInFlight.get(exactKey)
        if (exactInFlightPromise) {
            return exactInFlightPromise
        }

        const exactPromise = this._extractAndLock(
            spec,
            parsed,
            lock,
            lockedEntry,
            manifest,
            resolvedName,
            resolvedVersion,
        )
        this.exactInFlight.set(exactKey, exactPromise)
        try {
            return await exactPromise
        } finally {
            this.exactInFlight.delete(exactKey)
        }
    }

    private async _extractAndLock(
        spec: `npm:${string}` | string,
        parsed: ParsedNpmSpec,
        lock: PluginPackageLock,
        lockedEntry: PluginPackageLockEntry | undefined,
        manifest: any,
        resolvedName: string,
        resolvedVersion: string,
    ): Promise<ManagedNpmPackage> {
        const integrity = manifest._integrity || manifest.dist?.integrity || ''
        const targetPackageRoot = path.join(
            this.npmDir,
            escapePackageName(resolvedName),
            resolvedVersion,
        )

        // Check if target directory already exists and is intact
        let needsExtract = true
        let contentDigest =
            lockedEntry?.resolvedVersion === resolvedVersion
                ? lockedEntry.contentDigest || ''
                : ''

        try {
            const stat = await fs.stat(targetPackageRoot)
            if (stat.isDirectory()) {
                if (contentDigest) {
                    const currentDigest = await computeDirectoryContentDigest(targetPackageRoot)
                    if (currentDigest === contentDigest) {
                        needsExtract = false
                    }
                } else {
                    needsExtract = false
                }
            }
        } catch {
            needsExtract = true
        }

        if (needsExtract) {
            await fs.mkdir(this.npmDir, { recursive: true })
            const tempExtractDir = path.join(
                this.npmDir,
                `.tmp-${escapePackageName(resolvedName)}-${resolvedVersion}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            )
            await fs.mkdir(tempExtractDir, { recursive: true })

            const resolvedSpec = `${resolvedName}@${resolvedVersion}`
            try {
                await this.extractPackage(resolvedSpec, tempExtractDir, {
                    runScripts: false,
                    integrity: integrity || undefined,
                    registry: this.registry,
                })

                // Validate structure & source root guard
                await validateExtractedPackage(tempExtractDir)

                // Compute deterministic content digest
                contentDigest = await computeDirectoryContentDigest(tempExtractDir)

                // Atomically move from temp to final destination
                const finalParentDir = path.dirname(targetPackageRoot)
                await fs.mkdir(finalParentDir, { recursive: true })
                await fs.rm(targetPackageRoot, { recursive: true, force: true }).catch(() => {})
                await fs.rename(tempExtractDir, targetPackageRoot)
            } catch (err: any) {
                // Atomic cleanup on failure
                try {
                    await fs.rm(tempExtractDir, { recursive: true, force: true })
                } catch {
                    // Ignore cleanup error
                }
                throw err instanceof PluginError
                    ? err
                    : new PluginError(
                          `Failed to extract npm package '${resolvedSpec}': ${err.message}`,
                          { cause: err },
                      )
            }
        } else if (!contentDigest) {
            contentDigest = await computeDirectoryContentDigest(targetPackageRoot)
        }

        // Record resolution in lockfile safely under transaction
        const lockEntry: PluginPackageLockEntry = {
            requested: spec,
            resolvedVersion,
            integrity,
            packageRoot: targetPackageRoot,
            contentDigest,
        }

        await lock.runTransaction((lockFile) => {
            lockFile.packages[spec] = lockEntry
            if (spec !== parsed.normalizedSpec) {
                lockFile.packages[parsed.normalizedSpec] = {
                    ...lockEntry,
                    requested: parsed.normalizedSpec,
                }
            }
            const exactSpec: `npm:${string}` = `npm:${resolvedName}@${resolvedVersion}`
            if (exactSpec !== spec && exactSpec !== parsed.normalizedSpec) {
                lockFile.packages[exactSpec] = {
                    ...lockEntry,
                    requested: exactSpec,
                }
            }
        })

        return {
            name: resolvedName,
            version: resolvedVersion,
            integrity,
            packageRoot: targetPackageRoot,
            contentDigest,
        }
    }

    /**
     * Uninstall a package by removing it from the lockfile and deleting its directory on disk.
     */
    async uninstall(spec: string): Promise<void> {
        const parsed = parseNpmSpec(spec)
        const lock = new PluginPackageLock(this.lockfilePath)

        await lock.runTransaction(async (lockFile) => {
            const lockedEntry = lockFile.packages[spec] ?? lockFile.packages[parsed.normalizedSpec]
            if (lockedEntry?.packageRoot) {
                try {
                    await fs.rm(lockedEntry.packageRoot, { recursive: true, force: true })
                } catch {
                    // Ignore removal error
                }
            }

            delete lockFile.packages[spec]
            if (spec !== parsed.normalizedSpec) {
                delete lockFile.packages[parsed.normalizedSpec]
            }
        })
    }

    /**
     * Scans the managed npm directory and removes orphan packages that are neither
     * referenced in the lockfile nor present in active package roots.
     */
    async cleanOrphans(activePackageRoots: ReadonlySet<string> = new Set()): Promise<string[]> {
        const cleaned: string[] = []
        const lock = new PluginPackageLock(this.lockfilePath)

        return lock.withLock(async () => {
            try {
                await fs.mkdir(this.npmDir, { recursive: true })
            } catch {
                return cleaned
            }

            const lockFile = await lock.load()
            const lockedRoots = new Set<string>()
            for (const entry of Object.values(lockFile.packages)) {
                if (entry.packageRoot) {
                    lockedRoots.add(path.resolve(entry.packageRoot))
                }
            }

            const topEntries = await fs.readdir(this.npmDir, { withFileTypes: true })
            for (const top of topEntries) {
                if (top.name.startsWith('.tmp-')) {
                    const tmpPath = path.join(this.npmDir, top.name)
                    await fs.rm(tmpPath, { recursive: true, force: true }).catch(() => {})
                    cleaned.push(tmpPath)
                    continue
                }
                if (!top.isDirectory()) {
                    continue
                }

                const pkgDir = path.join(this.npmDir, top.name)
                const versionEntries = await fs.readdir(pkgDir, { withFileTypes: true })
                for (const ver of versionEntries) {
                    if (!ver.isDirectory()) {
                        continue
                    }
                    const verDir = path.join(pkgDir, ver.name)
                    const resolvedVerDir = path.resolve(verDir)

                    if (
                        !lockedRoots.has(resolvedVerDir) &&
                        !activePackageRoots.has(resolvedVerDir)
                    ) {
                        await fs.rm(verDir, { recursive: true, force: true }).catch(() => {})
                        cleaned.push(verDir)
                    }
                }

                // If pkgDir is now empty, remove it
                try {
                    const remaining = await fs.readdir(pkgDir)
                    if (remaining.length === 0) {
                        await fs.rmdir(pkgDir).catch(() => {})
                    }
                } catch {
                    // Ignore
                }
            }

            return cleaned
        })
    }
}
