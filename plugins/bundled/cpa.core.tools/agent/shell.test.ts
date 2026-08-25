import { describe, expect, it } from 'vitest'
import { FakeNativeBridge } from './testUtils.js'
import {
    isLegacyWslBashPath,
    isWindowsPlatform,
    POWERSHELL_ARGS,
    resolvePowerShell,
    resolveShell,
} from './shell.js'

describe('resolveShell', () => {
    describe('custom path', () => {
        it('uses a custom shell path when the file exists', async () => {
            const bridge = new FakeNativeBridge()
            bridge.setFile('/custom/bash', '')
            const config = await resolveShell('linux', bridge, '/custom/bash')
            expect(config).toEqual({
                shell: '/custom/bash',
                args: ['-c'],
                commandTransport: 'arg',
            })
            expect(bridge.calls.some((call) => call.method === 'stat')).toBe(true)
        })

        it('rejects a missing custom shell path', async () => {
            const bridge = new FakeNativeBridge()
            await expect(resolveShell('linux', bridge, '/missing/bash')).rejects.toThrow(
                /Custom shell path not found: \/missing\/bash/,
            )
        })

        it('rejects a custom shell path that is a directory', async () => {
            const bridge = new FakeNativeBridge()
            await bridge.mkdirAll('/custom/dir')
            await expect(resolveShell('darwin', bridge, '/custom/dir')).rejects.toThrow(
                /Custom shell path is a directory: \/custom\/dir/,
            )
        })

        it('rejects an inaccessible custom shell path distinctly from not found', async () => {
            const bridge = new FakeNativeBridge()
            bridge.stat = async (path: string) => {
                throw Object.assign(new Error(`stat ${path}: permission denied`), {
                    code: 'EACCES',
                })
            }
            await expect(resolveShell('linux', bridge, '/secret/bash')).rejects.toThrow(
                /Custom shell path inaccessible: \/secret\/bash/,
            )
            await expect(resolveShell('linux', bridge, '/secret/bash')).rejects.not.toThrow(
                /not found/i,
            )
        })

        it('uses stdin transport for a custom legacy WSL bash path', async () => {
            const bridge = new FakeNativeBridge()
            bridge.setFile('C:\\Windows\\System32\\bash.exe', '')
            const config = await resolveShell('windows', bridge, 'C:\\Windows\\System32\\bash.exe')
            expect(config.shell).toBe('C:\\Windows\\System32\\bash.exe')
            expect(config.args).toEqual(['-s'])
            expect(config.commandTransport).toBe('stdin')
        })
    })

    describe('unix', () => {
        it('prefers /bin/bash when it exists', async () => {
            const bridge = new FakeNativeBridge()
            bridge.setFile('/bin/bash', '')
            bridge.setLookPath('bash', '/usr/local/bin/bash')
            const config = await resolveShell('linux', bridge)
            expect(config).toEqual({
                shell: '/bin/bash',
                args: ['-c'],
                commandTransport: 'arg',
            })
            expect(bridge.calls.some((call) => call.method === 'lookPath')).toBe(false)
        })

        it('falls back to lookPath(bash) when /bin/bash is missing', async () => {
            const bridge = new FakeNativeBridge()
            bridge.setLookPath('bash', '/usr/local/bin/bash')
            const config = await resolveShell('darwin', bridge)
            expect(config).toEqual({
                shell: '/usr/local/bin/bash',
                args: ['-c'],
                commandTransport: 'arg',
            })
            expect(bridge.calls.some((call) => call.method === 'lookPath' && call.args[0] === 'bash')).toBe(
                true,
            )
        })

        it('falls back to sh when /bin/bash and PATH bash are missing', async () => {
            const bridge = new FakeNativeBridge()
            bridge.setLookPath('bash', null)
            const config = await resolveShell('linux', bridge)
            expect(config).toEqual({
                shell: 'sh',
                args: ['-c'],
                commandTransport: 'arg',
            })
        })

        it('rethrows permission errors from /bin/bash stat instead of swallowing them', async () => {
            const bridge = new FakeNativeBridge()
            bridge.stat = async (path: string) => {
                if (path === '/bin/bash') {
                    throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
                }
                throw new Error(`stat ${path}: not found`)
            }
            await expect(resolveShell('linux', bridge)).rejects.toMatchObject({ code: 'EACCES' })
        })
    })

    describe('windows', () => {
        it('prefers Git Bash under ProgramFiles', async () => {
            const bridge = new FakeNativeBridge()
            const gitBash = 'C:\\Program Files\\Git\\bin\\bash.exe'
            bridge.setFile(gitBash, '')
            const config = await resolveShell('windows', bridge, undefined, {
                ProgramFiles: 'C:\\Program Files',
                'ProgramFiles(x86)': 'C:\\Program Files (x86)',
            })
            expect(config).toEqual({
                shell: gitBash,
                args: ['-c'],
                commandTransport: 'arg',
            })
            expect(bridge.calls.some((call) => call.method === 'lookPath')).toBe(false)
        })

        it('falls back to ProgramFiles(x86) Git Bash', async () => {
            const bridge = new FakeNativeBridge()
            const gitBash = 'C:\\Program Files (x86)\\Git\\bin\\bash.exe'
            bridge.setFile(gitBash, '')
            const config = await resolveShell('windows', bridge, undefined, {
                ProgramFiles: 'C:\\Program Files',
                'ProgramFiles(x86)': 'C:\\Program Files (x86)',
            })
            expect(config.shell).toBe(gitBash)
            expect(config.commandTransport).toBe('arg')
        })

        it('reads ProgramFiles env keys case-insensitively', async () => {
            const bridge = new FakeNativeBridge()
            const gitBash = 'D:\\Apps\\Git\\bin\\bash.exe'
            bridge.setFile(gitBash, '')
            const config = await resolveShell('windows', bridge, undefined, {
                programfiles: 'D:\\Apps',
                'programfiles(x86)': 'D:\\Appsx86',
            })
            expect(config.shell).toBe(gitBash)
        })

        it('merges injected ProgramFiles with conventional defaults so one root cannot hide the other', async () => {
            const bridge = new FakeNativeBridge()
            const x86Default = 'C:\\Program Files (x86)\\Git\\bin\\bash.exe'
            bridge.setFile(x86Default, '')
            const config = await resolveShell('windows', bridge, undefined, {
                ProgramFiles: 'D:\\OnlyPF',
            })
            expect(config.shell).toBe(x86Default)

            const looked = bridge.calls
                .filter((call) => call.method === 'stat')
                .map((call) => call.args[0] as string)
            expect(looked).toContain('D:\\OnlyPF\\Git\\bin\\bash.exe')
            expect(looked).toContain(x86Default)
            expect(looked).toContain('C:\\Program Files\\Git\\bin\\bash.exe')
        })

        it('falls back to lookPath(bash.exe) after known Git Bash paths miss', async () => {
            const bridge = new FakeNativeBridge()
            bridge.setLookPath('bash.exe', 'C:\\msys64\\usr\\bin\\bash.exe')
            const config = await resolveShell('windows', bridge, undefined, {
                ProgramFiles: 'C:\\Program Files',
                'ProgramFiles(x86)': 'C:\\Program Files (x86)',
            })
            expect(config).toEqual({
                shell: 'C:\\msys64\\usr\\bin\\bash.exe',
                args: ['-c'],
                commandTransport: 'arg',
            })
        })

        it('uses stdin transport when PATH bash is legacy WSL bash', async () => {
            const bridge = new FakeNativeBridge()
            bridge.setLookPath('bash.exe', 'C:\\Windows\\Sysnative\\bash.exe')
            const config = await resolveShell('windows', bridge, undefined, {
                ProgramFiles: 'C:\\Program Files',
            })
            expect(config).toEqual({
                shell: 'C:\\Windows\\Sysnative\\bash.exe',
                args: ['-s'],
                commandTransport: 'stdin',
            })
        })

        it('throws a clear install error and never falls back to PowerShell or cmd', async () => {
            const bridge = new FakeNativeBridge()
            bridge.setLookPath('bash.exe', null)
            bridge.setLookPath('powershell.exe', 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
            bridge.setLookPath('cmd.exe', 'C:\\Windows\\System32\\cmd.exe')

            await expect(
                resolveShell('windows', bridge, undefined, {
                    ProgramFiles: 'C:\\Program Files',
                    'ProgramFiles(x86)': 'C:\\Program Files (x86)',
                }),
            ).rejects.toThrow(/No bash shell found/)

            await expect(
                resolveShell('windows', bridge, undefined, {
                    ProgramFiles: 'C:\\Program Files',
                    'ProgramFiles(x86)': 'C:\\Program Files (x86)',
                }),
            ).rejects.toThrow(/Install Git for Windows/)

            const lookPathNames = bridge.calls
                .filter((call) => call.method === 'lookPath')
                .map((call) => call.args[0])
            expect(lookPathNames).not.toContain('powershell.exe')
            expect(lookPathNames).not.toContain('cmd.exe')
            expect(lookPathNames).not.toContain('powershell')
            expect(lookPathNames).not.toContain('cmd')
        })

        it('lists searched Git Bash paths in the error', async () => {
            const bridge = new FakeNativeBridge()
            bridge.setLookPath('bash.exe', null)
            await expect(
                resolveShell('windows', bridge, undefined, {
                    ProgramFiles: 'D:\\Apps',
                    'ProgramFiles(x86)': 'D:\\Appsx86',
                }),
            ).rejects.toThrow(/D:\\Apps\\Git\\bin\\bash\.exe/)
        })
    })

    describe('legacy WSL detection', () => {
        it('detects System32 and Sysnative bash paths case-insensitively', () => {
            expect(isLegacyWslBashPath('C:\\Windows\\System32\\bash.exe')).toBe(true)
            expect(isLegacyWslBashPath('c:/windows/sysnative/bash.exe')).toBe(true)
            expect(isLegacyWslBashPath('C:\\Program Files\\Git\\bin\\bash.exe')).toBe(false)
            expect(isLegacyWslBashPath('/bin/bash')).toBe(false)
        })
    })

    describe('isWindowsPlatform', () => {
        it('identifies Windows platforms correctly', () => {
            expect(isWindowsPlatform('win32')).toBe(true)
            expect(isWindowsPlatform('Win32')).toBe(true)
            expect(isWindowsPlatform('windows')).toBe(true)
            expect(isWindowsPlatform('WINDOWS')).toBe(true)
            expect(isWindowsPlatform('darwin')).toBe(false)
            expect(isWindowsPlatform('linux')).toBe(false)
            expect(isWindowsPlatform(undefined)).toBe(false)
            expect(isWindowsPlatform(null)).toBe(false)
            expect(isWindowsPlatform('')).toBe(false)
        })
    })

    describe('resolvePowerShell', () => {
        describe('custom path', () => {
            it('uses custom powershell path when file exists', async () => {
                const bridge = new FakeNativeBridge()
                bridge.setFile('C:\\custom\\pwsh.exe', '')
                const config = await resolvePowerShell('win32', bridge, 'C:\\custom\\pwsh.exe')
                expect(config).toEqual({
                    shell: 'C:\\custom\\pwsh.exe',
                    args: [...POWERSHELL_ARGS],
                    commandTransport: 'arg',
                })
            })

            it('rejects missing custom path', async () => {
                const bridge = new FakeNativeBridge()
                await expect(
                    resolvePowerShell('win32', bridge, 'C:\\missing\\pwsh.exe'),
                ).rejects.toThrow(/Custom shell path not found/)
            })
        })

        describe('windows resolution', () => {
            it('prefers pwsh.exe on PATH', async () => {
                const bridge = new FakeNativeBridge()
                bridge.setLookPath('pwsh.exe', 'C:\\Program Files\\PowerShell\\7\\pwsh.exe')
                bridge.setLookPath('powershell.exe', 'C:\\Windows\\System32\\powershell.exe')
                const config = await resolvePowerShell('win32', bridge)
                expect(config).toEqual({
                    shell: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
                    args: [...POWERSHELL_ARGS],
                    commandTransport: 'arg',
                })
            })

            it('finds pwsh.exe in Program Files when not on PATH', async () => {
                const bridge = new FakeNativeBridge()
                bridge.setLookPath('pwsh.exe', null)
                const pwsh7 = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'
                bridge.setFile(pwsh7, '')
                const config = await resolvePowerShell('windows', bridge, undefined, {
                    ProgramFiles: 'C:\\Program Files',
                })
                expect(config.shell).toBe(pwsh7)
            })

            it('falls back to powershell.exe on PATH when pwsh is not available', async () => {
                const bridge = new FakeNativeBridge()
                bridge.setLookPath('pwsh.exe', null)
                bridge.setLookPath('powershell.exe', 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
                const config = await resolvePowerShell('win32', bridge)
                expect(config).toEqual({
                    shell: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
                    args: [...POWERSHELL_ARGS],
                    commandTransport: 'arg',
                })
            })

            it('falls back to powershell.exe in System32 when not on PATH', async () => {
                const bridge = new FakeNativeBridge()
                bridge.setLookPath('pwsh.exe', null)
                bridge.setLookPath('powershell.exe', null)
                const sys32Ps = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
                bridge.setFile(sys32Ps, '')
                const config = await resolvePowerShell('win32', bridge, undefined, {
                    SystemRoot: 'C:\\Windows',
                })
                expect(config.shell).toBe(sys32Ps)
            })

            it('throws a helpful error when no PowerShell executable is found on Windows', async () => {
                const bridge = new FakeNativeBridge()
                bridge.setLookPath('pwsh.exe', null)
                bridge.setLookPath('powershell.exe', null)
                await expect(resolvePowerShell('win32', bridge)).rejects.toThrow(
                    /No PowerShell executable found/,
                )
            })
        })

        describe('non-windows resolution', () => {
            it('resolves pwsh on unix PATH when available', async () => {
                const bridge = new FakeNativeBridge()
                bridge.setLookPath('pwsh', '/usr/local/bin/pwsh')
                const config = await resolvePowerShell('darwin', bridge)
                expect(config).toEqual({
                    shell: '/usr/local/bin/pwsh',
                    args: [...POWERSHELL_ARGS],
                    commandTransport: 'arg',
                })
            })

            it('throws error when pwsh is not on PATH on unix', async () => {
                const bridge = new FakeNativeBridge()
                bridge.setLookPath('pwsh', null)
                bridge.setLookPath('powershell', null)
                await expect(resolvePowerShell('linux', bridge)).rejects.toThrow(
                    /PowerShell is only supported when pwsh is available on PATH/,
                )
            })
        })
    })
})
