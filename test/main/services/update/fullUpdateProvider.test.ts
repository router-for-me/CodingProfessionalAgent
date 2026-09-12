import { describe, it, expect, beforeEach, vi } from 'vitest'
import * as path from 'node:path'
import { EventEmitter } from 'node:events'

const { mockShell } = vi.hoisted(() => ({
    mockShell: {
        openPath: vi.fn().mockResolvedValue(''),
    },
}))

vi.mock('electron', () => ({
    shell: mockShell,
}))

import { FullUpdateProvider } from '../../../../src/main/services/update/fullUpdateProvider.js'

describe('FullUpdateProvider', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mockShell.openPath.mockResolvedValue('')
    })

    describe('resolvePlatformKey', () => {
        it('resolves darwin platform keys correctly', () => {
            const providerArm = new FullUpdateProvider({ platform: 'darwin', arch: 'arm64' })
            expect(providerArm.resolvePlatformKey()).toBe('darwin-arm64')

            const providerX64 = new FullUpdateProvider({ platform: 'darwin', arch: 'x64' })
            expect(providerX64.resolvePlatformKey()).toBe('darwin-x64')
        })

        it('resolves win32 platform keys correctly', () => {
            const providerArm = new FullUpdateProvider({ platform: 'win32', arch: 'arm64' })
            expect(providerArm.resolvePlatformKey()).toBe('win32-arm64')

            const providerX64 = new FullUpdateProvider({ platform: 'win32', arch: 'x64' })
            expect(providerX64.resolvePlatformKey()).toBe('win32-x64')
        })

        it('resolves linux platform keys correctly', () => {
            const providerArm = new FullUpdateProvider({ platform: 'linux', arch: 'arm64' })
            expect(providerArm.resolvePlatformKey()).toBe('linux-arm64')

            const providerX64 = new FullUpdateProvider({ platform: 'linux', arch: 'x64' })
            expect(providerX64.resolvePlatformKey()).toBe('linux-x64')
        })

        it('falls back to current process platform and arch when no options are provided', () => {
            const provider = new FullUpdateProvider()
            const expectedArch = process.arch === 'arm64' ? 'arm64' : 'x64'
            const expectedPlatform = process.platform === 'darwin'
                ? `darwin-${expectedArch}`
                : process.platform === 'win32'
                    ? `win32-${expectedArch}`
                    : `linux-${expectedArch}`
            expect(provider.resolvePlatformKey()).toBe(expectedPlatform)
        })
    })

    describe('resolveInstaller', () => {
        it('returns undefined if manifest has no installers map', () => {
            const provider = new FullUpdateProvider({ platform: 'darwin', arch: 'arm64' })
            expect(provider.resolveInstaller({
                version: '1.2.0',
                releaseDate: '2026-09-15',
                releaseNotes: '',
                nativeRequirements: { electron: '44.0.0', modules: '130', minNativeBaseVersion: '1.0.0' },
            })).toBeUndefined()
        })

        it('returns matching installer asset for resolved platform key', () => {
            const provider = new FullUpdateProvider({ platform: 'darwin', arch: 'arm64' })
            const assetArm = {
                filename: 'Coding-Professional-Agent-1.2.0-mac-arm64.dmg',
                url: 'https://example.com/arm64.dmg',
                sha256: 'sha-arm',
                size: 2048,
            }
            const assetX64 = {
                filename: 'Coding-Professional-Agent-1.2.0-mac-x64.dmg',
                url: 'https://example.com/x64.dmg',
                sha256: 'sha-x64',
                size: 2048,
            }

            const manifest = {
                version: '1.2.0',
                releaseDate: '2026-09-15',
                releaseNotes: '',
                nativeRequirements: { electron: '44.0.0', modules: '130', minNativeBaseVersion: '1.0.0' },
                installers: {
                    'darwin-arm64': assetArm,
                    'darwin-x64': assetX64,
                },
            }

            expect(provider.resolveInstaller(manifest)).toEqual(assetArm)
        })

        it('returns undefined if matching platform key is not present in installers map', () => {
            const provider = new FullUpdateProvider({ platform: 'win32', arch: 'x64' })
            const manifest = {
                version: '1.2.0',
                releaseDate: '2026-09-15',
                releaseNotes: '',
                nativeRequirements: { electron: '44.0.0', modules: '130', minNativeBaseVersion: '1.0.0' },
                installers: {
                    'darwin-arm64': {
                        filename: 'dmg',
                        url: 'https://example.com/dmg',
                        sha256: 'sha',
                        size: 100,
                    },
                },
            }

            expect(provider.resolveInstaller(manifest)).toBeUndefined()
        })
    })

    describe('launchInstaller', () => {
        it('launches installer via shell.openPath on darwin using default openPath', async () => {
            const provider = new FullUpdateProvider({ platform: 'darwin' })
            const testPath = '/path/to/CodingProfessionalAgent.dmg'

            await provider.launchInstaller(testPath)

            expect(mockShell.openPath).toHaveBeenCalledWith(testPath)
        })

        it('launches installer via child_process.spawn on win32', async () => {
            const unrefMock = vi.fn()
            const emitter = new EventEmitter()
            const childMock = Object.assign(emitter, { unref: unrefMock })
            const spawnMock = vi.fn().mockImplementation(() => {
                queueMicrotask(() => emitter.emit('spawn'))
                return childMock
            })

            const provider = new FullUpdateProvider({
                platform: 'win32',
                spawn: spawnMock as any,
            })
            const testPath = 'C:\\path\\to\\Setup.exe'

            await provider.launchInstaller(testPath)

            expect(spawnMock).toHaveBeenCalledWith(testPath, [], {
                detached: true,
                stdio: 'ignore',
            })
            expect(unrefMock).toHaveBeenCalled()
        })

        it('rejects when child_process.spawn emits error on win32', async () => {
            const unrefMock = vi.fn()
            const emitter = new EventEmitter()
            const childMock = Object.assign(emitter, { unref: unrefMock })
            const spawnMock = vi.fn().mockImplementation(() => {
                queueMicrotask(() => emitter.emit('error', new Error('spawn ENOENT')))
                return childMock
            })

            const provider = new FullUpdateProvider({
                platform: 'win32',
                spawn: spawnMock as any,
            })
            const testPath = 'C:\\path\\to\\Setup.exe'

            await expect(provider.launchInstaller(testPath)).rejects.toThrow('spawn ENOENT')
            expect(unrefMock).not.toHaveBeenCalled()
        })

        it('throws error when shell.openPath returns error string on darwin', async () => {
            mockShell.openPath.mockResolvedValueOnce('Path does not exist')
            const provider = new FullUpdateProvider({ platform: 'darwin' })
            const testPath = '/path/to/CodingProfessionalAgent.dmg'

            await expect(provider.launchInstaller(testPath)).rejects.toThrow('Failed to open path: Path does not exist')
        })

        it('propagates rejection when shell.openPath throws or rejects on darwin', async () => {
            mockShell.openPath.mockRejectedValueOnce(new Error('IPC channel destroyed'))
            const provider = new FullUpdateProvider({ platform: 'darwin' })
            const testPath = '/path/to/CodingProfessionalAgent.dmg'

            await expect(provider.launchInstaller(testPath)).rejects.toThrow('IPC channel destroyed')
        })

        it('throws error when electron.shell.openPath is not available', async () => {
            const provider = new FullUpdateProvider({ platform: 'darwin' })
            const originalOpenPath = mockShell.openPath
            try {
                ;(mockShell as any).openPath = undefined
                const testPath = '/path/to/CodingProfessionalAgent.dmg'
                await expect(provider.launchInstaller(testPath)).rejects.toThrow('electron.shell.openPath is not available')
            } finally {
                mockShell.openPath = originalOpenPath
            }
        })

        it('sets executable permission and opens folder on linux', async () => {
            const chmodMock = vi.fn()
            const openPathMock = vi.fn().mockResolvedValue('')

            const provider = new FullUpdateProvider({
                platform: 'linux',
                chmodSync: chmodMock,
                openPath: openPathMock,
            })
            const testPath = '/path/to/downloads/CodingProfessionalAgent.AppImage'

            await provider.launchInstaller(testPath)

            expect(chmodMock).toHaveBeenCalledWith(testPath, 0o755)
            expect(openPathMock).toHaveBeenCalledWith(path.dirname(testPath))
        })

        it('continues and opens folder on linux even if chmodSync fails', async () => {
            const chmodMock = vi.fn().mockImplementation(() => {
                throw new Error('EPERM: operation not permitted')
            })
            const openPathMock = vi.fn().mockResolvedValue('')

            const provider = new FullUpdateProvider({
                platform: 'linux',
                chmodSync: chmodMock,
                openPath: openPathMock,
            })
            const testPath = '/path/to/downloads/CodingProfessionalAgent.AppImage'

            await provider.launchInstaller(testPath)

            expect(chmodMock).toHaveBeenCalledWith(testPath, 0o755)
            expect(openPathMock).toHaveBeenCalledWith(path.dirname(testPath))
        })

        it('throws error when shell.openPath returns error string on linux', async () => {
            const openPathMock = vi.fn().mockResolvedValue('Directory not accessible')
            const provider = new FullUpdateProvider({
                platform: 'linux',
                chmodSync: vi.fn(),
                openPath: openPathMock,
            })
            const testPath = '/path/to/downloads/CodingProfessionalAgent.AppImage'

            await expect(provider.launchInstaller(testPath)).rejects.toThrow('Failed to open path: Directory not accessible')
        })
    })
})
