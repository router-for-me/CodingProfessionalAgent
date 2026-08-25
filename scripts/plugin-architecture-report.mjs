#!/usr/bin/env node

/**
 * Universal Plugin Platform - Architecture Boundary Scanner & Baseline Report
 *
 * Scans TypeScript/JavaScript codebase for architectural violations:
 * - hostImportsPlugin: Host code importing plugin implementation files directly
 * - crossPluginImports: A plugin importing another plugin's internal implementation
 * - privateHostImports: Plugin code importing private host internals (stores, components, etc.)
 * - directNativeAccess: Direct window/bridge/IPC/Node access in plugins
 * - hardcodedContributionIds: Host files with hardcoded plugin IDs or contribution IDs
 * - manifestContract: Strict manifest contract validation (schema, entries, duplicate IDs, unregistered contributions)
 * - storeEffects: Zustand stores with side effects (I/O, IPC, bridge, UI imports, async network)
 * - legacyPaths: Obsolete directories, deprecated APIs (definePlugin), fallback symbols
 * - cycles: Strongly Connected Components (cycles) in production code using Tarjan's SCC algorithm
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'
import semver from 'semver'

const EXTENSIONS = [
    '',
    '.ts',
    '.tsx',
    '.js',
    '.jsx',
    '.mjs',
    '.cjs',
    '.cts',
    '.mts',
    '/index.ts',
    '/index.tsx',
    '/index.js',
    '/index.jsx',
    '/index.mjs',
]

const IGNORED_DIRS = new Set([
    'node_modules',
    'dist',
    'dist-electron',
    'bin',
    '.git',
    '.worktrees',
    'build',
    '.profiles',
    '.superpowers',
    'scripts',
])

const ALLOWED_MANIFEST_KEYS = new Set([
    'id',
    'name',
    'version',
    'apiVersion',
    'description',
    'engines',
    'entries',
    'dependencies',
    'capabilities',
    'contributes',
    'activationPriority',
    'author',
    'license',
    'repository',
    'keywords',
])

const FORBIDDEN_STORE_IMPORT_PATTERNS = [
    /electronBridge/i,
    /ElectronNativeBridge/i,
    /@\/features\/agent-runtime\/native/i,
    /@\/features\/agent-runtime\/hooks\/discovery/i,
    /@\/lib\/worktreeManager/i,
    /@\/lib\/environmentRunner/i,
    /@\/plugins\/platform/i,
    /@cpa\/plugin-kernel/i,
    /@cpa\/plugin-ui/i,
    /node:fs/i,
    /node:child_process/i,
    /node:http/i,
    /node:https/i,
    /^fs$/i,
    /^child_process$/i,
    /^http$/i,
    /^https$/i,
    /@\/components/i,
    /\.\.\/components/i,
]

const ALLOWED_PLUGIN_PACKAGES = new Set([
    'react',
    'react-dom',
    'react/jsx-runtime',
    'react/jsx-dev-runtime',
    'lucide-react',
    '@cpa/context-usage',
    '@cpa/plugin-api',
    '@cpa/plugin-sdk',
    '@cpa/plugin-ui',
])

/**
 * Unwrap TypeScript expression from parentheses, as-expressions, non-null assertions, etc.
 */
export function unwrapExpr(node) {
    let curr = node
    while (
        curr &&
        (ts.isParenthesizedExpression(curr) ||
            ts.isAsExpression(curr) ||
            ts.isTypeAssertionExpression(curr) ||
            ts.isNonNullExpression(curr))
    ) {
        curr = curr.expression
    }
    return curr
}

/**
 * Statically evaluates a string or template expression to a literal string if possible.
 */
export function evaluateStaticString(node) {
    if (!node) return null
    const unwrapped = unwrapExpr(node)
    if (ts.isStringLiteral(unwrapped) || ts.isNoSubstitutionTemplateLiteral(unwrapped)) {
        return unwrapped.text
    }
    if (ts.isTemplateExpression(unwrapped)) {
        let result = unwrapped.head.text
        for (const span of unwrapped.templateSpans) {
            const spanVal = evaluateStaticString(span.expression)
            if (spanVal === null) return null
            result += spanVal + span.literal.text
        }
        return result
    }
    if (ts.isBinaryExpression(unwrapped) && unwrapped.operatorToken.kind === ts.SyntaxKind.PlusToken) {
        const left = evaluateStaticString(unwrapped.left)
        const right = evaluateStaticString(unwrapped.right)
        if (left !== null && right !== null) {
            return left + right
        }
    }
    return null
}

/**
 * Get TypeScript ScriptKind from file path.
 */
function getScriptKind(filePath) {
    const ext = path.extname(filePath).toLowerCase()
    switch (ext) {
        case '.tsx':
            return ts.ScriptKind.TSX
        case '.jsx':
            return ts.ScriptKind.JSX
        case '.ts':
            return ts.ScriptKind.TS
        case '.js':
        case '.mjs':
        case '.cjs':
            return ts.ScriptKind.JS
        case '.json':
            return ts.ScriptKind.JSON
        default:
            return ts.ScriptKind.Unknown
    }
}

/**
 * Find all source files recursively under a directory.
 */
export function findSourceFiles(dir, isFixtureRoot = false, fileList = []) {
    if (!fs.existsSync(dir)) return fileList

    const entries = fs.readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name)

        if (entry.isDirectory()) {
            if (IGNORED_DIRS.has(entry.name)) continue
            if (!isFixtureRoot && (entry.name === 'test' || entry.name === 'fixtures')) {
                // Skip top-level test and fixtures directories when scanning whole project
                const rel = path.relative(process.cwd(), fullPath).replace(/\\/g, '/')
                if (rel === 'test' || rel === 'test/fixtures' || rel.startsWith('test/fixtures/')) {
                    continue
                }
            }
            findSourceFiles(fullPath, isFixtureRoot, fileList)
        } else if (entry.isFile()) {
            const ext = path.extname(entry.name).toLowerCase()
            if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.cts', '.mts'].includes(ext)) {
                if (!isFixtureRoot) {
                    if (
                        entry.name.endsWith('.test.ts') ||
                        entry.name.endsWith('.test.tsx') ||
                        entry.name.endsWith('.spec.ts') ||
                        entry.name.endsWith('.spec.tsx') ||
                        entry.name.endsWith('.d.ts')
                    ) {
                        continue
                    }
                }
                fileList.push(fullPath)
            }
        }
    }
    return fileList
}

/**
 * Find all manifest.json files recursively under a directory.
 */
export function findManifestFiles(dir, isFixtureRoot = false, manifestList = []) {
    if (!fs.existsSync(dir)) return manifestList

    const entries = fs.readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name)
        if (entry.isDirectory()) {
            if (IGNORED_DIRS.has(entry.name)) continue
            if (!isFixtureRoot && (entry.name === 'test' || entry.name === 'fixtures')) {
                const rel = path.relative(process.cwd(), fullPath).replace(/\\/g, '/')
                if (rel === 'test' || rel === 'test/fixtures' || rel.startsWith('test/fixtures/')) {
                    continue
                }
            }
            findManifestFiles(fullPath, isFixtureRoot, manifestList)
        } else if (entry.isFile() && entry.name === 'manifest.json') {
            manifestList.push(fullPath)
        }
    }
    return manifestList
}

/**
 * AST-based extraction of imports, exports, requires, and dynamic imports with line/col numbers.
 */
export function extractAstImports(filePath, content) {
    const scriptKind = getScriptKind(filePath)
    const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true, scriptKind)
    const imports = []

    function addImport(specifier, node, isTypeOnly = false, kind = 'import') {
        if (!specifier || typeof specifier !== 'string') return
        const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
        imports.push({
            specifier,
            line: line + 1,
            col: character + 1,
            isTypeOnly,
            kind,
        })
    }

    function visit(node) {
        // 1. Static ImportDeclaration
        if (ts.isImportDeclaration(node)) {
            let isTypeOnly = Boolean(node.importClause?.isTypeOnly)
            if (!isTypeOnly && node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)) {
                const elements = node.importClause.namedBindings.elements
                if (elements.length > 0 && elements.every((el) => Boolean(el.isTypeOnly))) {
                    isTypeOnly = true
                }
            }
            if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
                addImport(node.moduleSpecifier.text, node, isTypeOnly, 'import')
            }
        }

        // 2. Static ExportDeclaration with specifier (export ... from '...')
        else if (ts.isExportDeclaration(node)) {
            let isTypeOnly = Boolean(node.isTypeOnly)
            if (!isTypeOnly && node.exportClause && ts.isNamedExports(node.exportClause)) {
                const elements = node.exportClause.elements
                if (elements.length > 0 && elements.every((el) => Boolean(el.isTypeOnly))) {
                    isTypeOnly = true
                }
            }
            if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
                addImport(node.moduleSpecifier.text, node, isTypeOnly, 'export')
            }
        }

        // 3. ImportEqualsDeclaration (import foo = require('...'))
        else if (ts.isImportEqualsDeclaration(node)) {
            if (
                node.moduleReference &&
                ts.isExternalModuleReference(node.moduleReference) &&
                node.moduleReference.expression &&
                ts.isStringLiteral(node.moduleReference.expression)
            ) {
                addImport(node.moduleReference.expression.text, node, false, 'require')
            }
        }

        // 4. Dynamic import() or require()
        else if (ts.isCallExpression(node)) {
            const expr = unwrapExpr(node.expression)
            const isDynamicImport = expr.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(expr) && expr.text === 'import')
            const isRequire = ts.isIdentifier(expr) && expr.text === 'require'

            if ((isDynamicImport || isRequire) && node.arguments.length > 0) {
                const arg = unwrapExpr(node.arguments[0])
                const str = evaluateStaticString(arg)
                if (str !== null) {
                    addImport(str, node, false, isDynamicImport ? 'dynamic-import' : 'require')
                }
            }
        }

        ts.forEachChild(node, visit)
    }

    visit(sourceFile)
    return imports
}

/**
 * Resolve an import specifier to a physical file path if internal to repository.
 */
