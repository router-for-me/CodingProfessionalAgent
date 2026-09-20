/**
 * Parsed representation of CPA command line arguments.
 */
export interface ParsedCommandLineArgs {
    isHeadless: boolean
    port?: number
    host?: string
}

/**
 * Parses process command-line arguments and relevant environment variables
 * to determine startup modes such as headless execution and network port overrides.
 *
 * @param argv - Array of command-line argument strings (e.g. process.argv)
 * @param env - Optional environment variables map (defaults to process.env)
 * @returns Structured ParsedCommandLineArgs object
 */
export function parseCommandLineArgs(
    argv: string[],
    env: NodeJS.ProcessEnv = process.env,
): ParsedCommandLineArgs {
    let isHeadless = env.CPA_HEADLESS === '1' || env.CPA_HEADLESS === 'true'
    let port: number | undefined
    let host: string | undefined

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i]
        if (arg === '--headless' || arg === '-H') {
            isHeadless = true
        } else if (arg === '--port' || arg === '-p') {
            const next = argv[i + 1]
            if (next && !next.startsWith('-')) {
                const parsed = parseInt(next, 10)
                if (!isNaN(parsed) && parsed > 0 && parsed <= 65535) {
                    port = parsed
                    i++
                }
            }
        } else if (arg.startsWith('--port=')) {
            const val = arg.slice('--port='.length)
            const parsed = parseInt(val, 10)
            if (!isNaN(parsed) && parsed > 0 && parsed <= 65535) {
                port = parsed
            }
        } else if (arg.startsWith('-p=')) {
            const val = arg.slice('-p='.length)
            const parsed = parseInt(val, 10)
            if (!isNaN(parsed) && parsed > 0 && parsed <= 65535) {
                port = parsed
            }
        } else if (arg === '--host') {
            const next = argv[i + 1]
            if (next && !next.startsWith('-')) {
                host = next
                i++
            }
        } else if (arg.startsWith('--host=')) {
            host = arg.slice('--host='.length)
        }
    }

    return { isHeadless, port, host }
}
