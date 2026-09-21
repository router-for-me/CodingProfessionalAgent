/**
 * Parsed representation of CPA command line arguments.
 */
export interface ParsedCommandLineArgs {
    isHeadless: boolean
    port?: number
    host?: string
    help: boolean
    version: boolean
}

/**
 * Generates formatted CLI help text documenting all available command-line options,
 * environment variables, and usage examples.
 *
 * @param version - Optional application version string to display
 * @returns Formatted help text
 */
export function getHelpText(version?: string): string {
    const versionHeader = version ? ` v${version}` : ''
    return [
        `Coding Professional Agent (CPA)${versionHeader}`,
        `Desktop coding agent shell with native window, web server, and AI agent kernel.`,
        ``,
        `Usage:`,
        `  cpa [options]`,
        `  coding-professional-agent [options]`,
        ``,
        `Options:`,
        `  -H, --headless          Run in headless daemon mode (starts web server without GUI window)`,
        `  -p, --port <port>       Port for the built-in web server (1-65535, default: 18080)`,
        `      --host <host>       Host address to bind the web server (default: 127.0.0.1)`,
        `  -h, --help              Show this help message and exit`,
        `  -v, --version           Show application version and exit`,
        ``,
        `Environment Variables:`,
        `  CPA_HEADLESS            Run in headless mode when set to '1' or 'true'`,
        `  CPA_PROFILE             Enable background CPU profiling diagnostics when set to '1'`,
        ``,
        `Examples:`,
        `  $ cpa`,
        `  $ cpa --headless`,
        `  $ cpa --port 19000 --host 0.0.0.0`,
        `  $ cpa -H -p 8080`,
    ].join('\n')
}

/**
 * Parses process command-line arguments and relevant environment variables
 * to determine startup modes such as headless execution, help display, and network port overrides.
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
    let help = false
    let version = false

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i]
        if (arg === '--help' || arg === '-h' || arg === '-help') {
            help = true
        } else if (arg === '--version' || arg === '-v' || arg === '-version') {
            version = true
        } else if (arg === '--headless' || arg === '-H') {
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

    return { isHeadless, port, host, help, version }
}