export function resolveImport(specifier, fromFile, rootDir, repoRoot) {
    // Relative imports
    if (specifier.startsWith('.')) {
        const fromDir = path.dirname(fromFile)
        let candidateBase = path.resolve(fromDir, specifier)

        // If specifier ends in .js / .jsx / .mjs, also test .ts / .tsx
        const strippedBase = candidateBase.replace(/\.(js|jsx|mjs|cjs)$/, '')

        const basesToTry = [candidateBase, strippedBase]
        for (const base of basesToTry) {
            for (const ext of EXTENSIONS) {
                const candidate = base + ext
                if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
                    return candidate
                }
            }
        }
        return null
    }

    // Alias @/ imports -> frontend/src/
    if (specifier.startsWith('@/')) {
        const subPath = specifier.slice(2)
        const candidates = [
            path.resolve(repoRoot, 'frontend/src', subPath),
            path.resolve(rootDir, 'frontend/src', subPath),
            path.resolve(rootDir, 'src', subPath),
            path.resolve(rootDir, subPath),
        ]

        for (const candidateBase of candidates) {
            const strippedBase = candidateBase.replace(/\.(js|jsx|mjs|cjs)$/, '')
            const basesToTry = [candidateBase, strippedBase]
            for (const base of basesToTry) {
                for (const ext of EXTENSIONS) {
                    const candidate = base + ext
                    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
                        return candidate
                    }
                }
            }
        }
        return null
    }

    // Workspace packages: @cpa/context-usage, @cpa/plugin-api, @cpa/plugin-kernel, @cpa/plugin-sdk, @cpa/plugin-ui
    if (specifier.startsWith('@cpa/')) {
        const pkgName = specifier.slice(5)
        const parts = pkgName.split('/')
        const rootPkg = parts[0]
        const subPath = parts.slice(1).join('/')

        const pkgDir = path.resolve(repoRoot, 'packages', rootPkg)
        if (fs.existsSync(pkgDir)) {
            if (!subPath) {
                const entry = path.resolve(pkgDir, 'src', 'index.ts')
                if (fs.existsSync(entry)) return entry
            } else {
                const candidateBase = path.resolve(pkgDir, 'src', subPath)
                for (const ext of EXTENSIONS) {
                    const candidate = candidateBase + ext
                    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
                        return candidate
                    }
                }
            }
        }
    }

    return null
}

/**
 * Classify a file into architectural domain: host, plugin, platform, private host, etc.
 */
export function classifyFile(filePath, repoRoot, isFixtureRoot = false) {
    const rel = path.relative(repoRoot, filePath).replace(/\\/g, '/')
    const basename = path.basename(filePath)

    const isTest = isFixtureRoot
        ? rel.endsWith('.test.ts') || rel.endsWith('.test.tsx') || rel.endsWith('.spec.ts') || rel.endsWith('.spec.tsx')
        : rel.includes('.test.') ||
          rel.includes('.spec.') ||
          rel.startsWith('test/') ||
          rel.includes('/test/')

    // Check if it's the verified generated loader - ONLY allowed exact paths
    let isGeneratedLoader = false
    if (
        rel === 'src/main/plugins/generated/bundledPluginLoaders.ts' ||
        rel === 'frontend/src/plugins/generated/bundledPluginLoaders.ts'
    ) {
        isGeneratedLoader = true
    }

    const isStore =
        (rel.includes('/stores/') || rel.endsWith('Store.ts') || rel.endsWith('Store.tsx')) &&
        !rel.endsWith('.test.ts') &&
        !rel.endsWith('.test.tsx') &&
        !rel.endsWith('.spec.ts') &&
        !rel.endsWith('.d.ts')

    // Platform / Plugin Kernel / Shared infrastructure files
    const isPlatform =
        rel.startsWith('packages/context-usage/') ||
        rel.startsWith('packages/plugin-kernel/') ||
        rel.startsWith('packages/plugin-api/') ||
        rel.startsWith('packages/plugin-sdk/') ||
        rel.startsWith('packages/plugin-ui/') ||
        rel.startsWith('frontend/src/plugins/platform/') ||
        rel.startsWith('frontend/src/plugins/manager/') ||
        rel.startsWith('frontend/src/plugins/registry/') ||
        rel.startsWith('frontend/src/plugins/protocol/') ||
        rel === 'frontend/src/plugins/types.ts' ||
        rel.startsWith('src/main/plugins/catalog/') ||
        rel.startsWith('src/main/plugins/sources/') ||
        rel.startsWith('src/main/plugins/loading/') ||
        rel.startsWith('src/main/plugins/runtime/') ||
        rel.startsWith('src/main/plugins/resources/') ||
        rel.startsWith('src/main/plugins/capabilities/') ||
        rel.startsWith('src/main/plugins/storage/') ||
        rel.startsWith('src/main/plugins/config/') ||
        rel.startsWith('src/main/plugins/management/') ||
        rel.startsWith('src/main/plugins/packages/') ||
        rel.startsWith('src/main/plugins/contributions/')

    if (isPlatform) {
        return {
            isPlugin: false,
            pluginId: null,
            isHost: false,
            isPrivateHost: false,
            isPlatform: true,
            isGeneratedLoader,
            isStore,
            isTest,
        }
    }

    // Check if plugin file:
    // 1. plugins/bundled/<plugin-name>/...
    let match = rel.match(/(?:^|\/)plugins\/bundled\/([^/]+)/)
    if (match) {
        return {
            isPlugin: true,
            pluginId: match[1],
            isHost: false,
            isPrivateHost: false,
            isPlatform: false,
            isGeneratedLoader,
            isStore,
            isTest,
        }
    }

    // 2. plugins/<plugin-name>/... (external / fixtures)
    match = rel.match(/(?:^|\/)plugins\/([^/]+)/)
    if (
        match &&
        ![
            'manager',
            'registry',
            'platform',
            'generated',
            'protocol',
            'types',
            'types.ts',
            'ui',
            'contributions',
            'sources',
            'loading',
            'runtime',
            'resources',
            'capabilities',
            'storage',
            'config',
            'management',
            'packages',
            'catalog',
        ].includes(match[1])
    ) {
        return {
            isPlugin: true,
            pluginId: match[1],
            isHost: false,
            isPrivateHost: false,
            isPlatform: false,
            isGeneratedLoader,
            isStore,
            isTest,
        }
    }

    // 3. Fixture plugin files like plugin-*.ts or *Plugin.ts
    if (basename.startsWith('plugin-') || basename.endsWith('Plugin.ts') || basename.endsWith('Plugin.tsx')) {
        const idMatch = basename.match(/^plugin-([a-zA-Z0-9_-]+)/) || basename.match(/^([a-zA-Z0-9_-]+)Plugin/)
        const pluginId = idMatch ? idMatch[1] : basename
        return {
            isPlugin: true,
            pluginId,
            isHost: false,
            isPrivateHost: false,
            isPlatform: false,
            isGeneratedLoader,
            isStore,
            isTest,
        }
    }

    // Private Host internals that plugins should NOT import directly
    const isPrivateHost =
        rel.startsWith('frontend/src/stores/') ||
        rel.startsWith('frontend/src/components/') ||
        rel.startsWith('frontend/src/features/agent-runtime/') ||
        rel.startsWith('frontend/src/features/agent/') ||
        rel.startsWith('frontend/src/app/') ||
        rel.startsWith('src/main/services/') ||
        rel.startsWith('src/main/ipc/') ||
        rel.startsWith('src/preload/')

    const isHost = !isPlatform && !isGeneratedLoader

    return {
        isPlugin: false,
        pluginId: null,
        isHost,
        isPrivateHost,
        isPlatform,
        isGeneratedLoader,
        isStore,
        isTest,
    }
}

/**
 * Tarjan's Strongly Connected Components (SCC) algorithm to detect cycles.
 */
export function findCycles(graph) {
    let index = 0
    const indices = new Map()
    const lowlink = new Map()
    const onStack = new Map()
    const stack = []
    const sccs = []

    function strongConnect(node) {
        indices.set(node, index)
        lowlink.set(node, index)
        index++
        stack.push(node)
        onStack.set(node, true)

        const neighbors = graph.get(node) || []
        for (const neighbor of neighbors) {
            if (!indices.has(neighbor)) {
                strongConnect(neighbor)
                lowlink.set(node, Math.min(lowlink.get(node), lowlink.get(neighbor)))
            } else if (onStack.get(neighbor)) {
                lowlink.set(node, Math.min(lowlink.get(node), indices.get(neighbor)))
            }
        }

        if (lowlink.get(node) === indices.get(node)) {
            const scc = []
            let w
            do {
                w = stack.pop()
                onStack.set(w, false)
                scc.push(w)
            } while (w !== node)

            const neighbors = graph.get(node) || []
            if (scc.length > 1 || (scc.length === 1 && neighbors.includes(node))) {
                sccs.push(scc)
            }
        }
    }

    for (const node of graph.keys()) {
        if (!indices.has(node)) {
            strongConnect(node)
        }
    }

    return sccs
}

/**
 * Robust extraction of statically registered contribution IDs from an entry file AST.
 * Handles literals, const objects/arrays, spread, for-of, forEach, and local helper calls.
 */
