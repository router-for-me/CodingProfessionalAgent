import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { BinaryService } from '../src/main/services/binaryService.js'

describe('BinaryService', () => {
  let tempHomeDir: string
  let tempResourcesDir: string
  let originalPath: string | undefined

  beforeEach(() => {
    tempHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpa-bin-test-home-'))
    tempResourcesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpa-bin-test-res-'))
    originalPath = process.env.PATH
  })

  afterEach(() => {
    process.env.PATH = originalPath
    try {
      fs.rmSync(tempHomeDir, { recursive: true, force: true })
      fs.rmSync(tempResourcesDir, { recursive: true, force: true })
    } catch {
      // Ignore cleanup error
    }
  })

  it('correctly resolves target bin directory under custom home', () => {
    const service = new BinaryService({
      customHomeDir: tempHomeDir,
      isPackaged: false,
    })
    expect(service.getTargetDir()).toBe(path.join(tempHomeDir, '.coding-professional-agent', 'bin'))
  })

  it('resolves target bin directory under .coding-professional-agent-dev when isDev is true', () => {
    const service = new BinaryService({
      customHomeDir: tempHomeDir,
      isPackaged: false,
      isDev: true,
    })
    expect(service.getTargetDir()).toBe(path.join(tempHomeDir, '.coding-professional-agent-dev', 'bin'))
  })

  it('extracts binaries and makes them executable on unpackaged dev mode', () => {
    const platformKey = `${process.platform}-${process.arch}`
    const fakeDevBinDir = path.join(tempResourcesDir, 'resources', 'bin', platformKey)
    fs.mkdirSync(fakeDevBinDir, { recursive: true })

    const isWin = process.platform === 'win32'
    const rgName = isWin ? 'rg.exe' : 'rg'
    const fdName = isWin ? 'fd.exe' : 'fd'

    fs.writeFileSync(path.join(fakeDevBinDir, rgName), 'fake-rg-binary')
    fs.writeFileSync(path.join(fakeDevBinDir, fdName), 'fake-fd-binary')

    const service = new BinaryService({
      customHomeDir: tempHomeDir,
      isPackaged: false,
      appPath: tempResourcesDir,
    })

    const extracted = service.ensureBinaries()
    const targetDir = service.getTargetDir()

    expect(fs.existsSync(path.join(targetDir, rgName))).toBe(true)
    expect(fs.existsSync(path.join(targetDir, fdName))).toBe(true)
    expect(fs.readFileSync(path.join(targetDir, rgName), 'utf8')).toBe('fake-rg-binary')
    expect(fs.readFileSync(path.join(targetDir, fdName), 'utf8')).toBe('fake-fd-binary')
    expect(extracted).toHaveLength(2)
  })

  it('extracts binaries on packaged production mode from process.resourcesPath', () => {
    const fakeProdBinDir = path.join(tempResourcesDir, 'bin')
    fs.mkdirSync(fakeProdBinDir, { recursive: true })

    const isWin = process.platform === 'win32'
    const rgName = isWin ? 'rg.exe' : 'rg'
    const fdName = isWin ? 'fd.exe' : 'fd'

    fs.writeFileSync(path.join(fakeProdBinDir, rgName), 'prod-rg')
    fs.writeFileSync(path.join(fakeProdBinDir, fdName), 'prod-fd')

    const service = new BinaryService({
      customHomeDir: tempHomeDir,
      isPackaged: true,
      customResourcesPath: tempResourcesDir,
    })

    service.ensureBinaries()
    const targetDir = service.getTargetDir()

    expect(fs.existsSync(path.join(targetDir, rgName))).toBe(true)
    expect(fs.existsSync(path.join(targetDir, fdName))).toBe(true)
  })

  it('injects target directory into process.env.PATH without duplicates', () => {
    const service = new BinaryService({
      customHomeDir: tempHomeDir,
      isPackaged: false,
    })

    service.injectPath()
    const targetDir = service.getTargetDir()
    const firstPath = process.env.PATH || ''
    expect(firstPath.split(path.delimiter)).toContain(targetDir)

    // Call again to ensure no duplicates
    service.injectPath()
    const secondPath = process.env.PATH || ''
    const occurrences = secondPath.split(path.delimiter).filter((p) => p === targetDir).length
    expect(occurrences).toBe(1)
  })
})
