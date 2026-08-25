import { describe, expect, it, vi } from 'vitest'
import {
    dirnamePath,
    expandPath,
    isAbsolutePath,
    isPathWithinDirectory,
    normalizeDirectoryCacheKey,
    pathNeedsHomeDir,
    resolveReadPath,
    resolveToCwd,
    resolveToolPath,
} from './path'

describe('path helpers', () => {
    describe('resolveToCwd', () => {
        it('resolves POSIX relative paths against cwd', () => {
            expect(resolveToCwd('src/main.ts', '/repo')).toBe('/repo/src/main.ts')
            expect(resolveToCwd('./a/./b', '/repo')).toBe('/repo/a/b')
            expect(resolveToCwd('../out/x', '/repo/src')).toBe('/repo/out/x')
        })

        it('keeps POSIX absolute paths and collapses . / ..', () => {
            expect(resolveToCwd('/abs/file.txt', '/repo')).toBe('/abs/file.txt')
            expect(resolveToCwd('/abs/./a/../b', '/repo')).toBe('/abs/b')
            expect(resolveToCwd('/../../etc/passwd', '/repo')).toBe('/etc/passwd')
        })

        it('handles Windows drive absolute paths and backslashes', () => {
            expect(resolveToCwd('C:\\Users\\me\\a.txt', 'C:\\repo')).toBe('C:/Users/me/a.txt')
            expect(resolveToCwd('D:/other/file', 'C:/repo')).toBe('D:/other/file')
            expect(resolveToCwd('foo\\bar', 'C:\\repo')).toBe('C:/repo/foo/bar')
            expect(resolveToCwd('..\\sibling', 'C:\\repo\\src')).toBe('C:/repo/sibling')
        })

        it('does not rewrite absolute paths onto a different drive', () => {
            expect(resolveToCwd('E:\\only', 'C:\\repo')).toBe('E:/only')
            expect(resolveToCwd('E:/only', 'C:/repo')).toBe('E:/only')
        })

        it('treats root-absolute segments as current-drive absolute on Windows', () => {
            expect(resolveToCwd('\\Windows\\System32', 'C:\\repo')).toBe('C:/Windows/System32')
            expect(resolveToCwd('/tmp/x', 'C:/repo')).toBe('C:/tmp/x')
        })

        it('resolves root-relative paths against a UNC share root', () => {
            expect(resolveToCwd('\\foo', '\\\\server\\share\\dir')).toBe('//server/share/foo')
            expect(resolveToCwd('/foo/bar', '//server/share/dir')).toBe('//server/share/foo/bar')
            expect(resolveToCwd('\\', '\\\\server\\share\\dir')).toBe('//server/share')
        })

        it('handles UNC paths', () => {
            expect(resolveToCwd('\\\\server\\share\\dir\\file', 'C:\\repo')).toBe(
                '//server/share/dir/file',
            )
            expect(resolveToCwd('//server/share/./a/../b', '/repo')).toBe('//server/share/b')
        })

        it('rejects drive-relative paths with a clear error', () => {
            expect(() => resolveToCwd('C:foo', 'C:\\repo')).toThrow(/drive-relative/i)
            expect(() => resolveToCwd('C:', 'C:\\repo')).toThrow(/drive-relative/i)
            expect(() => resolveToCwd('d:bar', 'C:/repo')).toThrow(/drive-relative/i)
        })

        it('rejects empty or invalid path/cwd', () => {
            expect(() => resolveToCwd('', '/repo')).toThrow(/path/i)
            expect(() => resolveToCwd('a', '')).toThrow(/cwd/i)
            expect(() => resolveToCwd(null as unknown as string, '/repo')).toThrow(/path/i)
            expect(() => resolveToCwd('a', 'relative-cwd')).toThrow(/absolute/i)
        })
    })

    describe('isAbsolutePath', () => {
        it('accepts POSIX single-root, Windows drive, and complete UNC only', () => {
            // POSIX single-root absolute (including root itself).
            expect(isAbsolutePath('/')).toBe(true)
            expect(isAbsolutePath('/a')).toBe(true)
            expect(isAbsolutePath('/repo/pkg')).toBe(true)

            // Windows drive absolute (separator required after drive letter).
            expect(isAbsolutePath('C:\\a')).toBe(true)
            expect(isAbsolutePath('D:/a')).toBe(true)
            expect(isAbsolutePath('C:/repo')).toBe(true)

            // Complete UNC requires server + share.
            expect(isAbsolutePath('\\\\server\\share')).toBe(true)
            expect(isAbsolutePath('//server/share')).toBe(true)
            expect(isAbsolutePath('//server/share/dir')).toBe(true)
            expect(isAbsolutePath('\\\\server\\share\\dir')).toBe(true)
        })

        it('rejects relative, drive-relative, single-backslash root-relative, and incomplete UNC', () => {
            expect(isAbsolutePath('relative')).toBe(false)
            expect(isAbsolutePath('./x')).toBe(false)
            expect(isAbsolutePath('../x')).toBe(false)

            // Drive-relative forms are not absolute.
            expect(isAbsolutePath('C:')).toBe(false)
            expect(isAbsolutePath('C:foo')).toBe(false)

            // Single backslash root-relative is not independently absolute.
            expect(isAbsolutePath('\\repo')).toBe(false)
            expect(isAbsolutePath('\\foo')).toBe(false)
            expect(isAbsolutePath('\\')).toBe(false)

            // Incomplete UNC (server only, no share) is not independently absolute.
            expect(isAbsolutePath('\\\\server')).toBe(false)
            expect(isAbsolutePath('//server')).toBe(false)
            expect(isAbsolutePath('//')).toBe(false)
            expect(isAbsolutePath('\\\\')).toBe(false)
        })
    })

    describe('isPathWithinDirectory', () => {
        it('checks directory containment without accepting similar prefixes', () => {
            expect(isPathWithinDirectory('/worktrees/repo/file.ts', '/worktrees/repo')).toBe(true)
            expect(isPathWithinDirectory('/worktrees/repo', '/worktrees/repo')).toBe(true)
            expect(isPathWithinDirectory('/worktrees/repo-other/file.ts', '/worktrees/repo')).toBe(false)
            expect(isPathWithinDirectory('/projects/main/file.ts', '/worktrees/repo')).toBe(false)
        })

        it('checks Windows and UNC paths case-insensitively', () => {
            expect(isPathWithinDirectory('C:\\WT\\Repo\\src\\a.ts', 'c:\\wt\\repo')).toBe(true)
            expect(isPathWithinDirectory('D:\\WT\\Repo\\src\\a.ts', 'c:\\wt\\repo')).toBe(false)
            expect(isPathWithinDirectory('\\\\server\\share\\repo\\a.ts', '\\\\SERVER\\SHARE\\repo')).toBe(true)
        })
    })

    describe('dirnamePath', () => {
        it('returns parent for POSIX and Windows roots correctly', () => {
            expect(dirnamePath('/repo/src/a.ts')).toBe('/repo/src')
            expect(dirnamePath('/file.txt')).toBe('/')
            expect(dirnamePath('/')).toBe('/')
            expect(dirnamePath('C:/repo/a.txt')).toBe('C:/repo')
            expect(dirnamePath('C:/a.txt')).toBe('C:/')
            expect(dirnamePath('C:/')).toBe('C:/')
            expect(dirnamePath('//server/share/dir/file')).toBe('//server/share/dir')
            expect(dirnamePath('//server/share')).toBe('//server/share')
        })
    })

    describe('normalizeDirectoryCacheKey', () => {
        it('collapses POSIX trailing slash and dot segments into one cache key', () => {
            const expected = normalizeDirectoryCacheKey('/repo')
            expect(normalizeDirectoryCacheKey('/repo/')).toBe(expected)
            expect(normalizeDirectoryCacheKey('/repo/.')).toBe(expected)
            expect(normalizeDirectoryCacheKey('/repo/./')).toBe(expected)
            expect(normalizeDirectoryCacheKey('/repo/pkg/..')).toBe(expected)
            // Root stays root.
            expect(normalizeDirectoryCacheKey('/')).toBe('/')
            expect(normalizeDirectoryCacheKey('/.')).toBe('/')
        })

        it('keeps POSIX paths case-sensitive', () => {
            expect(normalizeDirectoryCacheKey('/Repo')).not.toBe(normalizeDirectoryCacheKey('/repo'))
            expect(normalizeDirectoryCacheKey('/Repo')).toBe('/Repo')
            expect(normalizeDirectoryCacheKey('/repo')).toBe('/repo')
        })

        it('collapses Windows drive variants and lowercases only the cache key', () => {
            const expected = normalizeDirectoryCacheKey('C:\\Repo\\.')
            expect(normalizeDirectoryCacheKey('c:/repo/')).toBe(expected)
            expect(normalizeDirectoryCacheKey('C:/Repo')).toBe(expected)
            expect(normalizeDirectoryCacheKey('c:\\repo\\')).toBe(expected)
            expect(expected).toBe('c:/repo')
        })

        it('collapses UNC variants and lowercases only the cache key', () => {
            const expected = normalizeDirectoryCacheKey('\\\\Server\\Share\\Repo')
            expect(normalizeDirectoryCacheKey('//server/share/repo/')).toBe(expected)
            expect(normalizeDirectoryCacheKey('//Server/Share/Repo')).toBe(expected)
            expect(normalizeDirectoryCacheKey('\\\\server\\share\\repo\\.')).toBe(expected)
            expect(expected).toBe('//server/share/repo')
        })
    })

    describe('expandPath / resolveToolPath (~ and @)', () => {
        it('strips exactly one leading @ before absolute/relative judgment', () => {
            expect(expandPath('@/abs/file', { homeDir: '/home/u' })).toBe('/abs/file')
            expect(resolveToolPath('@src/a.ts', '/repo', { homeDir: '/home/u' })).toBe(
                '/repo/src/a.ts',
            )
            // @@x only strips one @.
            expect(expandPath('@@x', { homeDir: '/home/u' })).toBe('@x')
            expect(resolveToolPath('@@x', '/repo')).toBe('/repo/@x')
        })

        it('expands POSIX ~ and ~/ with absolute homeDir', () => {
            expect(expandPath('~', { homeDir: '/home/me' })).toBe('/home/me')
            expect(expandPath('~/notes.txt', { homeDir: '/home/me' })).toBe('/home/me/notes.txt')
            expect(resolveToolPath('~/proj/a', '/repo', { homeDir: '/Users/me' })).toBe(
                '/Users/me/proj/a',
            )
            expect(resolveToolPath('@~/file', '/repo', { homeDir: '/home/me' })).toBe(
                '/home/me/file',
            )
        })

        it('expands Windows ~/ and ~\\ with drive and UNC homes', () => {
            expect(expandPath('~/docs', { homeDir: 'C:\\Users\\me' })).toBe('C:/Users/me/docs')
            expect(expandPath('~\\docs', { homeDir: 'C:/Users/me' })).toBe('C:/Users/me/docs')
            expect(expandPath('~', { homeDir: 'C:\\Users\\me' })).toBe('C:/Users/me')
            expect(expandPath('~/a', { homeDir: '\\\\server\\share\\home' })).toBe(
                '//server/share/home/a',
            )
            expect(expandPath('~/a', { homeDir: '//server/share/home' })).toBe(
                '//server/share/home/a',
            )
        })

        it('rejects ~user and relative/non-absolute homeDir', () => {
            expect(() => expandPath('~alice/file', { homeDir: '/home/me' })).toThrow(
                /unsupported home path/i,
            )
            expect(() => expandPath('~/a', { homeDir: 'relative-home' })).toThrow(/absolute/i)
            expect(() => expandPath('~/a')).toThrow(/homeDir is required/i)
            expect(() => expandPath('~', { homeDir: '' })).toThrow(/homeDir is required/i)
        })

        it('does not require homeDir when path has no tilde', () => {
            expect(expandPath('src/a.ts')).toBe('src/a.ts')
            expect(resolveToolPath('/abs', '/repo')).toBe('/abs')
            expect(pathNeedsHomeDir('src/a')).toBe(false)
            expect(pathNeedsHomeDir('@src/a')).toBe(false)
            expect(pathNeedsHomeDir('~/a')).toBe(true)
            expect(pathNeedsHomeDir('@~/a')).toBe(true)
            expect(pathNeedsHomeDir('~user')).toBe(true)
        })

        it('normalizes Unicode spaces without breaking AM/PM variant input spaces', () => {
            const narrow = `Screenshot 1\u202FPM.png`
            // Input with narrow NBSP becomes regular space after expand (Pi semantics).
            expect(expandPath(`/tmp/${narrow}`)).toBe('/tmp/Screenshot 1 PM.png')
            // Regular space before AM/PM is preserved for later darwin variant injection.
            expect(expandPath('/tmp/Screenshot 1 PM.png')).toBe('/tmp/Screenshot 1 PM.png')
        })
    })

    describe('resolveReadPath macOS variants', () => {
        const NNBSP = '\u202F'

        function bridgeWithFiles(paths: Record<string, { isDir?: boolean }>) {
            return {
                stat: vi.fn(async (path: string) => {
                    const hit = paths[path]
                    if (!hit) {
                        throw new Error(`stat ${path}: not found`)
                    }
                    return { isDir: hit.isDir === true }
                }),
            }
        }

        it('returns exact path when the file exists', async () => {
            const bridge = bridgeWithFiles({ '/repo/a.txt': {} })
            await expect(
                resolveReadPath('a.txt', '/repo', bridge, { platform: 'darwin' }),
            ).resolves.toBe('/repo/a.txt')
            expect(bridge.stat).toHaveBeenCalledTimes(1)
        })

        it('tries AM/PM narrow NBSP on darwin', async () => {
            const amPm = `/repo/Screenshot 1${NNBSP}PM.png`
            const bridge = bridgeWithFiles({ [amPm]: {} })
            await expect(
                resolveReadPath('Screenshot 1 PM.png', '/repo', bridge, {
                    platform: 'darwin',
                }),
            ).resolves.toBe(amPm)
        })

        it('tries NFD filename variant on darwin', async () => {
            const nfdName = 'cafe\u0301.txt'
            const bridge = bridgeWithFiles({ [`/repo/${nfdName}`]: {} })
            await expect(
                resolveReadPath('caf\u00e9.txt', '/repo', bridge, {
                    platform: 'darwin',
                }),
            ).resolves.toBe(`/repo/${nfdName}`)
        })

        it('tries curly-quote filename variant on darwin', async () => {
            const curly = `/repo/Capture d\u2019ecran.txt`
            const bridge = bridgeWithFiles({ [curly]: {} })
            await expect(
                resolveReadPath("Capture d'ecran.txt", '/repo', bridge, {
                    platform: 'darwin',
                }),
            ).resolves.toBe(curly)
        })

        it('tries combined NFD + curly quote on darwin', async () => {
            // NFD of "é" is e + combining acute; curly replaces ' with U+2019.
            const combined = '/repo/Capture d\u2019e\u0301cran.png'
            const bridge = bridgeWithFiles({ [combined]: {} })
            await expect(
                resolveReadPath("Capture d'\u00e9cran.png", '/repo', bridge, {
                    platform: 'darwin',
                }),
            ).resolves.toBe(combined)
        })

        it('does not apply macOS variants on non-darwin platforms', async () => {
            const narrow = `/repo/Screenshot 1${NNBSP}PM.png`
            const bridge = bridgeWithFiles({ [narrow]: {} })
            await expect(
                resolveReadPath('Screenshot 1 PM.png', '/repo', bridge, { platform: 'linux' }),
            ).resolves.toBe('/repo/Screenshot 1 PM.png')
            expect(bridge.stat).toHaveBeenCalledTimes(1)
        })

        it('does not fall back on permission errors for the exact path', async () => {
            const bridge = {
                stat: vi.fn(async () => {
                    throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
                }),
            }
            await expect(
                resolveReadPath('secret.txt', '/repo', bridge, { platform: 'darwin' }),
            ).rejects.toThrow(/permission denied/i)
            expect(bridge.stat).toHaveBeenCalledTimes(1)
        })

        it('returns the original resolved path when nothing exists so read errors stay clear', async () => {
            const bridge = bridgeWithFiles({})
            await expect(
                resolveReadPath('missing.txt', '/repo', bridge, { platform: 'darwin' }),
            ).resolves.toBe('/repo/missing.txt')
        })

        it('expands @ and ~ before darwin variants', async () => {
            const target = `/home/me/Screenshot 1${NNBSP}PM.png`
            const bridge = bridgeWithFiles({ [target]: {} })
            await expect(
                resolveReadPath('@~/Screenshot 1 PM.png', '/repo', bridge, {
                    platform: 'darwin',
                    homeDir: '/home/me',
                }),
            ).resolves.toBe(target)
        })
    })
})
