import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import * as crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { generateReleaseManifest } from '../scripts/generate-release-manifest.mjs'

describe('generateReleaseManifest', () => {
    let tempDir: string

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpa-manifest-test-'))
    })

    afterEach(() => {
        if (fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true })
        }
    })

    function createDummyFile(filename: string, content: string): { sha256: string; size: number } {
        const filePath = path.join(tempDir, filename)
        fs.writeFileSync(filePath, content, 'utf8')
        const buf = Buffer.from(content, 'utf8')
        return {
            sha256: crypto.createHash('sha256').update(buf).digest('hex'),
            size: buf.length,
        }
    }

    it('generates a complete release-manifest.json matching all platform assets', () => {
        const asarInfo = createDummyFile('app-update-1.2.3.asar', 'dummy asar content')
        const macArmInfo = createDummyFile('Coding-Professional-Agent-1.2.3-mac-aarch64.dmg', 'mac arm dmg')
        const macX64Info = createDummyFile('Coding-Professional-Agent-1.2.3-mac-amd64.dmg', 'mac x64 dmg')
        const winX64Info = createDummyFile('Coding-Professional-Agent-1.2.3-win-amd64.exe', 'win x64 exe')
        const winArmInfo = createDummyFile('Coding-Professional-Agent-1.2.3-win-arm64.exe', 'win arm exe')
        const linuxX64Info = createDummyFile('Coding-Professional-Agent-1.2.3-linux-amd64.AppImage', 'linux x64 appimage')
        const linuxArmInfo = createDummyFile('Coding-Professional-Agent-1.2.3-linux-aarch64.AppImage', 'linux arm appimage')

        // Files that should be ignored
        createDummyFile('SHA256SUMS.txt', 'checksums')
        createDummyFile('release-manifest.json', '{}')
        createDummyFile('latest-mac.yml', 'version: 1.2.3')
        createDummyFile('app.dmg.blockmap', 'blockmap data')
        fs.mkdirSync(path.join(tempDir, 'subfolder'))

        const manifest = generateReleaseManifest({
            tag: 'v1.2.3',
            repo: 'test-org/test-repo',
            assetsDir: tempDir,
        })

        expect(manifest.version).toBe('1.2.3')
        expect(manifest.releaseNotes).toBe('Release v1.2.3')
        expect(manifest.nativeRequirements).toEqual({
            electron: expect.any(String),
            modules: '149',
            minNativeBaseVersion: '1.0.0',
        })

        // Verify ASAR asset
        expect(manifest.asar).toEqual({
            filename: 'app-update-1.2.3.asar',
            url: 'https://github.com/test-org/test-repo/releases/download/v1.2.3/app-update-1.2.3.asar',
            sha256: asarInfo.sha256,
            size: asarInfo.size,
        })

        // Verify platform installers
        expect(manifest.installers).toBeDefined()
        expect(manifest.installers?.['darwin-arm64']).toEqual({
            filename: 'Coding-Professional-Agent-1.2.3-mac-aarch64.dmg',
            url: 'https://github.com/test-org/test-repo/releases/download/v1.2.3/Coding-Professional-Agent-1.2.3-mac-aarch64.dmg',
            sha256: macArmInfo.sha256,
            size: macArmInfo.size,
        })
        expect(manifest.installers?.['darwin-x64']).toEqual({
            filename: 'Coding-Professional-Agent-1.2.3-mac-amd64.dmg',
            url: 'https://github.com/test-org/test-repo/releases/download/v1.2.3/Coding-Professional-Agent-1.2.3-mac-amd64.dmg',
            sha256: macX64Info.sha256,
            size: macX64Info.size,
        })
        expect(manifest.installers?.['win32-x64']).toEqual({
            filename: 'Coding-Professional-Agent-1.2.3-win-amd64.exe',
            url: 'https://github.com/test-org/test-repo/releases/download/v1.2.3/Coding-Professional-Agent-1.2.3-win-amd64.exe',
            sha256: winX64Info.sha256,
            size: winX64Info.size,
        })
        expect(manifest.installers?.['win32-arm64']).toEqual({
            filename: 'Coding-Professional-Agent-1.2.3-win-arm64.exe',
            url: 'https://github.com/test-org/test-repo/releases/download/v1.2.3/Coding-Professional-Agent-1.2.3-win-arm64.exe',
            sha256: winArmInfo.sha256,
            size: winArmInfo.size,
        })
        expect(manifest.installers?.['linux-x64']).toEqual({
            filename: 'Coding-Professional-Agent-1.2.3-linux-amd64.AppImage',
            url: 'https://github.com/test-org/test-repo/releases/download/v1.2.3/Coding-Professional-Agent-1.2.3-linux-amd64.AppImage',
            sha256: linuxX64Info.sha256,
            size: linuxX64Info.size,
        })
        expect(manifest.installers?.['linux-arm64']).toEqual({
            filename: 'Coding-Professional-Agent-1.2.3-linux-aarch64.AppImage',
            url: 'https://github.com/test-org/test-repo/releases/download/v1.2.3/Coding-Professional-Agent-1.2.3-linux-aarch64.AppImage',
            sha256: linuxArmInfo.sha256,
            size: linuxArmInfo.size,
        })

        // Verify output file was written to disk and is parseable
        const writtenContent = JSON.parse(fs.readFileSync(path.join(tempDir, 'release-manifest.json'), 'utf8'))
        expect(writtenContent).toEqual(manifest)
    })

    it('handles tags without leading v and fallback tar.gz for linux', () => {
        const tarInfo = createDummyFile('Coding-Professional-Agent-2.0.0-linux-amd64.tar.gz', 'linux tar gz')
        const manifest = generateReleaseManifest({
            tag: '2.0.0',
            repo: 'test-org/test-repo',
            assetsDir: tempDir,
        })

        expect(manifest.version).toBe('2.0.0')
        expect(manifest.releaseNotes).toBe('Release 2.0.0')
        expect(manifest.installers?.['linux-x64']).toEqual({
            filename: 'Coding-Professional-Agent-2.0.0-linux-amd64.tar.gz',
            url: 'https://github.com/test-org/test-repo/releases/download/2.0.0/Coding-Professional-Agent-2.0.0-linux-amd64.tar.gz',
            sha256: tarInfo.sha256,
            size: tarInfo.size,
        })
        expect(manifest.asar).toBeUndefined()
    })

    it('throws error when no release assets are detected in directory', () => {
        // Only ignored files present
        createDummyFile('SHA256SUMS.txt', 'checksums')
        createDummyFile('latest-mac.yml', 'version: 1.0.0')

        expect(() =>
            generateReleaseManifest({
                tag: 'v1.0.0',
                repo: 'test-org/test-repo',
                assetsDir: tempDir,
            }),
        ).toThrow('No release assets detected')
    })

    it('can be executed via CLI', () => {
        createDummyFile('app-update-1.0.0.asar', 'cli test asar')
        const scriptPath = path.resolve('scripts/generate-release-manifest.mjs')

        execFileSync('node', [scriptPath, 'v1.0.0', tempDir], {
            cwd: tempDir,
            encoding: 'utf8',
        })

        const manifestPath = path.join(tempDir, 'release-manifest.json')
        expect(fs.existsSync(manifestPath)).toBe(true)
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
        expect(manifest.version).toBe('1.0.0')
        expect(manifest.asar?.filename).toBe('app-update-1.0.0.asar')
    })
})
