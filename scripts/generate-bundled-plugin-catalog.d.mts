export interface BundledContractRealEntry {
    pluginId: string
    runtime: 'renderer' | 'main' | 'agent' | string
    path: string
}

export interface BundledContractLegacyEntry {
    pluginId: string
    runtime: 'renderer' | 'main' | 'agent' | string
    path: string
}

export interface BundledContractReport {
    pluginIds: string[]
    duplicatePluginIds: string[]
    realEntries: BundledContractRealEntry[]
    legacyEntries: BundledContractLegacyEntry[]
    unaccountedPluginIds: string[]
    manifestCopies: number
}

export interface VerifyGeneratedLoadersResult {
    ok: boolean
    issues: string[]
}

export interface DiscoveredBundledManifest {
    dirName: string
    manifest: any
}

export function getPluginVarName(pluginId: string): string
export function getPluginDirName(pluginId: string): string
export function findRealEntryFile(packageDir: string, entryRelPath: string): string | null
export function discoverBundledManifests(bundledDir?: string): DiscoveredBundledManifest[]
export function generateMainLoadersContent(manifests: DiscoveredBundledManifest[], options?: Record<string, unknown>): string
export function generateFrontendLoadersContent(manifests: DiscoveredBundledManifest[], options?: Record<string, unknown>): string
export function generateFixtureCatalog(manifests: any[], options?: Record<string, unknown>): any
export function scanBundledPluginContracts(repo?: string): Promise<BundledContractReport>
export function verifyGeneratedLoaders(repo?: string): VerifyGeneratedLoadersResult
