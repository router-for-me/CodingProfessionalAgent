import * as fs from 'node:fs'
import * as crypto from 'node:crypto'

/**
 * Calculates SHA-256 hash for a given local file.
 */
export async function calculateFileSha256(filePath: string, abortSignal?: AbortSignal): Promise<string> {
    if (abortSignal?.aborted) throw new Error('Operation aborted')
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256')
        const stream = fs.createReadStream(filePath)
        let failure: Error | undefined
        let digest: string | undefined
        const onAbort = () => stream.destroy(new Error('Operation aborted'))
        stream.on('data', (chunk) => hash.update(chunk))
        stream.on('end', () => { digest = hash.digest('hex').toLowerCase() })
        stream.on('error', (err) => { failure = err })
        // Settle only after the file descriptor closes so callers can safely clean up.
        stream.on('close', () => {
            abortSignal?.removeEventListener('abort', onAbort)
            if (abortSignal?.aborted) reject(new Error('Operation aborted'))
            else if (failure) reject(failure)
            else if (digest === undefined) reject(new Error('Checksum stream closed prematurely'))
            else resolve(digest)
        })
        abortSignal?.addEventListener('abort', onAbort, { once: true })
        if (abortSignal?.aborted) onAbort()
    })
}

/**
 * Verifies if the file's SHA-256 hash matches the expected hash value.
 */
export async function verifyFileSha256(filePath: string, expectedSha256: string, abortSignal?: AbortSignal): Promise<boolean> {
    try {
        const actual = await calculateFileSha256(filePath, abortSignal)
        return actual.trim().toLowerCase() === expectedSha256.trim().toLowerCase()
    } catch (err) {
        if (abortSignal?.aborted) throw err
        return false
    }
}
