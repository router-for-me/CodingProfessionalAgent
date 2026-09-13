import * as fs from 'node:fs'
import * as crypto from 'node:crypto'

/**
 * Calculates SHA-256 hash for a given local file.
 */
export async function calculateFileSha256(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256')
        const stream = fs.createReadStream(filePath)
        stream.on('data', (chunk) => hash.update(chunk))
        stream.on('end', () => resolve(hash.digest('hex').toLowerCase()))
        stream.on('error', (err) => reject(err))
    })
}

/**
 * Verifies if the file's SHA-256 hash matches the expected hash value.
 */
export async function verifyFileSha256(filePath: string, expectedSha256: string): Promise<boolean> {
    try {
        const actual = await calculateFileSha256(filePath)
        return actual.trim().toLowerCase() === expectedSha256.trim().toLowerCase()
    } catch {
        return false
    }
}
