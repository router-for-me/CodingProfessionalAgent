export type UpdatePhase = 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'error'
export type UpdateType = 'hot' | 'full'

export interface NativeRequirements {
    electron: string
    modules: string
    minNativeBaseVersion: string
}

export interface AsarAsset {
    filename: string
    url: string
    sha256: string
    size: number
}

export interface InstallerAsset {
    filename: string
    url: string
    sha256: string
    size: number
}

export interface ReleaseManifest {
    version: string
    releaseDate: string
    releaseNotes: string
    nativeRequirements: NativeRequirements
    asar?: AsarAsset
    installers?: Record<string, InstallerAsset>
}

export interface UpdateState {
    activeVersion: string
    activeAsarPath: string | null
    baseBinaryVersion: string
    consecutiveFailures: number
    pendingVersion: string | null
    pendingAsarPath: string | null
    lastCheckTime: string | null
}

export interface DownloadProgress {
    percent: number
    transferredBytes: number
    totalBytes: number
    bytesPerSecond: number
}

export interface UpdateStatusSnapshot {
    phase: UpdatePhase
    currentVersion: string
    availableVersion?: string
    updateType?: UpdateType
    releaseNotes?: string
    releaseDate?: string
    downloadProgress?: DownloadProgress
    errorMessage?: string
}
