import { describe, it, expect } from 'vitest'
import { parseCommandLineArgs, getHelpText } from '../src/main/utils/cliArgs.js'

describe('parseCommandLineArgs', () => {
    it('defaults to non-headless, help false, version false and undefined port/host with empty args', () => {
        const result = parseCommandLineArgs([], {})
        expect(result.isHeadless).toBe(false)
        expect(result.help).toBe(false)
        expect(result.version).toBe(false)
        expect(result.port).toBeUndefined()
        expect(result.host).toBeUndefined()
    })

    it('recognizes --headless and -H flags', () => {
        expect(parseCommandLineArgs(['--headless'], {}).isHeadless).toBe(true)
        expect(parseCommandLineArgs(['-H'], {}).isHeadless).toBe(true)
        expect(parseCommandLineArgs(['node', 'cpa', '--headless'], {}).isHeadless).toBe(true)
        expect(parseCommandLineArgs(['node', 'cpa', '-H'], {}).isHeadless).toBe(true)
    })

    it('recognizes --help, -h, and -help flags', () => {
        expect(parseCommandLineArgs(['--help'], {}).help).toBe(true)
        expect(parseCommandLineArgs(['-h'], {}).help).toBe(true)
        expect(parseCommandLineArgs(['-help'], {}).help).toBe(true)
        expect(parseCommandLineArgs(['node', 'cpa', '--help'], {}).help).toBe(true)
        expect(parseCommandLineArgs(['node', 'cpa', '-h'], {}).help).toBe(true)
    })

    it('recognizes --version, -v, and -version flags', () => {
        expect(parseCommandLineArgs(['--version'], {}).version).toBe(true)
        expect(parseCommandLineArgs(['-v'], {}).version).toBe(true)
        expect(parseCommandLineArgs(['-version'], {}).version).toBe(true)
        expect(parseCommandLineArgs(['node', 'cpa', '--version'], {}).version).toBe(true)
        expect(parseCommandLineArgs(['node', 'cpa', '-v'], {}).version).toBe(true)
    })

    it('recognizes CPA_HEADLESS environment variable', () => {
        expect(parseCommandLineArgs([], { CPA_HEADLESS: '1' }).isHeadless).toBe(true)
        expect(parseCommandLineArgs([], { CPA_HEADLESS: 'true' }).isHeadless).toBe(true)
        expect(parseCommandLineArgs([], { CPA_HEADLESS: '0' }).isHeadless).toBe(false)
        expect(parseCommandLineArgs([], { CPA_HEADLESS: 'false' }).isHeadless).toBe(false)
    })

    it('parses --port and -p flag with positive integer', () => {
        expect(parseCommandLineArgs(['--port', '19090'], {}).port).toBe(19090)
        expect(parseCommandLineArgs(['-p', '8088'], {}).port).toBe(8088)
        expect(parseCommandLineArgs(['--port=9999'], {}).port).toBe(9999)
        expect(parseCommandLineArgs(['-p=8888'], {}).port).toBe(8888)
        expect(parseCommandLineArgs(['--port', 'invalid'], {}).port).toBeUndefined()
        expect(parseCommandLineArgs(['--port', '-1'], {}).port).toBeUndefined()
        expect(parseCommandLineArgs(['--port', '70000'], {}).port).toBeUndefined()
    })

    it('parses --host flag', () => {
        expect(parseCommandLineArgs(['--host', '0.0.0.0'], {}).host).toBe('0.0.0.0')
        expect(parseCommandLineArgs(['--host=192.168.1.10'], {}).host).toBe('192.168.1.10')
    })

    it('combines headless, help, port and host options correctly', () => {
        const result = parseCommandLineArgs(
            ['--headless', '--port', '18088', '--host', '127.0.0.1', '--help'],
            {},
        )
        expect(result.isHeadless).toBe(true)
        expect(result.port).toBe(18088)
        expect(result.host).toBe('127.0.0.1')
        expect(result.help).toBe(true)
        expect(result.version).toBe(false)
    })
})

describe('getHelpText', () => {
    it('documents all supported command-line options and environment variables', () => {
        const text = getHelpText()
        expect(text).toContain('Coding Professional Agent (CPA)')
        expect(text).toContain('Usage:')
        expect(text).toContain('--headless')
        expect(text).toContain('-H')
        expect(text).toContain('--port')
        expect(text).toContain('-p')
        expect(text).toContain('--host')
        expect(text).toContain('--help')
        expect(text).toContain('-h')
        expect(text).toContain('--version')
        expect(text).toContain('-v')
        expect(text).toContain('CPA_HEADLESS')
        expect(text).toContain('CPA_PROFILE')
        expect(text).toContain('Examples:')
    })

    it('includes version tag when version string is provided', () => {
        const text = getHelpText('2.5.0')
        expect(text).toContain('Coding Professional Agent (CPA) v2.5.0')
    })
})
