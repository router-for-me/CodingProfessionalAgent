import { describe, it, expect } from 'vitest'
import { parseCommandLineArgs } from '../src/main/utils/cliArgs.js'

describe('parseCommandLineArgs', () => {
    it('defaults to non-headless and undefined port/host with empty args', () => {
        const result = parseCommandLineArgs([], {})
        expect(result.isHeadless).toBe(false)
        expect(result.port).toBeUndefined()
        expect(result.host).toBeUndefined()
    })

    it('recognizes --headless and -H flags', () => {
        expect(parseCommandLineArgs(['--headless'], {}).isHeadless).toBe(true)
        expect(parseCommandLineArgs(['-H'], {}).isHeadless).toBe(true)
        expect(parseCommandLineArgs(['node', 'cpa', '--headless'], {}).isHeadless).toBe(true)
        expect(parseCommandLineArgs(['node', 'cpa', '-H'], {}).isHeadless).toBe(true)
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

    it('combines headless and port options correctly', () => {
        const result = parseCommandLineArgs(['--headless', '--port', '18088', '--host', '127.0.0.1'], {})
        expect(result.isHeadless).toBe(true)
        expect(result.port).toBe(18088)
        expect(result.host).toBe('127.0.0.1')
    })
})
