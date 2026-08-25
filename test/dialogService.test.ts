import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const { mockDialog, mockShell, mockClipboard } = vi.hoisted(() => {
  const mockDialog = {
    showSaveDialog: vi.fn(),
    showOpenDialog: vi.fn(),
  }
  const mockShell = {
    openPath: vi.fn(),
    showItemInFolder: vi.fn(),
  }
  const mockClipboard = {
    writeText: vi.fn(),
    readText: vi.fn(),
  }
  return { mockDialog, mockShell, mockClipboard }
})

vi.mock('electron', () => ({
  dialog: mockDialog,
  shell: mockShell,
  clipboard: mockClipboard,
  BrowserWindow: vi.fn(),
}))

import { DialogService } from '../src/main/services/dialogService.js'

describe('DialogService', () => {
  let service: DialogService
  let tempDir: string

  beforeEach(async () => {
    vi.clearAllMocks()
    service = new DialogService()
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cpa-dialog-test-'))
  })

  afterEach(async () => {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {})
    }
  })

  describe('saveFile', () => {
    it('returns { saved: false } when dialog is canceled', async () => {
      mockDialog.showSaveDialog.mockResolvedValueOnce({
        canceled: true,
        filePath: undefined,
      })

      const result = await service.saveFile({
        content: '# Report content',
        defaultPath: 'report.md',
        title: 'Save Report',
      })

      expect(result).toEqual({ saved: false })
      expect(mockDialog.showSaveDialog).toHaveBeenCalledWith({
        title: 'Save Report',
        defaultPath: 'report.md',
        filters: undefined,
      })
    })

    it('returns { saved: false } when filePath is empty string', async () => {
      mockDialog.showSaveDialog.mockResolvedValueOnce({
        canceled: false,
        filePath: '',
      })

      const result = await service.saveFile({
        content: 'test',
      })

      expect(result).toEqual({ saved: false })
    })

    it('writes content to target file and returns { saved: true, filePath }', async () => {
      const targetFilePath = path.join(tempDir, 'output.md')
      mockDialog.showSaveDialog.mockResolvedValueOnce({
        canceled: false,
        filePath: targetFilePath,
      })

      const content = '# CPA Performance Report\n\n- Duration: 5s\n'
      const filters = [{ name: 'Markdown', extensions: ['md'] }]
      const result = await service.saveFile({
        content,
        defaultPath: 'output.md',
        title: 'Export Performance Report',
        filters,
      })

      expect(result).toEqual({
        saved: true,
        filePath: targetFilePath,
      })

      expect(mockDialog.showSaveDialog).toHaveBeenCalledWith({
        title: 'Export Performance Report',
        defaultPath: 'output.md',
        filters,
      })

      const savedContent = await fs.readFile(targetFilePath, 'utf8')
      expect(savedContent).toBe(content)
    })

    it('passes window parameter to showSaveDialog when provided', async () => {
      const targetFilePath = path.join(tempDir, 'window-save.txt')
      mockDialog.showSaveDialog.mockResolvedValueOnce({
        canceled: false,
        filePath: targetFilePath,
      })

      const mockWindow = { id: 1 } as any
      const result = await service.saveFile(
        {
          content: 'saved with window',
          defaultPath: 'window-save.txt',
        },
        mockWindow,
      )

      expect(result.saved).toBe(true)
      expect(mockDialog.showSaveDialog).toHaveBeenCalledWith(
        mockWindow,
        {
          title: 'Save File',
          defaultPath: 'window-save.txt',
          filters: undefined,
        },
      )

      const savedContent = await fs.readFile(targetFilePath, 'utf8')
      expect(savedContent).toBe('saved with window')
    })

    it('throws wrapped error when fs.writeFile rejects', async () => {
      const invalidFilePath = path.join(tempDir, 'non_existent_dir_12345', 'file.txt')
      mockDialog.showSaveDialog.mockResolvedValueOnce({
        canceled: false,
        filePath: invalidFilePath,
      })

      await expect(
        service.saveFile({
          content: 'failed save',
          defaultPath: 'file.txt',
        }),
      ).rejects.toThrow(`Failed to save file "${invalidFilePath}":`)
    })
  })

  describe('selectFilesAndFolders', () => {
    it('returns empty array when canceled', async () => {
      mockDialog.showOpenDialog.mockResolvedValueOnce({
        canceled: true,
        filePaths: [],
      })

      const result = await service.selectFilesAndFolders('Select Files')
      expect(result).toEqual([])
    })

    it('returns selected files and folders with stat information', async () => {
      const subDir = path.join(tempDir, 'subfolder')
      await fs.mkdir(subDir)
      const file = path.join(tempDir, 'file.txt')
      await fs.writeFile(file, 'hello')

      mockDialog.showOpenDialog.mockResolvedValueOnce({
        canceled: false,
        filePaths: [subDir, file],
      })

      const result = await service.selectFilesAndFolders()
      expect(result).toHaveLength(2)
      expect(result[0]).toEqual({
        name: 'subfolder',
        path: subDir,
        isDirectory: true,
      })
      expect(result[1]).toEqual({
        name: 'file.txt',
        path: file,
        isDirectory: false,
      })
    })
  })

  describe('selectProjectDirectory', () => {
    it('returns empty result when canceled', async () => {
      mockDialog.showOpenDialog.mockResolvedValueOnce({
        canceled: true,
        filePaths: [],
      })

      const result = await service.selectProjectDirectory('Select Project')
      expect(result).toEqual({ name: '', path: '' })
    })

    it('returns selected directory name and path', async () => {
      const projDir = path.join(tempDir, 'my-project')
      await fs.mkdir(projDir)

      mockDialog.showOpenDialog.mockResolvedValueOnce({
        canceled: false,
        filePaths: [projDir],
      })

      const result = await service.selectProjectDirectory('Select Project')
      expect(result).toEqual({
        name: 'my-project',
        path: projDir,
      })
    })

    it('throws error when selected path is not a directory', async () => {
      const file = path.join(tempDir, 'test.txt')
      await fs.writeFile(file, 'test')

      mockDialog.showOpenDialog.mockResolvedValueOnce({
        canceled: false,
        filePaths: [file],
      })

      await expect(service.selectProjectDirectory('Select Project')).rejects.toThrow(
        /not a directory/,
      )
    })
  })

  describe('revealInFileManager', () => {
    it('throws error when path is empty', async () => {
      await expect(service.revealInFileManager('')).rejects.toThrow('path is required')
    })

    it('calls shell.openPath for directory', async () => {
      const dir = path.join(tempDir, 'folder')
      await fs.mkdir(dir)

      await service.revealInFileManager(dir)
      expect(mockShell.openPath).toHaveBeenCalledWith(dir)
    })

    it('calls shell.showItemInFolder for file', async () => {
      const file = path.join(tempDir, 'file.txt')
      await fs.writeFile(file, 'test')

      await service.revealInFileManager(file)
      expect(mockShell.showItemInFolder).toHaveBeenCalledWith(file)
    })
  })

  describe('clipboard operations', () => {
    it('sets and gets clipboard text', async () => {
      mockClipboard.readText.mockReturnValueOnce('copied text')

      await service.clipboardSetText('hello world')
      expect(mockClipboard.writeText).toHaveBeenCalledWith('hello world')

      const text = await service.clipboardGetText()
      expect(text).toBe('copied text')
    })
  })
})
