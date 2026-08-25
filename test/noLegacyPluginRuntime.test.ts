import { describe, expect, it } from 'vitest'
import * as path from 'node:path'
import * as fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const repoRoot = path.resolve(__dirname, '..')

interface Violation {
    type: string
    file: string
    detail: string
}

function getAllProductionFiles(dir: string, baseDir: string = dir): string[] {
    const results: string[] = []
    if (!fs.existsSync(dir)) return results

    const entries = fs.readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name)
        const relPath = path.relative(baseDir, fullPath).replace(/\\/g, '/')

        // Ignore test files, fixtures, node_modules, dist, etc.
        if (
            relPath.includes('node_modules') ||
            relPath.includes('dist') ||
            relPath.includes('test') ||
            relPath.includes('.git') ||
            relPath.includes('.profiles') ||
            relPath.includes('bin')
        ) {
            continue
        }

        if (entry.isDirectory()) {
            results.push(...getAllProductionFiles(fullPath, baseDir))
        } else if (
            (entry.name.endsWith('.ts') ||
                entry.name.endsWith('.tsx') ||
                entry.name.endsWith('.js') ||
                entry.name.endsWith('.mjs')) &&
            !entry.name.includes('.test.') &&
            !entry.name.includes('.spec.')
        ) {
            results.push(fullPath)
        }
    }
    return results
}

