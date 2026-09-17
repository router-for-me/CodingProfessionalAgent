import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { findTargetArtifacts, publishReleaseArtifacts } from '../scripts/publish-release-artifacts.mjs'

describe('publishReleaseArtifacts', () => {
    let tempDir: string

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpa-publish-test-'))
    })

    afterEach(() => {
        if (fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true })
        }
    })

    describe('findTargetArtifacts', () => {
        it('identifies target distribution binaries and excludes metadata files', () => {
            fs.writeFileSync(path.join(tempDir, 'Coding-Professional-Agent-1.0.0-mac-aarch64.dmg'), 'dmg')
            fs.writeFileSync(path.join(tempDir, 'Coding-Professional-Agent-1.0.0-win-amd64.exe'), 'exe')
            fs.writeFileSync(path.join(tempDir, 'Coding-Professional-Agent-1.0.0-linux-amd64.AppImage'), 'appimage')
            fs.writeFileSync(path.join(tempDir, 'Coding-Professional-Agent-1.0.0-linux-amd64.tar.gz'), 'tar.gz')
            fs.writeFileSync(path.join(tempDir, 'Coding-Professional-Agent-1.0.0-mac-amd64.zip'), 'zip')
            fs.writeFileSync(path.join(tempDir, 'app-update-1.0.0.asar'), 'asar')

            // Metadata and non-distribution files
            fs.writeFileSync(path.join(tempDir, 'release-manifest.json'), '{}')
            fs.writeFileSync(path.join(tempDir, 'SHA256SUMS.txt'), 'sums')
            fs.writeFileSync(path.join(tempDir, 'latest-mac.yml'), 'yaml')
            fs.writeFileSync(path.join(tempDir, 'app.dmg.blockmap'), 'blockmap')
            fs.writeFileSync(path.join(tempDir, '.DS_Store'), 'ds')

            const artifacts = findTargetArtifacts(tempDir).sort()

            expect(artifacts).toEqual([
                'Coding-Professional-Agent-1.0.0-linux-amd64.AppImage',
                'Coding-Professional-Agent-1.0.0-linux-amd64.tar.gz',
                'Coding-Professional-Agent-1.0.0-mac-aarch64.dmg',
                'Coding-Professional-Agent-1.0.0-mac-amd64.zip',
                'Coding-Professional-Agent-1.0.0-win-amd64.exe',
                'app-update-1.0.0.asar',
            ])
        })

        it('returns empty array when directory contains no target files or does not exist', () => {
            expect(findTargetArtifacts(path.join(tempDir, 'non-existent'))).toEqual([])

            fs.writeFileSync(path.join(tempDir, 'README.md'), 'readme')
            expect(findTargetArtifacts(tempDir)).toEqual([])
        })
    })

    describe('publishReleaseArtifacts execution', () => {
        it('returns empty array and null manifest when no target artifacts exist', async () => {
            const result = await publishReleaseArtifacts({
                tag: 'v1.0.0',
                artifactsDir: tempDir,
            })

            expect(result.uploaded).toEqual([])
            expect(result.manifest).toBeNull()
        })
    })
})
