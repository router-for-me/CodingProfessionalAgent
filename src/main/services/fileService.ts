import * as fs from 'node:fs/promises'
import * as fsSync from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { DirEntry, FileData, FileStat, RuntimeInfo } from '../../shared/types.js'

export class FileService {
  private isDebug: boolean

  constructor(options?: { isDebug?: boolean }) {
    this.isDebug = options?.isDebug ?? (process.env.NODE_ENV === 'development')
  }

  async getRuntimeInfo(): Promise<RuntimeInfo> {
    const homeDir = os.homedir()
    let userConfigDir: string

    if (process.platform === 'win32') {
      userConfigDir = process.env.APPDATA || path.join(homeDir, 'AppData', 'Roaming')
    } else if (process.platform === 'darwin') {
      userConfigDir = path.join(homeDir, 'Library', 'Application Support')
    } else {
      userConfigDir = process.env.XDG_CONFIG_HOME || path.join(homeDir, '.config')
    }

    const isDev = this.isDebug
    const configDirName = isDev ? '.coding-professional-agent-dev' : '.coding-professional-agent'

    return {
      platform: process.platform,
      userConfigDir,
      tempDir: os.tmpdir(),
      homeDir,
      isDebug: isDev,
      appConfigDirName: configDirName,
    }
  }

  async readFile(filePath: string): Promise<FileData> {
    const data = await fs.readFile(filePath)
    return {
      dataBase64: data.toString('base64'),
    }
  }

  async readFileIfExists(filePath: string): Promise<FileData | null> {
    try {
      const data = await fs.readFile(filePath)
      return {
        dataBase64: data.toString('base64'),
      }
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
        return null
      }
      throw err
    }
  }

  async fileExists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath)
      return true
    } catch {
      return false
    }
  }

  async writeFile(filePath: string, dataBase64: string): Promise<void> {
    const data = Buffer.from(dataBase64, 'base64')
    const dir = path.dirname(filePath)
    await fs.mkdir(dir, { recursive: true })
    const tempPath = `${filePath}.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    try {
      await fs.writeFile(tempPath, data)
      await fs.rename(tempPath, filePath)
    } catch (err) {
      try {
        await fs.unlink(tempPath)
      } catch {
        // Ignore temp file cleanup failure
      }
      throw err
    }
  }

  async mkdirAll(dirPath: string): Promise<void> {
    await fs.mkdir(dirPath, { recursive: true })
  }

  async removeFile(filePath: string): Promise<void> {
    await fs.unlink(filePath)
  }

  async removeDir(dirPath: string): Promise<void> {
    await fs.rm(dirPath, { recursive: true, force: true })
  }

  async stat(targetPath: string): Promise<FileStat> {
    const stats = await fs.stat(targetPath)
    return {
      name: path.basename(targetPath),
      size: stats.size,
      mode: stats.mode,
      isDir: stats.isDirectory(),
    }
  }

  async readDir(dirPath: string): Promise<DirEntry[] | null> {
    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true })
      return entries.map((entry) => ({
        name: entry.name,
        isDir: entry.isDirectory(),
        isSymbolicLink: entry.isSymbolicLink(),
      }))
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
        return null
      }
      throw err
    }
  }

  async realPath(targetPath: string): Promise<string> {
    const resolved = path.resolve(targetPath)
    try {
      return await fs.realpath(resolved)
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
        return await this.resolveNonExistentRealPath(resolved)
      }
      throw err
    }
  }

  private async resolveNonExistentRealPath(targetPath: string): Promise<string> {
    const segments: string[] = []
    let current = path.resolve(targetPath)

    while (true) {
      const parent = path.dirname(current)
      const base = path.basename(current)
      if (base) {
        segments.unshift(base)
      }
      if (parent === current || parent === path.parse(current).root) {
        try {
          const rootReal = await fs.realpath(parent)
          return path.join(rootReal, ...segments)
        } catch {
          return targetPath
        }
      }
      try {
        const parentReal = await fs.realpath(parent)
        return path.join(parentReal, ...segments)
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
          current = parent
          continue
        }
        return targetPath
      }
    }
  }

  async lookPath(name: string): Promise<string> {
    if (path.isAbsolute(name) || name.includes(path.sep)) {
      try {
        await fs.access(name, fsSync.constants.X_OK)
        return path.resolve(name)
      } catch {
        throw new Error(`look path "${name}": executable file not found`)
      }
    }

    const envPath = process.env.PATH || ''
    const pathEntries = envPath.split(path.delimiter).filter(Boolean)
    const isWindows = process.platform === 'win32'
    const pathExts = isWindows
      ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
      : ['']

    for (const entry of pathEntries) {
      for (const ext of pathExts) {
        const fullPath = path.join(entry, isWindows && !name.includes('.') ? `${name}${ext}` : name)
        try {
          if (isWindows) {
            await fs.access(fullPath)
            return fullPath
          }
          await fs.access(fullPath, fsSync.constants.X_OK)
          return fullPath
        } catch {
          // Continue searching
        }
      }
    }

    throw new Error(`look path "${name}": executable file not found in $PATH`)
  }
}
