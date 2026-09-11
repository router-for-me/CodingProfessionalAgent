import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { app } from 'electron'
import { getAppConfigDirName } from '../utils/version.js'

export interface BinaryServiceOptions {
  customHomeDir?: string
  customResourcesPath?: string
  isPackaged?: boolean
  isDev?: boolean
  customTargetDir?: string
  appPath?: string
}

export class BinaryService {
  private readonly targetDir: string
  private readonly resourcesPath: string
  private readonly isPackaged: boolean
  private readonly appPath: string

  constructor(options?: BinaryServiceOptions) {
    const homeDir = options?.customHomeDir ?? os.homedir()
    const configDirName = getAppConfigDirName(options?.isDev)
    this.targetDir = options?.customTargetDir ?? path.join(homeDir, configDirName, 'bin')
    this.isPackaged = options?.isPackaged ?? (typeof app !== 'undefined' ? app.isPackaged : false)
    this.resourcesPath = options?.customResourcesPath ?? (typeof process !== 'undefined' && process.resourcesPath ? process.resourcesPath : '')
    this.appPath = options?.appPath ?? (typeof app !== 'undefined' && app.getAppPath ? app.getAppPath() : process.cwd())
  }

  public getTargetDir(): string {
    return this.targetDir
  }

  public getExpectedBinaryNames(): string[] {
    const isWin = process.platform === 'win32'
    return isWin ? ['rg.exe', 'fd.exe'] : ['rg', 'fd']
  }

  public ensureBinaries(): string[] {
    try {
      fs.mkdirSync(this.targetDir, { recursive: true })
    } catch {
      // Ignore mkdir error if directory already exists
    }

    const binaryNames = this.getExpectedBinaryNames()
    const sourceDir = this.getSourceDir()
    const extracted: string[] = []

    for (const name of binaryNames) {
      const targetPath = path.join(this.targetDir, name)
      const sourcePath = path.join(sourceDir, name)

      if (!fs.existsSync(targetPath)) {
        if (fs.existsSync(sourcePath)) {
          try {
            fs.copyFileSync(sourcePath, targetPath)
            if (process.platform !== 'win32') {
              fs.chmodSync(targetPath, 0o755)
            }
            extracted.push(targetPath)
          } catch (err) {
            console.error(`[BinaryService] Failed to extract ${name} to ${targetPath}:`, err)
          }
        }
      } else {
        extracted.push(targetPath)
      }
    }

    this.injectPath()
    return extracted
  }

  public getSourceDir(): string {
    if (this.isPackaged) {
      return path.join(this.resourcesPath, 'bin')
    }
    return path.resolve(this.appPath, 'resources', 'bin', `${process.platform}-${process.arch}`)
  }

  public injectPath(): void {
    const currentPath = process.env.PATH || ''
    const delimiter = path.delimiter
    const entries = currentPath.split(delimiter).filter(Boolean)

    if (!entries.includes(this.targetDir)) {
      process.env.PATH = `${this.targetDir}${delimiter}${currentPath}`
    }
  }
}
