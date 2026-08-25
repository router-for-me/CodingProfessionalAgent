import type {
    NativeBridge,
    NativeDirEntry,
    NativeStat,
} from './types.js'

export interface FakeCallRecord {
    method: string
    args: unknown[]
}

export class FakeNativeBridge implements NativeBridge {
    readonly calls: FakeCallRecord[] = []

    private readonly files = new Map<string, Uint8Array>()
    private readonly dirs = new Set<string>()
    private readonly symlinks = new Map<string, string>()
    private info = {
        platform: 'darwin',
        userConfigDir: '/tmp/cpa-config',
        tempDir: '/tmp',
        homeDir: '/home/test',
    }

    constructor() {
        this.dirs.add('/')
    }

    private normalize(p: string): string {
        return p.replace(/\\/g, '/')
    }

    private ensureParentDirs(filePath: string): void {
        const parts = this.normalize(filePath).split('/').filter(Boolean)
        let current = filePath.startsWith('/') ? '' : ''
        for (let i = 0; i < parts.length - 1; i++) {
            current += '/' + parts[i]
            this.dirs.add(current)
        }
    }

    setRuntimeInfo(info: Partial<typeof this.info>): void {
        this.info = { ...this.info, ...info }
    }

    setFile(path: string, data: string | Uint8Array): void {
        const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data)
        this.files.set(this.normalize(path), bytes)
        this.ensureParentDirs(path)
    }

    setSymlink(linkPath: string, targetPath: string): void {
        this.symlinks.set(this.normalize(linkPath), this.normalize(targetPath))
    }

    async stat(path: string): Promise<NativeStat> {
        this.calls.push({ method: 'stat', args: [path] })
        const norm = this.normalize(path)
        if (this.symlinks.has(norm)) {
            return this.stat(this.symlinks.get(norm)!)
        }
        if (this.files.has(norm)) {
            const bytes = this.files.get(norm)!
            return { isDir: false, isFile: true, sizeBytes: bytes.byteLength }
        }
        if (this.dirs.has(norm)) {
            return { isDir: true, isFile: false, sizeBytes: 0 }
        }
        throw new Error(`stat ${path}: not found`)
    }

    async readFile(path: string): Promise<Uint8Array> {
        this.calls.push({ method: 'readFile', args: [path] })
        const norm = this.normalize(path)
        if (this.symlinks.has(norm)) {
            return this.readFile(this.symlinks.get(norm)!)
        }
        const hit = this.files.get(norm)
        if (!hit) {
            throw new Error(`readFile ${path}: not found`)
        }
        return hit
    }

    async readFileIfExists(path: string): Promise<Uint8Array | null> {
        this.calls.push({ method: 'readFileIfExists', args: [path] })
        const norm = this.normalize(path)
        if (this.symlinks.has(norm)) {
            return this.readFileIfExists(this.symlinks.get(norm)!)
        }
        return this.files.get(norm) ?? null
    }

    async writeFile(path: string, data: Uint8Array): Promise<void> {
        this.calls.push({ method: 'writeFile', args: [path, data] })
        const norm = this.normalize(path)
        this.files.set(norm, data)
        this.ensureParentDirs(path)
    }

    async mkdirAll(path: string): Promise<void> {
        this.calls.push({ method: 'mkdirAll', args: [path] })
        this.dirs.add(this.normalize(path))
    }

    async readDir(path: string): Promise<readonly NativeDirEntry[]> {
        this.calls.push({ method: 'readDir', args: [path] })
        const norm = this.normalize(path)
        const entries: NativeDirEntry[] = []
        const prefix = norm.endsWith('/') ? norm : `${norm}/`
        for (const [filePath, bytes] of this.files.entries()) {
            if (filePath.startsWith(prefix)) {
                const rest = filePath.slice(prefix.length)
                if (!rest.includes('/')) {
                    entries.push({ name: rest, isDir: false, isFile: true, sizeBytes: bytes.byteLength })
                }
            }
        }
        for (const dirPath of this.dirs) {
            if (dirPath !== norm && dirPath.startsWith(prefix)) {
                const rest = dirPath.slice(prefix.length)
                if (!rest.includes('/')) {
                    entries.push({ name: rest, isDir: true, isFile: false })
                }
            }
        }
        return entries
    }

    async removeFile(path: string): Promise<void> {
        this.calls.push({ method: 'removeFile', args: [path] })
        const norm = this.normalize(path)
        if (!this.files.has(norm) && !this.symlinks.has(norm)) {
            throw new Error(`removeFile ${path}: not found`)
        }
        this.files.delete(norm)
        this.symlinks.delete(norm)
    }

    async removeDir(path: string): Promise<void> {
        this.calls.push({ method: 'removeDir', args: [path] })
        const norm = this.normalize(path)
        this.dirs.delete(norm)
    }

    async realPath(path: string): Promise<string> {
        this.calls.push({ method: 'realPath', args: [path] })
        const norm = this.normalize(path)
        if (this.symlinks.has(norm)) {
            return this.symlinks.get(norm)!
        }
        return path
    }

    async runtimeInfo(): Promise<{ platform: string; homeDir: string; userConfigDir: string; tempDir: string }> {
        this.calls.push({ method: 'runtimeInfo', args: [] })
        return { ...this.info }
    }
}
