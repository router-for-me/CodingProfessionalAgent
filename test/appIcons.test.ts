import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'
import { TRAY_TEMPLATE_1X_DATA_URL, TRAY_TEMPLATE_2X_DATA_URL } from '../src/main/services/trayService.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

describe('App and Tray icon paths', () => {
    it('verifies essential icon assets exist in the build directory', () => {
        const appIconPng = path.join(repoRoot, 'build/appicon.png')
        const darwinIcns = path.join(repoRoot, 'build/darwin/icons.icns')
        const trayTemplate = path.join(repoRoot, 'build/trayTemplate.png')
        const trayTemplate2x = path.join(repoRoot, 'build/trayTemplate@2x.png')

        expect(fs.existsSync(appIconPng)).toBe(true)
        expect(fs.statSync(appIconPng).size).toBeGreaterThan(0)

        expect(fs.existsSync(darwinIcns)).toBe(true)
        expect(fs.statSync(darwinIcns).size).toBeGreaterThan(0)

        expect(fs.existsSync(trayTemplate)).toBe(true)
        expect(fs.statSync(trayTemplate).size).toBeGreaterThan(0)

        expect(fs.existsSync(trayTemplate2x)).toBe(true)
        expect(fs.statSync(trayTemplate2x).size).toBeGreaterThan(0)
    })

    it('verifies tray template icons exist in frontend public directory for web and packaging redundancy', () => {
        const publicTray = path.join(repoRoot, 'frontend/public/trayTemplate.png')
        const publicTray2x = path.join(repoRoot, 'frontend/public/trayTemplate@2x.png')

        expect(fs.existsSync(publicTray)).toBe(true)
        expect(fs.statSync(publicTray).size).toBeGreaterThan(0)

        expect(fs.existsSync(publicTray2x)).toBe(true)
        expect(fs.statSync(publicTray2x).size).toBeGreaterThan(0)
    })

    it('verifies package.json build files configuration includes tray template and app icon assets', () => {
        const pkgPath = path.join(repoRoot, 'package.json')
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
        const files: string[] = pkg.build?.files || []

        expect(files.some((entry) => entry.includes('trayTemplate'))).toBe(true)
        expect(files.some((entry) => entry.includes('appicon'))).toBe(true)
    })

    it('verifies embedded fallback data URLs match the actual PNG binaries and are valid images', () => {
        const tray1xBinary = fs.readFileSync(path.join(repoRoot, 'build/trayTemplate.png'))
        const tray2xBinary = fs.readFileSync(path.join(repoRoot, 'build/trayTemplate@2x.png'))

        const prefix = 'data:image/png;base64,'
        expect(TRAY_TEMPLATE_1X_DATA_URL.startsWith(prefix)).toBe(true)
        expect(TRAY_TEMPLATE_2X_DATA_URL.startsWith(prefix)).toBe(true)

        const buf1x = Buffer.from(TRAY_TEMPLATE_1X_DATA_URL.slice(prefix.length), 'base64')
        const buf2x = Buffer.from(TRAY_TEMPLATE_2X_DATA_URL.slice(prefix.length), 'base64')

        expect(buf1x.equals(tray1xBinary)).toBe(true)
        expect(buf2x.equals(tray2xBinary)).toBe(true)

        // Verify valid PNG headers
        const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
        expect(buf1x.subarray(0, 8).equals(pngHeader)).toBe(true)
        expect(buf2x.subarray(0, 8).equals(pngHeader)).toBe(true)

        // Verify IDAT chunks decompress without corrupt data errors
        for (const buf of [buf1x, buf2x]) {
            let offset = 8
            let idatData = Buffer.alloc(0)
            while (offset < buf.length) {
                const len = buf.readUInt32BE(offset)
                const type = buf.subarray(offset + 4, offset + 8).toString('ascii')
                if (type === 'IDAT') {
                    idatData = Buffer.concat([idatData, buf.subarray(offset + 8, offset + 8 + len)])
                }
                offset += 12 + len
            }
            expect(idatData.length).toBeGreaterThan(0)
            const decompressed = zlib.inflateSync(idatData)
            expect(decompressed.length).toBeGreaterThan(0)
        }
    })

    it('verifies main process icon candidates resolve correctly from compiled directory', () => {
        const compiledMainDir = path.join(repoRoot, 'dist-electron/src/main')
        const appIconCandidates = [
            path.resolve(compiledMainDir, '../../../build/appicon.png'),
            path.resolve(compiledMainDir, '../../build/appicon.png'),
            path.resolve(repoRoot, 'build/appicon.png'),
        ]
        const resolvedAppIcon = appIconCandidates.find((p) => fs.existsSync(p))
        expect(resolvedAppIcon).toBeDefined()
        expect(resolvedAppIcon).toBe(path.join(repoRoot, 'build/appicon.png'))

        const compiledTrayDir = path.join(repoRoot, 'dist-electron/src/main/services')
        const trayCandidates = [
            path.resolve(compiledTrayDir, '../../../../build/trayTemplate.png'),
            path.resolve(compiledTrayDir, '../../../../build/trayTemplate@2x.png'),
            path.resolve(compiledTrayDir, '../../../build/trayTemplate.png'),
            path.resolve(compiledTrayDir, '../../../build/trayTemplate@2x.png'),
            path.resolve(repoRoot, 'build/trayTemplate.png'),
            path.resolve(repoRoot, 'build/trayTemplate@2x.png'),
        ]
        const resolvedTrayIcon = trayCandidates.find((p) => fs.existsSync(p))
        expect(resolvedTrayIcon).toBeDefined()
        expect(resolvedTrayIcon).toBe(path.join(repoRoot, 'build/trayTemplate.png'))
    })
})
