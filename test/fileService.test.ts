import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { FileService } from '../src/main/services/fileService.js'

describe('FileService', () => {
  let service: FileService
  let tempDir: string

  beforeEach(async () => {
    service = new FileService()
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cpa-file-test-'))
  })

  afterEach(async () => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true })
    } catch {
      // Ignore
    }
  })

  it('gets runtime info', async () => {
    const info = await service.getRuntimeInfo()
    expect(info.platform).toBe(process.platform)
    expect(info.homeDir).toBe(os.homedir())
    expect(info.tempDir).toBe(os.tmpdir())
    expect(typeof info.userConfigDir).toBe('string')
    expect(typeof info.isDebug).toBe('boolean')
  })

  it('supports custom isDebug setting', async () => {
    const debugService = new FileService({ isDebug: true })
    const debugInfo = await debugService.getRuntimeInfo()
    expect(debugInfo.isDebug).toBe(true)

    const prodService = new FileService({ isDebug: false })
    const prodInfo = await prodService.getRuntimeInfo()
    expect(prodInfo.isDebug).toBe(false)
  })

  it('reads and writes files encoded in base64', async () => {
    const filePath = path.join(tempDir, 'test.txt')
    const originalText = 'Hello Electron CPA!'
    const base64Data = Buffer.from(originalText).toString('base64')

    await service.writeFile(filePath, base64Data)
    const readResult = await service.readFile(filePath)

    expect(readResult.dataBase64).toBe(base64Data)
    const decoded = Buffer.from(readResult.dataBase64, 'base64').toString('utf8')
    expect(decoded).toBe(originalText)
  })

  it('readFileIfExists returns data for existing file and null for missing file without throwing', async () => {
    const filePath = path.join(tempDir, 'existing.txt')
    await service.writeFile(filePath, Buffer.from('hello').toString('base64'))

    const existingResult = await service.readFileIfExists(filePath)
    expect(existingResult).not.toBeNull()
    expect(Buffer.from(existingResult!.dataBase64, 'base64').toString('utf8')).toBe('hello')

    const missingResult = await service.readFileIfExists(path.join(tempDir, 'non-existent.txt'))
    expect(missingResult).toBeNull()
  })

  it('fileExists correctly returns true for existing file and false for missing file', async () => {
    const filePath = path.join(tempDir, 'present.txt')
    await service.writeFile(filePath, Buffer.from('abc').toString('base64'))

    expect(await service.fileExists(filePath)).toBe(true)
    expect(await service.fileExists(path.join(tempDir, 'absent.txt'))).toBe(false)
  })

  it('mkdirAll, stat, readDir, removeFile', async () => {
    const subDir = path.join(tempDir, 'sub', 'nested')
    await service.mkdirAll(subDir)

    const testFile = path.join(subDir, 'sample.txt')
    await service.writeFile(testFile, Buffer.from('abc').toString('base64'))

    const stat = await service.stat(testFile)
    expect(stat.isDir).toBe(false)
    expect(stat.name).toBe('sample.txt')
    expect(stat.size).toBe(3)

    const dirEntries = await service.readDir(subDir)
    expect(dirEntries).toHaveLength(1)
    expect(dirEntries[0].name).toBe('sample.txt')
    expect(dirEntries[0].isDir).toBe(false)

    await service.removeFile(testFile)
    const afterEntries = await service.readDir(subDir)
    expect(afterEntries).toHaveLength(0)

    const nestedDir = path.join(tempDir, 'sub')
    await service.removeDir(nestedDir)
    expect(await service.readDir(nestedDir)).toBeNull()
  })

  it('realPath resolves symlinks', async () => {
    const targetFile = path.join(tempDir, 'target.txt')
    await service.writeFile(targetFile, Buffer.from('target').toString('base64'))

    const symlinkPath = path.join(tempDir, 'link.txt')
    await fs.symlink(targetFile, symlinkPath)

    const resolved = await service.realPath(symlinkPath)
    const expected = await fs.realpath(targetFile)
    expect(resolved).toBe(expected)
  })

  it('realPath handles non-existent paths by resolving nearest existing ancestor', async () => {
    const nonExistentPath = path.join(tempDir, 'missing-sub', 'child', 'non-existent.txt')
    const resolved = await service.realPath(nonExistentPath)
    const expectedParent = await fs.realpath(tempDir)
    expect(resolved).toBe(path.join(expectedParent, 'missing-sub', 'child', 'non-existent.txt'))
  })

  it('readDir returns null for non-existent directory without throwing', async () => {
    const nonExistentDir = path.join(tempDir, 'missing-dir')
    const result = await service.readDir(nonExistentDir)
    expect(result).toBeNull()
  })

  it('lookPath finds executables on PATH or throws not found error', async () => {
    const nodePath = await service.lookPath('node')
    expect(typeof nodePath).toBe('string')
    expect(nodePath.length).toBeGreaterThan(0)

    await expect(service.lookPath('non-existent-executable-xyz-12345')).rejects.toThrow(
      /executable file not found/i,
    )
  })
})