describe('noLegacyPluginRuntime verification', () => {
    it('ensures no legacy plugin adapter files or directories exist', () => {
        const violations: Violation[] = []

        const forbiddenPaths = [
            'frontend/src/plugins/platform/LegacyPluginEntryAdapter.ts',
            'src/main/plugins/loading/LegacyMainPluginEntryAdapter.ts',
            'frontend/src/plugins/core',
            'src/main/plugins/bundled',
            'packages/plugin-sdk/src/definePlugin.ts',
        ]

        for (const forbidden of forbiddenPaths) {
            const target = path.join(repoRoot, forbidden)
            if (fs.existsSync(target)) {
                violations.push({
                    type: 'forbidden-path-exists',
                    file: forbidden,
                    detail: `Legacy path "${forbidden}" still exists on disk and must be deleted.`,
                })
            }
        }

        expect(violations).toEqual([])
    })

    it('ensures packages do not export legacy types or functions', async () => {
        const violations: Violation[] = []

        // 1. Check @cpa/plugin-api exports
        const pluginApi = await import('../packages/plugin-api/src/index.js')
        if ('PluginDefinition' in pluginApi || (pluginApi as any).PluginDefinition) {
            violations.push({
                type: 'forbidden-export',
                file: 'packages/plugin-api',
                detail: '@cpa/plugin-api still exports PluginDefinition',
            })
        }
        if ('AuthoritativePluginManifest' in pluginApi || (pluginApi as any).AuthoritativePluginManifest) {
            violations.push({
                type: 'forbidden-export',
                file: 'packages/plugin-api',
                detail: '@cpa/plugin-api still exports AuthoritativePluginManifest',
            })
        }
        if ('LegacyPluginManifest' in pluginApi || (pluginApi as any).LegacyPluginManifest) {
            violations.push({
                type: 'forbidden-export',
                file: 'packages/plugin-api',
                detail: '@cpa/plugin-api still exports LegacyPluginManifest',
            })
        }

        // 2. Check @cpa/plugin-sdk exports
        const pluginSdk = await import('../packages/plugin-sdk/src/index.js')
        if ('definePlugin' in pluginSdk) {
            violations.push({
                type: 'forbidden-export',
                file: 'packages/plugin-sdk',
                detail: '@cpa/plugin-sdk still exports definePlugin (must use definePluginEntry)',
            })
        }
        if ('parseAuthoritativePluginManifest' in pluginSdk) {
            violations.push({
                type: 'forbidden-export',
                file: 'packages/plugin-sdk',
                detail: '@cpa/plugin-sdk still exports parseAuthoritativePluginManifest',
            })
        }
        if ('validateAuthoritativePluginManifest' in pluginSdk) {
            violations.push({
                type: 'forbidden-export',
                file: 'packages/plugin-sdk',
                detail: '@cpa/plugin-sdk still exports validateAuthoritativePluginManifest',
            })
        }

        expect(violations).toEqual([])
    })

    it('ensures production code contains no legacy adapters, types, or fallback patterns', () => {
        const violations: Violation[] = []
        const prodDirs = [
            path.join(repoRoot, 'packages', 'plugin-api', 'src'),
            path.join(repoRoot, 'packages', 'plugin-kernel', 'src'),
            path.join(repoRoot, 'packages', 'plugin-sdk', 'src'),
            path.join(repoRoot, 'packages', 'plugin-ui', 'src'),
            path.join(repoRoot, 'src', 'main'),
            path.join(repoRoot, 'frontend', 'src'),
            path.join(repoRoot, 'plugins', 'bundled'),
            path.join(repoRoot, 'scripts'),
        ]

        const prodFiles = prodDirs.flatMap((d) => getAllProductionFiles(d, repoRoot))

        const patterns: Array<{ regex: RegExp; name: string }> = [
            { regex: /\bLegacyPluginEntryAdapter\b/, name: 'LegacyPluginEntryAdapter reference' },
            { regex: /\bLegacyMainPluginEntryAdapter\b/, name: 'LegacyMainPluginEntryAdapter reference' },
            { regex: /\bAuthoritativePluginManifest\b/, name: 'AuthoritativePluginManifest reference' },
            { regex: /\bLegacyPluginManifest\b/, name: 'LegacyPluginManifest reference' },
            { regex: /\bvalidateAuthoritativePluginManifest\b/, name: 'validateAuthoritativePluginManifest reference' },
            { regex: /\bparseAuthoritativePluginManifest\b/, name: 'parseAuthoritativePluginManifest reference' },
            { regex: /\bdefinePlugin\s*\(/, name: 'definePlugin() invocation (must use definePluginEntry)' },
            { regex: /\bPluginDefinition\b/, name: 'PluginDefinition type reference' },
            { regex: /['"](@\/plugins\/core|\.\.?\/core\/|frontend\/src\/plugins\/core)/, name: 'Import from plugins/core' },
            { regex: /\bcreateCodingTools\b/, name: 'createCodingTools reference (must use SPI tools snapshot)' },
            { regex: /\bloadResourceSnapshot\b/, name: 'loadResourceSnapshot reference (must use SPI resource snapshot)' },
            { regex: /\b\.isLegacy\b/, name: 'isLegacy runtime flag check' },
        ]

        for (const file of prodFiles) {
            const relPath = path.relative(repoRoot, file).replace(/\\/g, '/')
            // Skip scripts/plugin-architecture-report.mjs or similar if whitelisted, but check everywhere else
            if (relPath === 'scripts/plugin-architecture-report.mjs') {
                continue
            }

            const content = fs.readFileSync(file, 'utf8')
            for (const { regex, name } of patterns) {
                if (regex.test(content)) {
                    violations.push({
                        type: 'legacy-pattern-in-production',
                        file: relPath,
                        detail: `Found ${name} in production file "${relPath}"`,
                    })
                }
            }
        }

        expect(violations).toEqual([])
    })

    it('ensures generator strictly validates entries and has zero legacy fallbacks', async () => {
        const generatorPath = path.join(repoRoot, 'scripts', 'generate-bundled-plugin-catalog.mjs')
        const code = fs.readFileSync(generatorPath, 'utf8')

        expect(code).not.toContain('LegacyPluginEntryAdapter')
        expect(code).not.toContain('LegacyMainPluginEntryAdapter')
        expect(code).not.toContain('plugins/core')
        expect(code).not.toContain('plugins/bundled') // in legacy fallback import paths
    })

    it('ensures Agent runtime providers and service contain zero legacy fallbacks', async () => {
        const servicePath = path.join(repoRoot, 'frontend', 'src', 'features', 'agent-runtime', 'CLIProxyAPIAgentService.ts')
        const code = fs.readFileSync(servicePath, 'utf8')

        expect(code).not.toContain('createCodingTools')
        expect(code).not.toContain('loadResourceSnapshot')
    })
})