export function extractStaticallyRegisteredIds(sourceFile) {
    const registeredIds = []
    const constVars = new Map()
    const helperFuncs = new Map()

    // 1st pass: collect const declarations and helper functions
    function firstPass(node) {
        if (ts.isVariableDeclaration(node) && node.name && ts.isIdentifier(node.name) && node.initializer) {
            const varName = node.name.text
            const init = unwrapExpr(node.initializer)
            const strVal = evaluateStaticString(init)
            if (strVal !== null) {
                constVars.set(varName, strVal)
            } else if (ts.isObjectLiteralExpression(init)) {
                const obj = {}
                for (const prop of init.properties) {
                    if (ts.isPropertyAssignment(prop) && prop.name) {
                        const pName = ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name) ? prop.name.text : null
                        if (pName) {
                            const pVal = evaluateStaticString(prop.initializer)
                            if (pVal !== null) obj[pName] = pVal
                        }
                    }
                }
                constVars.set(varName, obj)
            } else if (ts.isArrayLiteralExpression(init)) {
                const arr = []
                for (const el of init.elements) {
                    const str = evaluateStaticString(el)
                    if (str !== null) {
                        arr.push(str)
                    } else if (ts.isObjectLiteralExpression(el)) {
                        const obj = {}
                        for (const prop of el.properties) {
                            if (ts.isPropertyAssignment(prop) && prop.name) {
                                const pName = ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name) ? prop.name.text : null
                                if (pName) {
                                    const pVal = evaluateStaticString(prop.initializer)
                                    if (pVal !== null) obj[pName] = pVal
                                }
                            }
                        }
                        arr.push(obj)
                    }
                }
                constVars.set(varName, arr)
            }
        }

        if (ts.isFunctionDeclaration(node) && node.name && ts.isIdentifier(node.name)) {
            const funcName = node.name.text
            const paramNames = node.parameters.map((p) => (ts.isIdentifier(p.name) ? p.name.text : null))
            helperFuncs.set(funcName, { paramNames, calls: [] })
        }

        ts.forEachChild(node, firstPass)
    }

    firstPass(sourceFile)

    // Collect helper calls
    function collectHelperCalls(node) {
        if (ts.isCallExpression(node)) {
            const calleeExpr = unwrapExpr(node.expression)
            if (ts.isIdentifier(calleeExpr)) {
                const fName = calleeExpr.text
                if (helperFuncs.has(fName)) {
                    const args = node.arguments.map((arg) => {
                        const s = evaluateStaticString(arg)
                        if (s !== null) return s
                        if (ts.isIdentifier(arg) && constVars.has(arg.text)) return constVars.get(arg.text)
                        return null
                    })
                    helperFuncs.get(fName).calls.push(args)
                }
            }
        }
        ts.forEachChild(node, collectHelperCalls)
    }

    collectHelperCalls(sourceFile)

    // Main registration visitor
    function checkRegistration(node) {
        if (ts.isCallExpression(node)) {
            const calleeExpr = unwrapExpr(node.expression)
            const calleeText = calleeExpr.getText(sourceFile)
            const isRegCall =
                calleeText.includes('registerView') ||
                calleeText.includes('registerAction') ||
                calleeText.includes('registerPanel') ||
                calleeText.includes('registerSettingsSection') ||
                calleeText.includes('registerComposerControl') ||
                calleeText.includes('registerChatRenderer') ||
                calleeText.includes('registerToolFactory') ||
                calleeText.includes('registerResourceProvider') ||
                calleeText.includes('registerHook') ||
                calleeText.includes('registerFloatingOverlay') ||
                calleeText.includes('registerProtocolProvider') ||
                calleeText.includes('registerModelCatalog') ||
                calleeText.includes('registerNavigationItem') ||
                calleeText.includes('registerSlot')

            if (isRegCall && node.arguments.length > 0) {
                const firstArg = unwrapExpr(node.arguments[0])
                const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))

                // Case 1: direct string literal or template
                const strArg = evaluateStaticString(firstArg)
                if (strArg) {
                    registeredIds.push({ id: strArg, line: line + 1, col: character + 1 })
                    return
                }

                // Case 2: direct object literal (with possible spread or identifier properties)
                if (ts.isObjectLiteralExpression(firstArg)) {
                    for (const prop of firstArg.properties) {
                        if (ts.isPropertyAssignment(prop) && prop.name) {
                            const pName = ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name) ? prop.name.text : null
                            if (pName === 'id') {
                                const init = unwrapExpr(prop.initializer)
                                const idVal = evaluateStaticString(init)
                                if (idVal) {
                                    registeredIds.push({ id: idVal, line: line + 1, col: character + 1 })
                                } else if (ts.isIdentifier(init)) {
                                    const idVar = init.text
                                    // Check helper params
                                    for (const [, info] of helperFuncs.entries()) {
                                        const pIdx = info.paramNames.indexOf(idVar)
                                        if (pIdx !== -1) {
                                            for (const callArgs of info.calls) {
                                                const argVal = callArgs[pIdx]
                                                if (typeof argVal === 'string') {
                                                    registeredIds.push({ id: argVal, line: line + 1, col: character + 1 })
                                                }
                                            }
                                        }
                                    }
                                    if (constVars.has(idVar) && typeof constVars.get(idVar) === 'string') {
                                        registeredIds.push({ id: constVars.get(idVar), line: line + 1, col: character + 1 })
                                    }
                                }
                            }
                        } else if (ts.isShorthandPropertyAssignment(prop) && prop.name.text === 'id') {
                            const idVar = prop.name.text
                            // Check helper params
                            for (const [, info] of helperFuncs.entries()) {
                                const pIdx = info.paramNames.indexOf(idVar)
                                if (pIdx !== -1) {
                                    for (const callArgs of info.calls) {
                                        const argVal = callArgs[pIdx]
                                        if (typeof argVal === 'string') {
                                            registeredIds.push({ id: argVal, line: line + 1, col: character + 1 })
                                        }
                                    }
                                }
                            }
                            if (constVars.has(idVar) && typeof constVars.get(idVar) === 'string') {
                                registeredIds.push({ id: constVars.get(idVar), line: line + 1, col: character + 1 })
                            }
                        }
                    }
                }

                // Case 3: identifier argument: e.g. ctx.registerView(v)
                if (ts.isIdentifier(firstArg)) {
                    const argName = firstArg.text

                    if (constVars.has(argName)) {
                        const val = constVars.get(argName)
                        if (typeof val === 'string') {
                            registeredIds.push({ id: val, line: line + 1, col: character + 1 })
                        } else if (typeof val === 'object' && val?.id) {
                            registeredIds.push({ id: val.id, line: line + 1, col: character + 1 })
                        }
                    }

                    // Check for-of loop: for (const v of VIEWS)
                    let curr = node.parent
                    while (curr) {
                        if (ts.isForOfStatement(curr)) {
                            const init = curr.initializer
                            let loopVar = null
                            if (ts.isVariableDeclarationList(init) && init.declarations.length > 0) {
                                const decl = init.declarations[0]
                                if (ts.isIdentifier(decl.name)) loopVar = decl.name.text
                            }
                            if (loopVar === argName) {
                                const expr = unwrapExpr(curr.expression)
                                if (ts.isIdentifier(expr) && constVars.has(expr.text)) {
                                    const arr = constVars.get(expr.text)
                                    if (Array.isArray(arr)) {
                                        for (const item of arr) {
                                            if (typeof item === 'string') {
                                                registeredIds.push({ id: item, line: line + 1, col: character + 1 })
                                            } else if (item?.id) {
                                                registeredIds.push({ id: item.id, line: line + 1, col: character + 1 })
                                            }
                                        }
                                    }
                                }
                            }
                        }
                        curr = curr.parent
                    }
                }
            }
        }

        // Check array.forEach / array.map
        if (ts.isCallExpression(node)) {
            const calleeExpr = unwrapExpr(node.expression)
            if (ts.isPropertyAccessExpression(calleeExpr)) {
                const prop = calleeExpr.name.text
                if (prop === 'forEach' || prop === 'map') {
                    const targetArrExpr = unwrapExpr(calleeExpr.expression)
                    let items = []
                    if (ts.isArrayLiteralExpression(targetArrExpr)) {
                        items = targetArrExpr.elements
                            .map((el) => {
                                const s = evaluateStaticString(el)
                                if (s !== null) return s
                                if (ts.isObjectLiteralExpression(el)) {
                                    for (const p of el.properties) {
                                        if (
                                            ts.isPropertyAssignment(p) &&
                                            p.name &&
                                            (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) &&
                                            p.name.text === 'id'
                                        ) {
                                            return evaluateStaticString(p.initializer)
                                        }
                                    }
                                }
                                return null
                            })
                            .filter(Boolean)
                    } else if (ts.isIdentifier(targetArrExpr) && constVars.has(targetArrExpr.text)) {
                        const c = constVars.get(targetArrExpr.text)
                        if (Array.isArray(c)) {
                            items = c.map((x) => (typeof x === 'string' ? x : x?.id)).filter(Boolean)
                        }
                    }

                    if (items.length > 0 && node.arguments.length > 0) {
                        const callback = unwrapExpr(node.arguments[0])
                        if (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) {
                            function checkCallback(cbNode) {
                                if (ts.isCallExpression(cbNode)) {
                                    const expr = unwrapExpr(cbNode.expression)
                                    const text = expr.getText(sourceFile)
                                    if (
                                        text.includes('registerView') ||
                                        text.includes('registerAction') ||
                                        text.includes('registerPanel') ||
                                        text.includes('registerSettingsSection') ||
                                        text.includes('registerComposerControl') ||
                                        text.includes('registerChatRenderer') ||
                                        text.includes('registerToolFactory') ||
                                        text.includes('registerResourceProvider') ||
                                        text.includes('registerHook') ||
                                        text.includes('registerFloatingOverlay')
                                    ) {
                                        const { line, character } = sourceFile.getLineAndCharacterOfPosition(cbNode.getStart(sourceFile))
                                        for (const it of items) {
                                            registeredIds.push({ id: it, line: line + 1, col: character + 1 })
                                        }
                                    }
                                }
                                ts.forEachChild(cbNode, checkCallback)
                            }
                            checkCallback(callback.body)
                        }
                    }
                }
            }
        }

        ts.forEachChild(node, checkRegistration)
    }

    checkRegistration(sourceFile)
    return registeredIds
}

/**
 * Collect all plugin IDs and contribution IDs from discovered manifests and validate contracts.
 */
