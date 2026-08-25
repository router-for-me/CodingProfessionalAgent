import { describe, expect, it } from 'vitest'
import i18n from '@/i18n'
import {
    resolveSetupScript,
    runEnvironmentSetup,
} from './environmentRunner'

describe('environmentRunner', () => {
    describe('resolveSetupScript', () => {
        it('prefers platform specific script over default', () => {
            const scripts = {
                default: 'echo default',
                macos: 'echo macos',
                linux: 'echo linux',
                windows: 'echo windows',
            }

            expect(resolveSetupScript(scripts, undefined, 'macos')).toBe('echo macos')
            expect(resolveSetupScript(scripts, undefined, 'linux')).toBe('echo linux')
            expect(resolveSetupScript(scripts, undefined, 'windows')).toBe('echo windows')
        })

        it('falls back to default script if platform specific is missing', () => {
            const scripts = {
                default: 'echo fallback-default',
            }

            expect(resolveSetupScript(scripts, undefined, 'macos')).toBe('echo fallback-default')
        })

        it('falls back to legacy fallback script if scripts object is empty', () => {
            expect(resolveSetupScript(null, 'echo legacy', 'macos')).toBe('echo legacy')
        })

        it('returns null if no scripts configured', () => {
            expect(resolveSetupScript(null, '', 'macos')).toBeNull()
        })
    })

    describe('runEnvironmentSetup', () => {
        it('returns ok with scriptRan false when no script is configured', async () => {
            const result = await runEnvironmentSetup({
                sourceTreePath: '/path/to/source',
                worktreePath: '/path/to/worktree',
            })

            expect(result.ok).toBe(true)
            expect(result.scriptRan).toBe(false)
        })

        it('executes setup script with injected CODEX and CPA environment variables', async () => {
            let capturedEnv: Record<string, string> | undefined
            let capturedCwd = ''
            const logChunks: string[] = []

            const fakeProcessRunner = async (options: {
                executable: string
                args: string[]
                cwd: string
                env: Record<string, string>
                onStdout?: (data: string) => void
                onStderr?: (data: string) => void
            }) => {
                capturedEnv = options.env
                capturedCwd = options.cwd
                options.onStdout?.('Installing dependencies...\n')
                options.onStdout?.('Done!\n')
                return { exitCode: 0, output: 'Installing dependencies...\nDone!\n' }
            }

            const result = await runEnvironmentSetup({
                sourceTreePath: '/repo/my-app',
                worktreePath: '/worktrees/my-app-wt',
                environmentConfig: {
                    setupScripts: {
                        default: 'npm install',
                    },
                },
                processRunner: fakeProcessRunner,
                onLog: (chunk) => logChunks.push(chunk),
            })

            expect(result.ok).toBe(true)
            expect(result.scriptRan).toBe(true)
            expect(result.exitCode).toBe(0)
            expect(capturedCwd).toBe('/repo/my-app')
            expect(capturedEnv?.CODEX_WORKTREE_PATH).toBe('/worktrees/my-app-wt')
            expect(capturedEnv?.CODEX_SOURCE_TREE_PATH).toBe('/repo/my-app')
            expect(capturedEnv?.CPA_WORKTREE_PATH).toBe('/worktrees/my-app-wt')
            expect(capturedEnv?.CPA_SOURCE_TREE_PATH).toBe('/repo/my-app')
            expect(logChunks.join('')).toContain('Installing dependencies...')
        })

        it('returns failure details when process exits with non-zero code', async () => {
            const fakeProcessRunner = async (options: {
                onStderr?: (data: string) => void
            }) => {
                options.onStderr?.('Error: package not found\n')
                return { exitCode: 1, output: 'Error: package not found\n' }
            }

            const result = await runEnvironmentSetup({
                sourceTreePath: '/repo/my-app',
                worktreePath: '/worktrees/my-app-wt',
                environmentConfig: {
                    setupScripts: {
                        default: 'bad_command',
                    },
                },
                processRunner: fakeProcessRunner,
            })

            expect(result.ok).toBe(false)
            expect(result.exitCode).toBe(1)
            expect(result.error).toContain('1')
            expect(result.output).toContain('Error: package not found')
        })

        it('logs internationalized success and failure messages', async () => {
            const currentLang = i18n.language

            try {
                // Test en
                await i18n.changeLanguage('en')
                const enLogs: string[] = []
                const fakeSuccessRunner = async () => ({ exitCode: 0, output: 'done' })

                await runEnvironmentSetup({
                    sourceTreePath: '/repo/my-app',
                    worktreePath: '/worktrees/my-app-wt',
                    environmentConfig: {
                        setupScripts: { default: 'echo done' },
                    },
                    processRunner: fakeSuccessRunner,
                    onLog: (chunk) => enLogs.push(chunk),
                })

                expect(enLogs.join('')).toContain('Environment setup completed successfully.')
            } finally {
                await i18n.changeLanguage(currentLang)
            }
        })
    })
})
