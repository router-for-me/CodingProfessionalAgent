import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import ts from 'typescript'

export interface StoreEffectsReport {
    scannedFiles: string[]
    ioImports: string[]
    windowAccess: string[]
    asyncIoActions: string[]
}

const FORBIDDEN_IMPORT_PATTERNS = [
    /electronBridge/i,
    /ElectronNativeBridge/i,
    /@\/features\/agent-runtime\/native/i,
    /@\/features\/agent-runtime\/hooks\/discovery/i,
    /@\/lib\/worktreeManager/i,
    /@\/lib\/environmentRunner/i,
    /@\/plugins\/platform/i,
    /@cpa\/plugin-kernel/i,
    /node:fs/i,
    /node:child_process/i,
    /node:http/i,
    /node:https/i,
]

export function scanStoreEffects(storesDirectory: string): StoreEffectsReport {
    const report: StoreEffectsReport = {
        scannedFiles: [],
        ioImports: [],
        windowAccess: [],
        asyncIoActions: [],
    }

    if (!fs.existsSync(storesDirectory)) {
        return report
    }

    const entries = fs.readdirSync(storesDirectory)
    const storeFiles = entries.filter(
        (file) =>
            (file.endsWith('.ts') || file.endsWith('.tsx')) &&
            !file.endsWith('.test.ts') &&
            !file.endsWith('.test.tsx') &&
            !file.endsWith('.spec.ts') &&
            !file.endsWith('.spec.tsx') &&
            !file.endsWith('.d.ts'),
    )

    for (const fileName of storeFiles) {
        const filePath = path.join(storesDirectory, fileName)
        report.scannedFiles.push(fileName)
        const sourceCode = fs.readFileSync(filePath, 'utf-8')
        const sourceFile = ts.createSourceFile(
            fileName,
            sourceCode,
            ts.ScriptTarget.Latest,
            true,
        )

        ts.forEachChild(sourceFile, function visit(node: ts.Node) {
            // Check imports (excluding type-only imports)
            if (ts.isImportDeclaration(node)) {
                const isTypeOnly = Boolean(node.importClause?.isTypeOnly)
                if (!isTypeOnly) {
                    const moduleSpecifier = node.moduleSpecifier
                    if (ts.isStringLiteral(moduleSpecifier)) {
                        const importPath = moduleSpecifier.text
                        for (const pattern of FORBIDDEN_IMPORT_PATTERNS) {
                            if (pattern.test(importPath)) {
                                report.ioImports.push(
                                    `${fileName}: forbidden import "${importPath}"`,
                                )
                            }
                        }
                    }
                }
            }

            // Check PropertyAccessExpression for window.electronBridge / window.cpa / window.location / electronBridge
            if (ts.isPropertyAccessExpression(node)) {
                const propName = node.name.text
                const expressionText = node.expression.getText(sourceFile)

                if (
                    expressionText === 'window' &&
                    ['electronBridge', 'cpa', 'location', 'localStorage'].includes(propName)
                ) {
                    report.windowAccess.push(
                        `${fileName}: forbidden property access "window.${propName}"`,
                    )
                }

                if (
                    expressionText === 'window.electronBridge' ||
                    expressionText === 'window.cpa'
                ) {
                    report.windowAccess.push(
                        `${fileName}: forbidden bridge access "${expressionText}.${propName}"`,
                    )
                }
            }

            // Check Identifier for direct electronBridge access
            if (ts.isIdentifier(node) && node.text === 'electronBridge') {
                const parent = node.parent
                if (
                    !ts.isPropertyAccessExpression(parent) ||
                    parent.name !== node
                ) {
                    report.windowAccess.push(
                        `${fileName}: direct reference to "electronBridge"`,
                    )
                }
            }

            // Check for fetch calls
            if (ts.isCallExpression(node)) {
                const callee = node.expression.getText(sourceFile)
                if (callee === 'fetch' || callee === 'window.fetch') {
                    report.ioImports.push(`${fileName}: call to "${callee}"`)
                }
            }

            ts.forEachChild(node, visit)
        })
    }

    return report
}

describe('Store Effects Boundary', () => {
    const storesDir = path.resolve(__dirname, '../../stores')

    it('keeps every Zustand store free of host transport and window access', () => {
        const report = scanStoreEffects(storesDir)
        expect(report.scannedFiles.length).toBeGreaterThan(0)
        expect(report.ioImports).toEqual([])
        expect(report.windowAccess).toEqual([])
        expect(report.asyncIoActions).toEqual([])
    })
})
