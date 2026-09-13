import semver from 'semver'
import type { ReleaseManifest, UpdateType } from '../../../shared/updateTypes.js'

export interface LocalEnvironment {
    electronVersion: string
    nodeAbiVersion: string
    baseBinaryVersion: string
    currentVersion: string
}

/**
 * Decides whether a release can be applied as an in-place ASAR hot update
 * or requires a full native installer package update.
 */
export function decideUpdateType(manifest: ReleaseManifest, localEnv: LocalEnvironment): UpdateType {
    // If no asar asset or download URL is available in release manifest, must perform full update
    if (!manifest.asar || !manifest.asar.url) {
        return 'full'
    }

    const req = manifest.nativeRequirements
    if (!req) {
        return 'full'
    }

    try {
        // 1. Electron major version must match
        const remoteElectronMajor = semver.major(req.electron || '0.0.0')
        const localElectronMajor = semver.major(localEnv.electronVersion || '0.0.0')
        if (remoteElectronMajor !== localElectronMajor) {
            return 'full'
        }

        // 2. Node module ABI must match if specified
        if (req.modules && req.modules !== localEnv.nodeAbiVersion) {
            return 'full'
        }

        // 3. Base binary version floor check: local binary must satisfy minNativeBaseVersion
        if (req.minNativeBaseVersion && semver.lt(localEnv.baseBinaryVersion, req.minNativeBaseVersion)) {
            return 'full'
        }

        return 'hot'
    } catch {
        // Any version parsing errors safely default to full update
        return 'full'
    }
}