export function collectAndValidateManifests(targetRoot, repoRoot, isFixtureRoot = false) {
    const manifestFiles = findManifestFiles(targetRoot, isFixtureRoot)
    const manifests = new Map()
    const allPluginIds = new Set()
    const uiContributionIds = new Set()
    const allContributionIds = new Set()
    const contributionsByKind = new Map()
    const manifestContractViolations = []

    const seenPluginIds = new Map()

    for (const manifestPath of manifestFiles) {
        const relPath = path.relative(repoRoot, manifestPath).replace(/\\/g, '/')
        const manifestDir = path.dirname(manifestPath)
        const dirName = path.basename(manifestDir)

        let manifest
        try {
            const raw = fs.readFileSync(manifestPath, 'utf8')
            manifest = JSON.parse(raw)
        } catch (err) {
            manifestContractViolations.push({
                category: 'manifestContract',
                file: relPath,
                line: 1,
                col: 1,
                message: `JSON parse error in manifest: ${err.message}`,
            })
            continue
        }

        // 1. Check top-level allowed keys
        for (const key of Object.keys(manifest)) {
            if (!ALLOWED_MANIFEST_KEYS.has(key)) {
                manifestContractViolations.push({
                    category: 'manifestContract',
                    file: relPath,
                    line: 1,
                    col: 1,
                    message: `Manifest contains unknown top-level field "${key}".`,
                    pluginId: manifest.id,
                })
            }
        }

        // 2. Validate required fields
        if (!manifest.id || typeof manifest.id !== 'string') {
            manifestContractViolations.push({
                category: 'manifestContract',
                file: relPath,
                line: 1,
                col: 1,
                message: 'Manifest is missing required "id" field.',
            })
            continue
        }

        if (!manifest.name || typeof manifest.name !== 'string') {
            manifestContractViolations.push({
                category: 'manifestContract',
                file: relPath,
                line: 1,
                col: 1,
                message: `Manifest "${manifest.id}" is missing required "name" field.`,
                pluginId: manifest.id,
            })
        }

        if (!manifest.version || !semver.valid(manifest.version)) {
            manifestContractViolations.push({
                category: 'manifestContract',
                file: relPath,
                line: 1,
                col: 1,
                message: `Manifest "${manifest.id}" has invalid semver version "${manifest.version}".`,
                pluginId: manifest.id,
            })
        }

        if (!manifest.apiVersion || !semver.valid(manifest.apiVersion)) {
            manifestContractViolations.push({
                category: 'manifestContract',
                file: relPath,
                line: 1,
                col: 1,
                message: `Manifest "${manifest.id}" has invalid semver apiVersion "${manifest.apiVersion}".`,
                pluginId: manifest.id,
            })
        }

        if (!manifest.engines || !manifest.engines.cpa) {
            manifestContractViolations.push({
                category: 'manifestContract',
                file: relPath,
                line: 1,
                col: 1,
                message: `Manifest "${manifest.id}" is missing required "engines.cpa" version range.`,
                pluginId: manifest.id,
            })
        }

        // 3. Duplicate plugin ID check
        if (seenPluginIds.has(manifest.id)) {
            manifestContractViolations.push({
                category: 'manifestContract',
                file: relPath,
                line: 1,
                col: 1,
                message: `Duplicate plugin ID "${manifest.id}" detected (previously defined at "${seenPluginIds.get(manifest.id)}").`,
                pluginId: manifest.id,
            })
        } else {
            seenPluginIds.set(manifest.id, relPath)
        }

        // 4. Directory ID match for bundled plugins
        if (relPath.includes('plugins/bundled/')) {
            const shortName = manifest.id.replace(/^cpa\.core\./, '')
            if (dirName !== manifest.id && dirName !== shortName) {
                manifestContractViolations.push({
                    category: 'manifestContract',
                    file: relPath,
                    line: 1,
                    col: 1,
                    message: `Directory name "${dirName}" does not match plugin ID "${manifest.id}".`,
                    pluginId: manifest.id,
                })
            }
        }

        allPluginIds.add(manifest.id)
        manifests.set(manifest.id, manifest)

        // 5. Capabilities checks
        if (manifest.capabilities) {
            if (!Array.isArray(manifest.capabilities)) {
                manifestContractViolations.push({
                    category: 'manifestContract',
                    file: relPath,
                    line: 1,
                    col: 1,
                    message: `Manifest "${manifest.id}" "capabilities" must be an array.`,
                    pluginId: manifest.id,
                })
            } else {
                const seenCaps = new Set()
                for (const cap of manifest.capabilities) {
                    if (seenCaps.has(cap)) {
                        manifestContractViolations.push({
                            category: 'manifestContract',
                            file: relPath,
                            line: 1,
                            col: 1,
                            message: `Manifest "${manifest.id}" contains duplicate capability "${cap}".`,
                            pluginId: manifest.id,
                        })
                    }
                    seenCaps.add(cap)
                }
            }
        }

        // 6. Contributes checks
        const declaredContributionIds = new Set()
        if (manifest.contributes) {
            if (typeof manifest.contributes !== 'object' || Array.isArray(manifest.contributes)) {
                manifestContractViolations.push({
                    category: 'manifestContract',
                    file: relPath,
                    line: 1,
                    col: 1,
                    message: `Manifest "${manifest.id}" "contributes" must be an object.`,
                    pluginId: manifest.id,
                })
            } else {
                for (const [kind, list] of Object.entries(manifest.contributes)) {
                    if (!Array.isArray(list)) {
                        manifestContractViolations.push({
                            category: 'manifestContract',
                            file: relPath,
                            line: 1,
                            col: 1,
                            message: `Manifest "${manifest.id}" contributes.${kind} must be an array.`,
                            pluginId: manifest.id,
                        })
                        continue
                    }

                    if (!contributionsByKind.has(kind)) {
                        contributionsByKind.set(kind, new Set())
                    }
                    const kindSet = contributionsByKind.get(kind)
                    const seenInKind = new Set()

                    const isUiKind = ['view', 'panel', 'settings', 'action', 'floating', 'composer', 'chat-renderer', 'slot', 'navigation'].includes(kind)

                    for (const item of list) {
                        const id = typeof item === 'string' ? item : item?.id
                        if (id) {
                            if (seenInKind.has(id)) {
                                manifestContractViolations.push({
                                    category: 'manifestContract',
                                    file: relPath,
                                    line: 1,
                                    col: 1,
                                    message: `Manifest "${manifest.id}" contains duplicate contribution "${id}" in kind "${kind}".`,
                                    pluginId: manifest.id,
                                })
                            }
                            seenInKind.add(id)
                            declaredContributionIds.add(id)
                            allContributionIds.add(id)
                            kindSet.add(id)
                            if (isUiKind) {
                                uiContributionIds.add(id)
                            }
                        }
                    }
                }
            }
        }

        // 7. Entries existence and static registration extraction checks
        if (manifest.entries && typeof manifest.entries === 'object') {
            for (const [runtime, entryRelPath] of Object.entries(manifest.entries)) {
                if (typeof entryRelPath !== 'string' || !entryRelPath.startsWith('./')) {
                    manifestContractViolations.push({
                        category: 'manifestContract',
                        file: relPath,
                        line: 1,
                        col: 1,
                        message: `Manifest "${manifest.id}" entry "${runtime}" must be a relative path starting with "./" (got "${entryRelPath}").`,
                        pluginId: manifest.id,
                    })
                    continue
                }

                const targetPath = path.resolve(manifestDir, entryRelPath)
                let resolvedTarget = null

                for (const ext of ['', '.ts', '.tsx', '.js', '.jsx']) {
                    const candidate = targetPath + ext
                    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
                        resolvedTarget = candidate
                        break
                    }
                }

                if (!resolvedTarget) {
                    manifestContractViolations.push({
                        category: 'manifestContract',
                        file: relPath,
                        line: 1,
                        col: 1,
                        message: `Manifest "${manifest.id}" declares entry "${entryRelPath}" which does not exist on disk.`,
                        pluginId: manifest.id,
                    })
                    continue
                }

                // Check entry content: static registrations vs manifest
                try {
                    const entryContent = fs.readFileSync(resolvedTarget, 'utf8')
                    const entryRelFromRepo = path.relative(repoRoot, resolvedTarget).replace(/\\/g, '/')
                    const entrySf = ts.createSourceFile(resolvedTarget, entryContent, ts.ScriptTarget.Latest, true, getScriptKind(resolvedTarget))

                    const registered = extractStaticallyRegisteredIds(entrySf)
                    for (const { id: regId, line, col } of registered) {
                        if (!declaredContributionIds.has(regId)) {
                            manifestContractViolations.push({
                                category: 'manifestContract',
                                file: entryRelFromRepo,
                                line,
                                col,
                                message: `Plugin "${manifest.id}" statically registers contribution "${regId}" in "${entryRelPath}" but does not declare it in manifest.contributes.`,
                                pluginId: manifest.id,
                                contributionId: regId,
                            })
                        }
                    }
                } catch {}
            }
        }
    }

    return {
        manifests,
        allPluginIds,
        uiContributionIds,
        allContributionIds,
        contributionsByKind,
        manifestContractViolations,
    }
}

/**
 * Main scan function: scans the directory and returns ArchitectureReport.
 */
