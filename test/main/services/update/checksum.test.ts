import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import * as crypto from 'node:crypto'
import { verifyFileSha256, calculateFileSha256 } from '../../../../src/main/services/update/checksum.js'

describe('checksum utils', () => {
    let tempDir: string
    let tempFile: string

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpa-checksum-test-'))
        tempFile = path.join(tempDir, `test-sha256-${Date.now()}.txt`)
        fs.writeFileSync(tempFile, 'Hello CPA Update World!', 'utf8')
    })

    afterEach(() => {
        try {
            fs.rmSync(tempDir, { recursive: true, force: true })
        } catch {}
    })

    it('correctly calculates and verifies SHA-256', async () => {
        const expected = crypto.createHash('sha256').update('Hello CPA Update World!').digest('hex')
        const calculated = await calculateFileSha256(tempFile)
        expect(calculated).toBe(expected)

        const isValid = await verifyFileSha256(tempFile, expected)
        expect(isValid).toBe(true)

        const isInvalid = await verifyFileSha256(tempFile, 'invalid-hash-value')
        expect(isInvalid).toBe(false)
    })

    it('returns false for non-existent file in verifyFileSha256', async () => {
        const nonExistent = path.join(tempDir, 'non-existent-file.txt')
        const isValid = await verifyFileSha256(nonExistent, 'some-sha256')
        expect(isValid).toBe(false)
    })

    it('handles uppercase SHA-256 string comparison', async () => {
        const expected = crypto.createHash('sha256').update('Hello CPA Update World!').digest('hex')
        const isValid = await verifyFileSha256(tempFile, expected.toUpperCase())
        expect(isValid).toBe(true)
    })
})
