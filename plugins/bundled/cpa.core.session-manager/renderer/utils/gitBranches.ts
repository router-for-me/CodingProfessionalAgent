export interface GitFs {
    stat(path: string): Promise<{ isDir: boolean }>
    readFile(path: string): Promise<Uint8Array>
    readFileIfExists?(path: string): Promise<Uint8Array | null>
    readDir(path: string): Promise<readonly { name: string; isDir: boolean }[]>
}

export interface GitCommandResult {
    exitCode: number
    stdout: string
    stderr: string
}

export type GitCommandRunner = (
    cwd: string,
    args: readonly string[],
) => Promise<GitCommandResult>

export interface GitRepoInfo {
    repoRoot: string
    gitDir: string
    commonDir: string
    current: string | null
    detached: boolean
    headSha: string | null
    branches: string[]
}

const HEADS_PREFIX = 'refs/heads/'
const SHA_RE = /^[0-9a-f]{40,64}$/i
const PACKED_HEAD_RE = /^([0-9a-f]{40,64})\s+(refs\/heads\/\S+)\s*$/i

function base64ToBytes(base64: string): Uint8Array {
    const raw = atob(base64)
    const bytes = new Uint8Array(raw.length)
    for (let i = 0; i < raw.length; i++) {
        bytes[i] = raw.charCodeAt(i)
    }
    return bytes
}

export function createHostGitFs(fileSystem: any): GitFs {
    return {
        async stat(path: string) {
            const res = await fileSystem.stat(path)
            return { isDir: res?.isDir ?? res?.isDirectory ?? false }
        },
        async readFile(path: string) {
            const res = await fileSystem.readFile(path)
            return base64ToBytes(res.dataBase64)
        },
        async readFileIfExists(path: string) {
            const res = fileSystem.readFileIfExists
                ? await fileSystem.readFileIfExists(path)
                : await fileSystem.readFile(path).catch(() => null)
            if (!res?.dataBase64) return null
            return base64ToBytes(res.dataBase64)
        },
        async readDir(path: string) {
            const entries = await fileSystem.readDir(path)
            return (entries || []).map((e: any) => ({
                name: e.name,
                isDir: e.isDir ?? e.isDirectory ?? false,
            }))
        },
    }
}

export function isValidGitBranchName(name: string): boolean {
    const trimmed = typeof name === 'string' ? name.trim() : ''
    if (!trimmed) return false
    if (trimmed.startsWith('-') || trimmed.endsWith('.lock') || trimmed.endsWith('/')) {
        return false
    }
    if (/[\x00-\x1f\x7f ~^:?*[\\]/.test(trimmed)) return false
    if (trimmed.includes('..') || trimmed.includes('@{')) return false
    return true
}

export async function readGitRepo(
    roots: readonly string[],
    fs: GitFs,
): Promise<GitRepoInfo | null> {
    for (const root of roots) {
        const trimmed = typeof root === 'string' ? root.trim() : ''
        if (!trimmed) continue
        try {
            const gitDirPath = `${trimmed}/.git`
            const stat = await fs.stat(gitDirPath).catch(() => null)
            if (!stat) continue

            let gitDir = gitDirPath
            let commonDir = gitDirPath

            if (!stat.isDir) {
                const gitFileBytes = await fs.readFile(gitDirPath).catch(() => null)
                if (gitFileBytes) {
                    const text = new TextDecoder().decode(gitFileBytes)
                    const match = text.match(/^gitdir:\s*(.+)$/m)
                    if (match) {
                        const target = match[1].trim()
                        gitDir = target.startsWith('/') ? target : `${trimmed}/${target}`
                        commonDir = gitDir
                    }
                }
            }

            const commondirBytes = fs.readFileIfExists
                ? await fs.readFileIfExists(`${gitDir}/commondir`).catch(() => null)
                : null
            if (commondirBytes) {
                const text = new TextDecoder().decode(commondirBytes).trim()
                commonDir = text.startsWith('/') ? text : `${gitDir}/${text}`
            }

            let current: string | null = null
            let detached = false
            let headSha: string | null = null

            const headBytes = fs.readFileIfExists
                ? await fs.readFileIfExists(`${gitDir}/HEAD`).catch(() => null)
                : await fs.readFile(`${gitDir}/HEAD`).catch(() => null)

            if (headBytes) {
                const headText = new TextDecoder().decode(headBytes).trim()
                if (headText.startsWith('ref: refs/heads/')) {
                    current = headText.slice('ref: refs/heads/'.length)
                } else if (SHA_RE.test(headText)) {
                    detached = true
                    headSha = headText
                }
            }

            const branchesSet = new Set<string>()
            if (current) branchesSet.add(current)

            // Read heads directory
            const scanHeads = async (dir: string, prefix = '') => {
                try {
                    const entries = await fs.readDir(dir)
                    for (const entry of entries) {
                        if (entry.isDir) {
                            await scanHeads(`${dir}/${entry.name}`, `${prefix}${entry.name}/`)
                        } else {
                            branchesSet.add(`${prefix}${entry.name}`)
                        }
                    }
                } catch {
                    // Ignore missing heads dir
                }
            }
            await scanHeads(`${commonDir}/refs/heads`)

            // Read packed-refs
            const packedBytes = fs.readFileIfExists
                ? await fs.readFileIfExists(`${commonDir}/packed-refs`).catch(() => null)
                : null
            if (packedBytes) {
                const text = new TextDecoder().decode(packedBytes)
                for (const line of text.split(/\r?\n/)) {
                    const match = line.match(PACKED_HEAD_RE)
                    if (match) {
                        const ref = match[2]
                        if (ref.startsWith(HEADS_PREFIX)) {
                            branchesSet.add(ref.slice(HEADS_PREFIX.length))
                        }
                    }
                }
            }

            return {
                repoRoot: trimmed,
                gitDir,
                commonDir,
                current,
                detached,
                headSha,
                branches: Array.from(branchesSet).sort(),
            }
        } catch {
            // Next root
        }
    }
    return null
}

export async function switchGitBranchWithDefaultRunner(
    repo: GitRepoInfo,
    branchName: string,
    options?: { create?: boolean; baseBranch?: string },
    runner?: GitCommandRunner,
): Promise<void> {
    if (!runner) {
        throw new Error('No GitCommandRunner provided')
    }
    const args = options?.create
        ? options.baseBranch
            ? ['switch', '-c', branchName, options.baseBranch]
            : ['switch', '-c', branchName]
        : ['switch', branchName]
    const result = await runner(repo.repoRoot, args)
    if (result.exitCode !== 0) {
        throw new Error(result.stderr || `git switch failed with code ${result.exitCode}`)
    }
}