export async function scanPluginArchitecture(rootDir = '.') {
    const repoRoot = path.resolve(process.cwd())
    const targetRoot = path.resolve(repoRoot, rootDir)
    const isFixtureRoot = targetRoot.includes('test/fixtures') || targetRoot.includes('fixtures')

    const files = findSourceFiles(targetRoot, isFixtureRoot)
    const fileSet = new Set(files)

    // Collect manifests and validate contracts
    const {
        manifests,
        allPluginIds,
        uiContributionIds,
        allContributionIds,
        manifestContractViolations,
    } = collectAndValidateManifests(targetRoot, repoRoot, isFixtureRoot)

    const hostImportsPlugin = []
    const crossPluginImports = []
    const privateHostImports = []
    const directNativeAccess = []
    const hardcodedContributionIds = []
    const manifestContract = [...manifestContractViolations]
    const storeEffects = []
    const legacyPaths = []
    const graph = new Map()

    let totalImports = 0

    // Initialize graph nodes
    for (const file of files) {
        const rel = path.relative(repoRoot, file).replace(/\\/g, '/')
        graph.set(rel, [])
    }

    // Check legacy paths existence on disk
    if (!isFixtureRoot) {
        const forbiddenDirs = [
            path.join(repoRoot, 'frontend', 'src', 'plugins', 'core'),
            path.join(repoRoot, 'src', 'main', 'plugins', 'bundled'),
        ]
        for (const dir of forbiddenDirs) {
            if (fs.existsSync(dir)) {
                legacyPaths.push({
                    category: 'legacyPaths',
                    file: path.relative(repoRoot, dir).replace(/\\/g, '/'),
                    line: 1,
                    col: 1,
                    message: `Forbidden legacy directory "${path.relative(repoRoot, dir)}" exists on disk.`,
                })
            }
        }
    }

    // Process each source file
    for (const file of files) {
        const relFile = path.relative(repoRoot, file).replace(/\\/g, '/')
        const content = fs.readFileSync(file, 'utf8')
        const fileInfo = classifyFile(file, repoRoot, isFixtureRoot)
        const scriptKind = getScriptKind(file)
        const sourceFile = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true, scriptKind)

        const fileImports = extractAstImports(file, content)
        totalImports += fileImports.length

        // Check unauthorized generated loader locations
        if (
            (relFile.includes('bundledPluginLoaders.ts') || content.includes('Generated by scripts/generate-bundled-plugin-catalog.mjs')) &&
            relFile !== 'src/main/plugins/generated/bundledPluginLoaders.ts' &&
            relFile !== 'frontend/src/plugins/generated/bundledPluginLoaders.ts'
        ) {
            legacyPaths.push({
                category: 'legacyPaths',
                file: relFile,
                line: 1,
                col: 1,
                message: `Unauthorized generated loader file location "${relFile}". Generated loaders are strictly restricted to canonical paths.`,
                snippet: content.slice(0, 100),
            })
        }

        // 1. Direct Native Access in Plugins (Zero Tolerance & Taint Tracking)
        if (fileInfo.isPlugin && !fileInfo.isTest) {
            const globalAliases = new Set(['window', 'globalThis', 'self', 'global'])
            const bridgeAliases = new Set(['electronBridge', 'cpa', 'cpaHostTransport'])
            const requireAliases = new Set(['require'])

            // Pass 1: find aliases, renames, and destructuring
            function pass1(node) {
                if (ts.isVariableDeclaration(node) && node.initializer) {
                    const init = unwrapExpr(node.initializer)

                    // Case A: const w = window
                    if (ts.isIdentifier(node.name)) {
                        const varName = node.name.text
                        if (ts.isIdentifier(init)) {
                            if (globalAliases.has(init.text)) globalAliases.add(varName)
                            if (bridgeAliases.has(init.text)) bridgeAliases.add(varName)
                            if (requireAliases.has(init.text)) requireAliases.add(varName)
                        } else if (ts.isPropertyAccessExpression(init)) {
                            const obj = unwrapExpr(init.expression)
                            const prop = init.name.text
                            if (ts.isIdentifier(obj) && globalAliases.has(obj.text)) {
                                if (['electronBridge', 'cpa', 'cpaHostTransport'].includes(prop)) {
                                    bridgeAliases.add(varName)
                                }
                            }
                        } else if (ts.isElementAccessExpression(init)) {
                            const obj = unwrapExpr(init.expression)
                            const prop = evaluateStaticString(init.argumentExpression)
                            if (ts.isIdentifier(obj) && globalAliases.has(obj.text)) {
                                if (['electronBridge', 'cpa', 'cpaHostTransport'].includes(prop)) {
                                    bridgeAliases.add(varName)
                                }
                            }
                        }
                    }

                    // Case B: const { electronBridge: b, cpa: c } = window / globalThis
                    if (ts.isObjectBindingPattern(node.name)) {
                        const initId = ts.isIdentifier(init) ? init.text : null
                        if (initId && globalAliases.has(initId)) {
                            for (const element of node.name.elements) {
                                if (ts.isBindingElement(element)) {
                                    const propName = element.propertyName && ts.isIdentifier(element.propertyName)
                                        ? element.propertyName.text
                                        : (ts.isIdentifier(element.name) ? element.name.text : null)
                                    const boundName = ts.isIdentifier(element.name) ? element.name.text : null
                                    if (['electronBridge', 'cpa', 'cpaHostTransport'].includes(propName)) {
                                        if (boundName) bridgeAliases.add(boundName)
                                    }
                                }
                            }
                        }
                    }
                }

                // Assignments: b = window.electronBridge
                if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
                    const left = unwrapExpr(node.left)
                    const right = unwrapExpr(node.right)
                    if (ts.isIdentifier(left)) {
                        if (ts.isIdentifier(right)) {
                            if (globalAliases.has(right.text)) globalAliases.add(left.text)
                            if (bridgeAliases.has(right.text)) bridgeAliases.add(left.text)
                            if (requireAliases.has(right.text)) requireAliases.add(left.text)
                        } else if (ts.isPropertyAccessExpression(right)) {
                            const obj = unwrapExpr(right.expression)
                            const prop = right.name.text
                            if (ts.isIdentifier(obj) && globalAliases.has(obj.text) && ['electronBridge', 'cpa', 'cpaHostTransport'].includes(prop)) {
                                bridgeAliases.add(left.text)
                            }
                        }
                    }
                }

                ts.forEachChild(node, pass1)
            }

            pass1(sourceFile)

            // Pass 2: check all direct native accesses, aliases, dynamic imports, requires, evals
            function checkDirectNative(node) {
                // Property access: target.prop or target?.prop
                if (ts.isPropertyAccessExpression(node)) {
                    const unwrappedExpr = unwrapExpr(node.expression)
                    const exprText = unwrappedExpr.getText(sourceFile)
                    const prop = node.name.text

                    if (globalAliases.has(exprText) && ['electronBridge', 'cpa', 'cpaHostTransport'].includes(prop)) {
                        const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
                        directNativeAccess.push({
                            category: 'directNativeAccess',
                            file: relFile,
                            line: line + 1,
                            col: character + 1,
                            pluginId: fileInfo.pluginId,
                            message: `Direct native access forbidden in plugin: "${exprText}.${prop}". Use context.capabilities instead.`,
                            snippet: node.getText(sourceFile),
                        })
                    } else if (bridgeAliases.has(exprText)) {
                        const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
                        directNativeAccess.push({
                            category: 'directNativeAccess',
                            file: relFile,
                            line: line + 1,
                            col: character + 1,
                            pluginId: fileInfo.pluginId,
                            message: `Direct native bridge alias access forbidden in plugin: "${exprText}.${prop}".`,
                            snippet: node.getText(sourceFile),
                        })
                    }
                }

                // Element access: target[index] or target?.[index]
                if (ts.isElementAccessExpression(node)) {
                    const unwrappedExpr = unwrapExpr(node.expression)
                    const exprText = unwrappedExpr.getText(sourceFile)

                    if (globalAliases.has(exprText)) {
                        const prop = evaluateStaticString(node.argumentExpression)
                        if (['electronBridge', 'cpa', 'cpaHostTransport'].includes(prop)) {
                            const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
                            directNativeAccess.push({
                                category: 'directNativeAccess',
                                file: relFile,
                                line: line + 1,
                                col: character + 1,
                                pluginId: fileInfo.pluginId,
                                message: `Direct computed native bridge access forbidden in plugin: "${exprText}['${prop}']".`,
                                snippet: node.getText(sourceFile),
                            })
                        } else if (prop === null) {
                            // Dynamic / unknown computed access on global object
                            const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
                            directNativeAccess.push({
                                category: 'directNativeAccess',
                                file: relFile,
                                line: line + 1,
                                col: character + 1,
                                pluginId: fileInfo.pluginId,
                                message: `Dynamic computed property access on global object "${exprText}" forbidden in plugin.`,
                                snippet: node.getText(sourceFile),
                            })
                        }
                    } else if (bridgeAliases.has(exprText)) {
                        const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
                        directNativeAccess.push({
                            category: 'directNativeAccess',
                            file: relFile,
                            line: line + 1,
                            col: character + 1,
                            pluginId: fileInfo.pluginId,
                            message: `Direct computed native bridge alias access forbidden in plugin: "${exprText}[...]".`,
                            snippet: node.getText(sourceFile),
                        })
                    }
                }

                // Destructuring declaration: const { electronBridge: b } = window
                if (ts.isVariableDeclaration(node) && node.initializer && ts.isObjectBindingPattern(node.name)) {
                    const unwrappedInit = unwrapExpr(node.initializer)
                    const initText = unwrappedInit.getText(sourceFile)
                    if (globalAliases.has(initText)) {
                        for (const element of node.name.elements) {
                            if (ts.isBindingElement(element)) {
                                const propName = element.propertyName && ts.isIdentifier(element.propertyName)
                                    ? element.propertyName.text
                                    : (ts.isIdentifier(element.name) ? element.name.text : null)
                                const boundName = ts.isIdentifier(element.name) ? element.name.text : null
                                if (['electronBridge', 'cpa', 'cpaHostTransport'].includes(propName)) {
                                    const { line, character } = sourceFile.getLineAndCharacterOfPosition(element.getStart(sourceFile))
                                    directNativeAccess.push({
                                        category: 'directNativeAccess',
                                        file: relFile,
                                        line: line + 1,
                                        col: character + 1,
                                        pluginId: fileInfo.pluginId,
                                        message: `Destructuring native bridge "${propName}" (as "${boundName}") from global forbidden in plugin.`,
                                        snippet: node.getText(sourceFile),
                                    })
                                }
                            }
                        }
                    }
                }

                // Calls: eval, require, process.getBuiltinModule, new Function, bridge call
                if (ts.isCallExpression(node)) {
                    const calleeExpr = unwrapExpr(node.expression)
                    const calleeText = calleeExpr.getText(sourceFile)

                    if (calleeText === 'eval' || calleeText.endsWith('.eval')) {
                        const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
                        directNativeAccess.push({
                            category: 'directNativeAccess',
                            file: relFile,
                            line: line + 1,
                            col: character + 1,
                            pluginId: fileInfo.pluginId,
                            message: `Forbidden eval() call in plugin.`,
                            snippet: node.getText(sourceFile),
                        })
                    } else if (calleeText.includes('getBuiltinModule')) {
                        const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
                        directNativeAccess.push({
                            category: 'directNativeAccess',
                            file: relFile,
                            line: line + 1,
                            col: character + 1,
                            pluginId: fileInfo.pluginId,
                            message: `Forbidden process.getBuiltinModule() call in plugin.`,
                            snippet: node.getText(sourceFile),
                        })
                    } else if (requireAliases.has(calleeText) || calleeText === 'require') {
                        const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
                        directNativeAccess.push({
                            category: 'directNativeAccess',
                            file: relFile,
                            line: line + 1,
                            col: character + 1,
                            pluginId: fileInfo.pluginId,
                            message: `Forbidden require() call in plugin.`,
                            snippet: node.getText(sourceFile),
                        })
                    } else if (calleeText === 'Function') {
                        const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
                        directNativeAccess.push({
                            category: 'directNativeAccess',
                            file: relFile,
                            line: line + 1,
                            col: character + 1,
                            pluginId: fileInfo.pluginId,
                            message: `Forbidden Function constructor in plugin.`,
                            snippet: node.getText(sourceFile),
                        })
                    }

                    // Dynamic import: import(...)
                    const isDynamicImport = calleeExpr.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(calleeExpr) && calleeExpr.text === 'import')
                    if (isDynamicImport && node.arguments.length > 0) {
                        const arg = unwrapExpr(node.arguments[0])
                        const str = evaluateStaticString(arg)
                        if (str === null) {
                            const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
                            directNativeAccess.push({
                                category: 'directNativeAccess',
                                file: relFile,
                                line: line + 1,
                                col: character + 1,
                                pluginId: fileInfo.pluginId,
                                message: `Dynamic import with expression forbidden in plugin.`,
                                snippet: node.getText(sourceFile),
                            })
                        } else {
                            if (!str.startsWith('./') && !str.startsWith('../') && !ALLOWED_PLUGIN_PACKAGES.has(str)) {
                                const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
                                directNativeAccess.push({
                                    category: 'directNativeAccess',
                                    file: relFile,
                                    line: line + 1,
                                    col: character + 1,
                                    pluginId: fileInfo.pluginId,
                                    message: `Forbidden dynamic import of package "${str}" in plugin.`,
                                    snippet: node.getText(sourceFile),
                                })
                            }
                        }
                    }
                }

                // New expressions: new Function(...)
                if (ts.isNewExpression(node)) {
                    const calleeText = unwrapExpr(node.expression).getText(sourceFile)
                    if (calleeText === 'Function') {
                        const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
                        directNativeAccess.push({
                            category: 'directNativeAccess',
                            file: relFile,
                            line: line + 1,
                            col: character + 1,
                            pluginId: fileInfo.pluginId,
                            message: `Forbidden new Function() constructor in plugin.`,
                            snippet: node.getText(sourceFile),
                        })
                    }
                }

                // Forbidden imports in plugins
                if (ts.isImportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
                    const spec = node.moduleSpecifier.text
                    const isTypeOnly = Boolean(node.importClause?.isTypeOnly)
                    if (!isTypeOnly) {
                        if (spec === 'electron' || spec.startsWith('electron/')) {
                            const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
                            directNativeAccess.push({
                                category: 'directNativeAccess',
                                file: relFile,
                                line: line + 1,
                                col: character + 1,
                                pluginId: fileInfo.pluginId,
                                message: `Forbidden import "${spec}" in plugin. Direct electron access is forbidden.`,
                                snippet: node.getText(sourceFile),
                            })
                        }
                        if (
                            (relFile.includes('/renderer/') || relFile.includes('/agent/')) &&
                            (spec === 'fs' || spec === 'node:fs' || spec === 'child_process' || spec === 'node:child_process')
                        ) {
                            const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
                            directNativeAccess.push({
                                category: 'directNativeAccess',
                                file: relFile,
                                line: line + 1,
                                col: character + 1,
                                pluginId: fileInfo.pluginId,
                                message: `Forbidden direct Node.js builtin import "${spec}" in renderer/agent plugin. Use context.capabilities instead.`,
                                snippet: node.getText(sourceFile),
                            })
                        }
                    }
                }

                ts.forEachChild(node, checkDirectNative)
            }
            checkDirectNative(sourceFile)
        }

        // 2. Hardcoded Contribution & Plugin IDs in Host Shell / Runtime (Dataflow & Constant Tracking)
        const isHostScannable = isFixtureRoot
            ? !fileInfo.isPlugin && !fileInfo.isTest
            : (
                relFile.startsWith('frontend/src/app/') ||
                relFile.startsWith('frontend/src/components/layout/') ||
                relFile.startsWith('frontend/src/components/settings/') ||
                relFile.startsWith('frontend/src/components/subagent/') ||
                relFile.startsWith('frontend/src/application/views/') ||
                relFile.startsWith('frontend/src/application/actions/') ||
                relFile.startsWith('frontend/src/application/navigation/')
            ) &&
            !fileInfo.isGeneratedLoader &&
            !fileInfo.isTest &&
            !relFile.includes('frontend/src/i18n/') &&
            !relFile.includes('src/shared/shortcuts.ts') &&
            !relFile.includes('frontend/src/application/services/tokens.ts')

        if (isHostScannable) {
            const constVarMap = new Map()
            const constObjMap = new Map()
            const constArrMap = new Map()

            // Pass 1: collect host constants, object maps, array lists
            function pass1Host(node) {
                if (ts.isVariableDeclaration(node) && node.initializer && ts.isIdentifier(node.name)) {
                    const varName = node.name.text
                    const init = unwrapExpr(node.initializer)
                    const str = evaluateStaticString(init)
                    if (str !== null) {
                        constVarMap.set(varName, str)
                    } else if (ts.isObjectLiteralExpression(init)) {
                        const obj = new Map()
                        for (const prop of init.properties) {
                            if (ts.isPropertyAssignment(prop) && prop.name) {
                                const pName = ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name) ? prop.name.text : null
                                const pVal = evaluateStaticString(prop.initializer)
                                if (pName && pVal !== null) obj.set(pName, pVal)
                            }
                        }
                        constObjMap.set(varName, obj)
                    } else if (ts.isArrayLiteralExpression(init)) {
                        const arr = []
                        for (const el of init.elements) {
                            const s = evaluateStaticString(el)
                            if (s !== null) arr.push(s)
                        }
                        constArrMap.set(varName, arr)
                    }
                }
                ts.forEachChild(node, pass1Host)
            }

            pass1Host(sourceFile)

            function resolveDataflowValue(exprNode) {
                if (!exprNode) return null
                const unwrapped = unwrapExpr(exprNode)
                const str = evaluateStaticString(unwrapped)
                if (str !== null) return str

                if (ts.isIdentifier(unwrapped)) {
                    if (constVarMap.has(unwrapped.text)) return constVarMap.get(unwrapped.text)
                }

                if (ts.isPropertyAccessExpression(unwrapped)) {
                    const obj = unwrapExpr(unwrapped.expression)
                    const prop = unwrapped.name.text
                    if (ts.isIdentifier(obj) && constObjMap.has(obj.text)) {
                        const m = constObjMap.get(obj.text)
                        if (m.has(prop)) return m.get(prop)
                    }
                }

                if (ts.isElementAccessExpression(unwrapped)) {
                    const obj = unwrapExpr(unwrapped.expression)
                    const prop = evaluateStaticString(unwrapped.argumentExpression)
                    if (ts.isIdentifier(obj) && constObjMap.has(obj.text) && prop !== null) {
                        const m = constObjMap.get(obj.text)
                        if (m.has(prop)) return m.get(prop)
                    }
                }

                return null
            }

            function checkHardcodedIds(node) {
                // Direct String Literal matching
                if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
                    const text = node.text
                    if (allPluginIds.has(text) || uiContributionIds.has(text)) {
                        const parent = node.parent
                        let isHardcodedUsage = false
                        let reason = ''

                        if (allPluginIds.has(text) && !isFixtureRoot) {
                            isHardcodedUsage = true
                            reason = `Hardcoded plugin ID "${text}" in host file.`
                        } else if (
                            uiContributionIds.has(text) &&
                            ts.isBinaryExpression(parent) &&
                            (parent.left === node || parent.right === node) &&
                            [
                                ts.SyntaxKind.EqualsEqualsEqualsToken,
                                ts.SyntaxKind.ExclamationEqualsEqualsToken,
                                ts.SyntaxKind.EqualsEqualsToken,
                                ts.SyntaxKind.ExclamationEqualsToken,
                            ].includes(parent.operatorToken.kind)
                        ) {
                            isHardcodedUsage = true
                            reason = `Host compares against specific contribution ID "${text}".`
                        } else if (uiContributionIds.has(text) && ts.isCaseClause(parent) && parent.expression === node) {
                            isHardcodedUsage = true
                            reason = `Host switches on specific contribution ID "${text}".`
                        } else if (uiContributionIds.has(text) && ts.isCallExpression(parent) && parent.arguments.includes(node)) {
                            const calleeExpr = unwrapExpr(parent.expression)
                            const callee = calleeExpr.getText(sourceFile)
                            if (
                                callee.endsWith('.get') ||
                                callee.endsWith('.has') ||
                                callee.endsWith('.open') ||
                                callee.endsWith('.select') ||
                                callee.includes('executeAction') ||
                                callee.includes('openView') ||
                                callee.includes('openPanel') ||
                                callee.includes('openRightPanelTab')
                            ) {
                                isHardcodedUsage = true
                                reason = `Host looks up or executes specific contribution ID "${text}" via "${callee}".`
                            }
                        }

                        if (isHardcodedUsage) {
                            const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
                            hardcodedContributionIds.push({
                                category: 'hardcodedContributionIds',
                                file: relFile,
                                line: line + 1,
                                col: character + 1,
                                contributionId: text,
                                pluginId: text,
                                message: reason,
                                snippet: parent?.getText(sourceFile) || node.getText(sourceFile),
                            })
                        }
                    }
                }

                // Dataflow Binary Comparisons: currentView === TARGET_VIEW_ID
                if (
                    ts.isBinaryExpression(node) &&
                    [
                        ts.SyntaxKind.EqualsEqualsEqualsToken,
                        ts.SyntaxKind.ExclamationEqualsEqualsToken,
                        ts.SyntaxKind.EqualsEqualsToken,
                        ts.SyntaxKind.ExclamationEqualsToken,
                    ].includes(node.operatorToken.kind)
                ) {
                    const leftVal = resolveDataflowValue(node.left)
                    const rightVal = resolveDataflowValue(node.right)
                    const targetVal = uiContributionIds.has(leftVal) ? leftVal : (uiContributionIds.has(rightVal) ? rightVal : null)

                    if (targetVal) {
                        const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
                        hardcodedContributionIds.push({
                            category: 'hardcodedContributionIds',
                            file: relFile,
                            line: line + 1,
                            col: character + 1,
                            contributionId: targetVal,
                            pluginId: targetVal,
                            message: `Host compares against specific contribution ID "${targetVal}" via dataflow variable.`,
                            snippet: node.getText(sourceFile),
                        })
                    }
                }

                // Dataflow Switch Cases: case TARGET_ID:
                if (ts.isCaseClause(node)) {
                    const val = resolveDataflowValue(node.expression)
                    if (val && uiContributionIds.has(val)) {
                        const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
                        hardcodedContributionIds.push({
                            category: 'hardcodedContributionIds',
                            file: relFile,
                            line: line + 1,
                            col: character + 1,
                            contributionId: val,
                            pluginId: val,
                            message: `Host switches on specific contribution ID "${val}" via dataflow variable.`,
                            snippet: node.getText(sourceFile),
                        })
                    }
                }

                // Dataflow Call Expressions: registry.get(TARGET_VIEW_ID) or PANELS.includes(currentView)
                if (ts.isCallExpression(node)) {
                    const calleeExpr = unwrapExpr(node.expression)
                    const callee = calleeExpr.getText(sourceFile)

                    // Registry lookups with dataflow args
                    if (
                        callee.endsWith('.get') ||
                        callee.endsWith('.has') ||
                        callee.endsWith('.open') ||
                        callee.endsWith('.select') ||
                        callee.includes('executeAction') ||
                        callee.includes('openView') ||
                        callee.includes('openPanel') ||
                        callee.includes('openRightPanelTab')
                    ) {
                        for (const arg of node.arguments) {
                            const val = resolveDataflowValue(arg)
                            if (val && (uiContributionIds.has(val) || allPluginIds.has(val))) {
                                const { line, character } = sourceFile.getLineAndCharacterOfPosition(arg.getStart(sourceFile))
                                hardcodedContributionIds.push({
                                    category: 'hardcodedContributionIds',
                                    file: relFile,
                                    line: line + 1,
                                    col: character + 1,
                                    contributionId: val,
                                    pluginId: val,
                                    message: `Host looks up or executes contribution ID "${val}" via dataflow variable and "${callee}".`,
                                    snippet: node.getText(sourceFile),
                                })
                            }
                        }
                    }

                    // Array .includes() check: PANELS.includes(viewId)
                    if (ts.isPropertyAccessExpression(calleeExpr) && (calleeExpr.name.text === 'includes' || calleeExpr.name.text === 'indexOf')) {
                        const arrExpr = unwrapExpr(calleeExpr.expression)
                        if (ts.isIdentifier(arrExpr) && constArrMap.has(arrExpr.text)) {
                            const items = constArrMap.get(arrExpr.text)
                            const matchedId = items.find((item) => uiContributionIds.has(item) || allPluginIds.has(item))
                            if (matchedId) {
                                const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
                                hardcodedContributionIds.push({
                                    category: 'hardcodedContributionIds',
                                    file: relFile,
                                    line: line + 1,
                                    col: character + 1,
                                    contributionId: matchedId,
                                    pluginId: matchedId,
                                    message: `Host checks collection containing hardcoded contribution ID "${matchedId}" via "${callee}".`,
                                    snippet: node.getText(sourceFile),
                                })
                            }
                        }
                    }
                }

                ts.forEachChild(node, checkHardcodedIds)
            }
            checkHardcodedIds(sourceFile)
        }

        // 3. Store Effects & Purity Checks
        if (fileInfo.isStore) {
            function checkStoreEffects(node) {
                // Check forbidden imports
                if (ts.isImportDeclaration(node)) {
                    let isTypeOnly = Boolean(node.importClause?.isTypeOnly)
                    if (!isTypeOnly && node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)) {
                        const elements = node.importClause.namedBindings.elements
                        if (elements.length > 0 && elements.every((el) => Boolean(el.isTypeOnly))) {
                            isTypeOnly = true
                        }
                    }

                    if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
                        const spec = node.moduleSpecifier.text

                        // Non-type @cpa/plugin-api import
                        if (!isTypeOnly && spec === '@cpa/plugin-api') {
                            const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
                            storeEffects.push({
                                category: 'storeEffects',
                                file: relFile,
                                line: line + 1,
                                col: character + 1,
                                message: `Store has forbidden non-type import from "${spec}". Stores must import types only.`,
                                snippet: node.getText(sourceFile),
                            })
                        }

                        if (!isTypeOnly) {
                            for (const pat of FORBIDDEN_STORE_IMPORT_PATTERNS) {
                                if (pat.test(spec)) {
                                    const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
                                    storeEffects.push({
                                        category: 'storeEffects',
                                        file: relFile,
                                        line: line + 1,
                                        col: character + 1,
                                        message: `Store has forbidden import "${spec}". Stores must be pure state containers.`,
                                        snippet: node.getText(sourceFile),
                                    })
                                }
                            }
                        }
                    }
                }

                // Check window / bridge / location / localStorage / sessionStorage access
                if (ts.isPropertyAccessExpression(node)) {
                    const unwrappedExpr = unwrapExpr(node.expression)
                    const exprText = unwrappedExpr.getText(sourceFile)
                    const prop = node.name.text
                    if (
                        ['window', 'globalThis', 'self'].includes(exprText) &&
                        ['electronBridge', 'cpa', 'cpaHostTransport', 'location', 'localStorage', 'sessionStorage', 'indexedDB'].includes(prop)
                    ) {
                        const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
                        storeEffects.push({
                            category: 'storeEffects',
                            file: relFile,
                            line: line + 1,
                            col: character + 1,
                            message: `Store performs forbidden property access "${exprText}.${prop}".`,
                            snippet: node.getText(sourceFile),
                        })
                    }
                    if (exprText === 'window.electronBridge' || exprText === 'window.cpa' || exprText === 'window.cpaHostTransport' || exprText === 'globalThis.electronBridge') {
                        const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
                        storeEffects.push({
                            category: 'storeEffects',
                            file: relFile,
                            line: line + 1,
                            col: character + 1,
                            message: `Store performs forbidden bridge access "${exprText}.${prop}".`,
                            snippet: node.getText(sourceFile),
                        })
                    }
                }

                // Check direct fetch / async network / timers / storage / host services calls
                if (ts.isCallExpression(node)) {
                    const calleeExpr = unwrapExpr(node.expression)
                    const callee = calleeExpr.getText(sourceFile)
                    if (
                        callee === 'fetch' ||
                        callee === 'window.fetch' ||
                        callee === 'setTimeout' ||
                        callee === 'setInterval' ||
                        callee === 'setImmediate' ||
                        callee === 'clearTimeout' ||
                        callee === 'clearInterval' ||
                        callee === 'getDefaultHostServices' ||
                        callee === 'useHostServices'
                    ) {
                        const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
                        storeEffects.push({
                            category: 'storeEffects',
                            file: relFile,
                            line: line + 1,
                            col: character + 1,
                            message: `Store performs forbidden operation "${callee}". Stores must be pure state containers.`,
                            snippet: node.getText(sourceFile),
                        })
                    }
                }

                // Check direct storage identifiers
                if (ts.isIdentifier(node) && ['localStorage', 'sessionStorage', 'indexedDB'].includes(node.text)) {
                    const parent = node.parent
                    if (!ts.isTypeNode(parent) && !ts.isImportClause(parent) && !ts.isImportSpecifier(parent)) {
                        if (ts.isPropertyAccessExpression(parent) && parent.expression === node) {
                            const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
                            storeEffects.push({
                                category: 'storeEffects',
                                file: relFile,
                                line: line + 1,
                                col: character + 1,
                                message: `Store performs forbidden storage access "${node.text}".`,
                                snippet: parent.getText(sourceFile),
                            })
                        }
                    }
                }

                ts.forEachChild(node, checkStoreEffects)
            }
            checkStoreEffects(sourceFile)
        }

        // 4. Legacy APIs & Patterns in production code
        if (!fileInfo.isTest) {
            function checkLegacyPatterns(node) {
                if (ts.isCallExpression(node)) {
                    const calleeExpr = unwrapExpr(node.expression)
                    const callee = calleeExpr.getText(sourceFile)
                    if (callee === 'definePlugin' || callee.endsWith('.definePlugin')) {
                        const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
                        legacyPaths.push({
                            category: 'legacyPaths',
                            file: relFile,
                            line: line + 1,
                            col: character + 1,
                            message: 'Deprecated "definePlugin" called. Use "definePluginEntry" from @cpa/plugin-sdk instead.',
                            snippet: node.getText(sourceFile),
                        })
                    }
                }

                if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
                    if (node.text === 'fallback-protocol-session') {
                        const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
                        legacyPaths.push({
                            category: 'legacyPaths',
                            file: relFile,
                            line: line + 1,
                            col: character + 1,
                            message: 'Legacy fallback symbol "fallback-protocol-session" referenced in production code.',
                            snippet: node.parent?.getText(sourceFile) || node.getText(sourceFile),
                        })
                    }
                }

                ts.forEachChild(node, checkLegacyPatterns)
            }
            checkLegacyPatterns(sourceFile)
        }

        // 5. Imports & Graph edges
        for (const { specifier, line, col, isTypeOnly } of fileImports) {
            const resolved = resolveImport(specifier, file, targetRoot, repoRoot)
            if (!resolved) continue

            const relTarget = path.relative(repoRoot, resolved).replace(/\\/g, '/')

            // Add edge to dependency graph if in file set (and not type-only)
            if (fileSet.has(resolved) && !isTypeOnly) {
                const neighbors = graph.get(relFile) || []
                neighbors.push(relTarget)
                graph.set(relFile, neighbors)
            }

            const targetInfo = classifyFile(resolved, repoRoot, isFixtureRoot)

            // 1. Host imports Plugin violation (strictly: only isGeneratedLoader can import plugins)
            const isAllowedLoader = fileInfo.isGeneratedLoader
            if (!fileInfo.isPlugin && !isAllowedLoader && targetInfo.isPlugin) {
                hostImportsPlugin.push({
                    category: 'hostImportsPlugin',
                    file: relFile,
                    line,
                    col,
                    specifier,
                    target: relTarget,
                    pluginId: targetInfo.pluginId,
                    message: `Non-plugin module "${relFile}" directly imports plugin "${targetInfo.pluginId}". Only generated loaders are allowed to import bundled plugins.`,
                })
            }

            // 2. Cross-Plugin imports violation
            if (fileInfo.isPlugin && targetInfo.isPlugin && fileInfo.pluginId !== targetInfo.pluginId) {
                crossPluginImports.push({
                    category: 'crossPluginImports',
                    file: relFile,
                    line,
                    col,
                    specifier,
                    target: relTarget,
                    fromPlugin: fileInfo.pluginId,
                    toPlugin: targetInfo.pluginId,
                    message: `Plugin "${fileInfo.pluginId}" directly imports private implementation from plugin "${targetInfo.pluginId}".`,
                })
            }

            // 3. Private Host imports from Plugin violation
            if (fileInfo.isPlugin && targetInfo.isPrivateHost) {
                privateHostImports.push({
                    category: 'privateHostImports',
                    file: relFile,
                    line,
                    col,
                    specifier,
                    target: relTarget,
                    pluginId: fileInfo.pluginId,
                    message: `Plugin "${fileInfo.pluginId}" imports private host internal file "${relTarget}".`,
                })
            }
        }
    }

    // Calculate SCC cycles
    const cycles = findCycles(graph)

    const totalViolations =
        hostImportsPlugin.length +
        crossPluginImports.length +
        privateHostImports.length +
        directNativeAccess.length +
        hardcodedContributionIds.length +
        manifestContract.length +
        storeEffects.length +
        legacyPaths.length +
        cycles.length

    return {
        hostImportsPlugin,
        crossPluginImports,
        privateHostImports,
        directNativeAccess,
        hardcodedContributionIds,
        manifestContract,
        storeEffects,
        legacyPaths,
        cycles,
        summary: {
            filesScanned: files.length,
            totalImports,
            totalViolations,
            hostImportsPluginCount: hostImportsPlugin.length,
            crossPluginImportsCount: crossPluginImports.length,
            privateHostImportsCount: privateHostImports.length,
            directNativeAccessCount: directNativeAccess.length,
            hardcodedContributionIdsCount: hardcodedContributionIds.length,
            manifestContractCount: manifestContract.length,
            storeEffectsCount: storeEffects.length,
            legacyPathsCount: legacyPaths.length,
            cycleCount: cycles.length,
        },
    }
}

