import { describe, it, expect } from 'vitest'
import { decideUpdateType, type LocalEnvironment } from '../../../../src/main/services/update/updateDecision.js'
import type { ReleaseManifest } from '../../../../src/shared/updateTypes.js'

describe('decideUpdateType', () => {
    const baseManifest: ReleaseManifest = {
        version: '1.1.0',
        releaseDate: '2026-09-15T00:00:00Z',
        releaseNotes: 'test notes',
        nativeRequirements: {
            electron: '44.0.0',
            modules: '130',
            minNativeBaseVersion: '1.0.0',
        },
        asar: {
            filename: 'app-update-1.1.0.asar',
            url: 'https://example.com/app.asar',
            sha256: 'abc',
            size: 1024,
        },
    }

    it('selects hot update when local environment satisfies all native requirements', () => {
        const localEnv: LocalEnvironment = {
            electronVersion: '44.0.0',
            nodeAbiVersion: '130',
            baseBinaryVersion: '1.0.0',
            currentVersion: '1.0.0',
        }

        const type = decideUpdateType(baseManifest, localEnv)
        expect(type).toBe('hot')
    })

    it('selects full update when electron version mismatches', () => {
        const localEnv: LocalEnvironment = {
            electronVersion: '43.0.0',
            nodeAbiVersion: '130',
            baseBinaryVersion: '1.0.0',
            currentVersion: '1.0.0',
        }

        const type = decideUpdateType(baseManifest, localEnv)
        expect(type).toBe('full')
    })

    it('selects full update when node ABI mismatches', () => {
        const localEnv: LocalEnvironment = {
            electronVersion: '44.0.0',
            nodeAbiVersion: '128',
            baseBinaryVersion: '1.0.0',
            currentVersion: '1.0.0',
        }

        const type = decideUpdateType(baseManifest, localEnv)
        expect(type).toBe('full')
    })

    it('selects full update when manifest lacks asar asset', () => {
        const noAsarManifest: ReleaseManifest = { ...baseManifest, asar: undefined }
        const localEnv: LocalEnvironment = {
            electronVersion: '44.0.0',
            nodeAbiVersion: '130',
            baseBinaryVersion: '1.0.0',
            currentVersion: '1.0.0',
        }

        const type = decideUpdateType(noAsarManifest, localEnv)
        expect(type).toBe('full')
    })

    it('selects full update when asar url is empty', () => {
        const emptyUrlManifest: ReleaseManifest = {
            ...baseManifest,
            asar: {
                filename: 'app.asar',
                url: '',
                sha256: 'abc',
                size: 1024,
            },
        }
        const localEnv: LocalEnvironment = {
            electronVersion: '44.0.0',
            nodeAbiVersion: '130',
            baseBinaryVersion: '1.0.0',
            currentVersion: '1.0.0',
        }

        const type = decideUpdateType(emptyUrlManifest, localEnv)
        expect(type).toBe('full')
    })

    it('selects full update when nativeRequirements is missing', () => {
        const noReqManifest = { ...baseManifest } as any
        delete noReqManifest.nativeRequirements

        const localEnv: LocalEnvironment = {
            electronVersion: '44.0.0',
            nodeAbiVersion: '130',
            baseBinaryVersion: '1.0.0',
            currentVersion: '1.0.0',
        }

        const type = decideUpdateType(noReqManifest, localEnv)
        expect(type).toBe('full')
    })

    it('selects full update when base binary version is less than minNativeBaseVersion', () => {
        const localEnv: LocalEnvironment = {
            electronVersion: '44.0.0',
            nodeAbiVersion: '130',
            baseBinaryVersion: '0.9.0',
            currentVersion: '1.0.0',
        }

        const type = decideUpdateType(baseManifest, localEnv)
        expect(type).toBe('full')
    })

    it('selects hot update when base binary version exceeds minNativeBaseVersion', () => {
        const localEnv: LocalEnvironment = {
            electronVersion: '44.0.0',
            nodeAbiVersion: '130',
            baseBinaryVersion: '1.2.0',
            currentVersion: '1.0.0',
        }

        const type = decideUpdateType(baseManifest, localEnv)
        expect(type).toBe('hot')
    })

    it('selects hot update when optional native requirement fields are omitted', () => {
        const minimalManifest: ReleaseManifest = {
            version: '1.1.0',
            releaseDate: '2026-09-15T00:00:00Z',
            releaseNotes: 'test notes',
            nativeRequirements: {
                electron: '44.0.0',
                modules: '',
                minNativeBaseVersion: '',
            },
            asar: {
                filename: 'app-update-1.1.0.asar',
                url: 'https://example.com/app.asar',
                sha256: 'abc',
                size: 1024,
            },
        }

        const localEnv: LocalEnvironment = {
            electronVersion: '44.2.0',
            nodeAbiVersion: '130',
            baseBinaryVersion: '1.0.0',
            currentVersion: '1.0.0',
        }

        const type = decideUpdateType(minimalManifest, localEnv)
        expect(type).toBe('hot')
    })

    it('handles malformed version strings gracefully and returns full', () => {
        const localEnv: LocalEnvironment = {
            electronVersion: 'invalid-semver',
            nodeAbiVersion: '130',
            baseBinaryVersion: 'invalid-version',
            currentVersion: '1.0.0',
        }

        const type = decideUpdateType(baseManifest, localEnv)
        expect(type).toBe('full')
    })
})