/**
 * Format report into human-readable CLI output.
 */
export function formatReport(report) {
    const {
        summary,
        hostImportsPlugin = [],
        crossPluginImports = [],
        privateHostImports = [],
        directNativeAccess = [],
        hardcodedContributionIds = [],
        manifestContract = [],
        storeEffects = [],
        legacyPaths = [],
        cycles = [],
    } = report

    const lines = []

    lines.push('===============================================================')
    lines.push('       Universal Plugin Platform - Architecture Scanner Report')
    lines.push('===============================================================')
    lines.push('')
    lines.push('SUMMARY:')
    lines.push(`  Files Scanned:               ${summary.filesScanned}`)
    lines.push(`  Total Internal Imports:      ${summary.totalImports}`)
    lines.push(`  Total Violations:            ${summary.totalViolations}`)
    lines.push(`  Host -> Plugin Imports:      ${summary.hostImportsPluginCount}`)
    lines.push(`  Cross-Plugin Imports:        ${summary.crossPluginImportsCount}`)
    lines.push(`  Private Host Imports:        ${summary.privateHostImportsCount}`)
    lines.push(`  Direct Native / Window:      ${summary.directNativeAccessCount}`)
    lines.push(`  Hardcoded Contribution IDs:  ${summary.hardcodedContributionIdsCount}`)
    lines.push(`  Manifest Contract Errors:    ${summary.manifestContractCount}`)
    lines.push(`  Store Side Effects:          ${summary.storeEffectsCount}`)
    lines.push(`  Legacy Paths / Symbols:      ${summary.legacyPathsCount}`)
    lines.push(`  Circular Dependency Cycles:  ${summary.cycleCount}`)
    lines.push('')

    if (hostImportsPlugin.length > 0) {
        lines.push('--- [1] Host -> Plugin Imports ---')
        for (const item of hostImportsPlugin.slice(0, 20)) {
            lines.push(`  ${item.file}:${item.line}:${item.col} -> ${item.message}`)
        }
        if (hostImportsPlugin.length > 20) {
            lines.push(`  ... and ${hostImportsPlugin.length - 20} more`)
        }
        lines.push('')
    }

    if (crossPluginImports.length > 0) {
        lines.push('--- [2] Cross-Plugin Imports ---')
        for (const item of crossPluginImports.slice(0, 20)) {
            lines.push(`  ${item.file}:${item.line}:${item.col} -> ${item.message}`)
        }
        if (crossPluginImports.length > 20) {
            lines.push(`  ... and ${crossPluginImports.length - 20} more`)
        }
        lines.push('')
    }

    if (privateHostImports.length > 0) {
        lines.push('--- [3] Private Host Imports ---')
        for (const item of privateHostImports.slice(0, 20)) {
            lines.push(`  ${item.file}:${item.line}:${item.col} -> ${item.message}`)
        }
        if (privateHostImports.length > 20) {
            lines.push(`  ... and ${privateHostImports.length - 20} more`)
        }
        lines.push('')
    }

    if (directNativeAccess.length > 0) {
        lines.push('--- [4] Direct Native Access in Plugins ---')
        for (const item of directNativeAccess.slice(0, 20)) {
            lines.push(`  ${item.file}:${item.line}:${item.col} -> ${item.message}`)
        }
        if (directNativeAccess.length > 20) {
            lines.push(`  ... and ${directNativeAccess.length - 20} more`)
        }
        lines.push('')
    }

    if (hardcodedContributionIds.length > 0) {
        lines.push('--- [5] Hardcoded Contribution IDs in Host ---')
        for (const item of hardcodedContributionIds.slice(0, 20)) {
            lines.push(`  ${item.file}:${item.line}:${item.col} -> ${item.message}`)
        }
        if (hardcodedContributionIds.length > 20) {
            lines.push(`  ... and ${hardcodedContributionIds.length - 20} more`)
        }
        lines.push('')
    }

    if (manifestContract.length > 0) {
        lines.push('--- [6] Manifest Contract Violations ---')
        for (const item of manifestContract.slice(0, 20)) {
            lines.push(`  ${item.file}:${item.line}:${item.col} -> ${item.message}`)
        }
        if (manifestContract.length > 20) {
            lines.push(`  ... and ${manifestContract.length - 20} more`)
        }
        lines.push('')
    }

    if (storeEffects.length > 0) {
        lines.push('--- [7] Store Side Effect Violations ---')
        for (const item of storeEffects.slice(0, 20)) {
            lines.push(`  ${item.file}:${item.line}:${item.col} -> ${item.message}`)
        }
        if (storeEffects.length > 20) {
            lines.push(`  ... and ${storeEffects.length - 20} more`)
        }
        lines.push('')
    }

    if (legacyPaths.length > 0) {
        lines.push('--- [8] Legacy Paths & Deprecated Symbol Violations ---')
        for (const item of legacyPaths.slice(0, 20)) {
            lines.push(`  ${item.file}:${item.line}:${item.col} -> ${item.message}`)
        }
        if (legacyPaths.length > 20) {
            lines.push(`  ... and ${legacyPaths.length - 20} more`)
        }
        lines.push('')
    }

    if (cycles.length > 0) {
        lines.push('--- [9] Dependency Cycles (Tarjan SCC) ---')
        cycles.forEach((cycle, index) => {
            lines.push(`  Cycle #${index + 1} (${cycle.length} files):`)
            for (const f of cycle.slice(0, 10)) {
                lines.push(`    - ${f}`)
            }
            if (cycle.length > 10) {
                lines.push(`    ... and ${cycle.length - 10} more files`)
            }
        })
        lines.push('')
    }

    lines.push('===============================================================')
    return lines.join('\n')
}

/**
 * CLI Entry Point
 */
async function main() {
    const args = process.argv.slice(2)
    const isEnforce = args.includes('--enforce')
    const isJson = args.includes('--json')
    const rootArg = args.find((a) => !a.startsWith('--')) || '.'

    try {
        const report = await scanPluginArchitecture(rootArg)

        if (isJson) {
            console.log(JSON.stringify(report, null, 2))
        } else {
            console.log(formatReport(report))
        }

        if (isEnforce) {
            if (report.summary.totalViolations > 0) {
                console.error(`❌ ${report.summary.totalViolations} architecture boundary violations detected in enforce mode.`)
                process.exit(1)
            } else {
                console.log('✅ All architecture boundaries respected (0 violations).')
                process.exit(0)
            }
        }
    } catch (err) {
        console.error('Error running architecture scanner:', err)
        process.exit(1)
    }
}

// Run CLI if invoked directly
const currentFile = fileURLToPath(import.meta.url)
const entryFile = process.argv[1] ? path.resolve(process.argv[1]) : null
if (entryFile && (entryFile === currentFile || pathToFileURL(entryFile).href === import.meta.url)) {
    main()
}
