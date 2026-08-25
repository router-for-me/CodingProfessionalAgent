import { BrowserWindow, clipboard, dialog, shell } from 'electron'
import * as path from 'node:path'
import * as fs from 'node:fs/promises'
import type { ProjectDirectorySelection, SelectedFileOrFolder } from '../../shared/types.js'

export interface SaveFileOptions {
  defaultPath?: string
  title?: string
  content: string
  filters?: Array<{ name: string; extensions: string[] }>
}

export interface SaveFileResult {
  saved: boolean
  filePath?: string
}

export class DialogService {
  async saveFile(
    options: SaveFileOptions,
    window?: BrowserWindow | null,
  ): Promise<SaveFileResult> {
    const dialogOptions: Electron.SaveDialogOptions = {
      title: options.title || 'Save File',
      defaultPath: options.defaultPath,
      filters: options.filters,
    }

    const result = window
      ? await dialog.showSaveDialog(window, dialogOptions)
      : await dialog.showSaveDialog(dialogOptions)

    if (result.canceled || !result.filePath) {
      return { saved: false }
    }

    try {
      await fs.writeFile(result.filePath, options.content ?? '', 'utf8')
      return {
        saved: true,
        filePath: result.filePath,
      }
    } catch (err: unknown) {
      throw new Error(`Failed to save file "${result.filePath}": ${(err as Error)?.message || err}`)
    }
  }

  async selectFilesAndFolders(
    title?: string,
    window?: BrowserWindow | null,
  ): Promise<SelectedFileOrFolder[]> {
    const options: Electron.OpenDialogOptions = {
      title: title || 'Select Files or Folders',
      properties: ['openFile', 'openDirectory', 'multiSelections'],
    }

    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options)

    if (result.canceled || result.filePaths.length === 0) {
      return []
    }

    const items: SelectedFileOrFolder[] = []
    for (const filePath of result.filePaths) {
      const selectedPath = path.resolve(filePath)
      try {
        const stats = await fs.stat(selectedPath)
        items.push({
          name: path.basename(selectedPath),
          path: selectedPath,
          isDirectory: stats.isDirectory(),
        })
      } catch {
        items.push({
          name: path.basename(selectedPath),
          path: selectedPath,
          isDirectory: false,
        })
      }
    }
    return items
  }

  async selectProjectDirectory(
    title: string,
    window?: BrowserWindow | null,
  ): Promise<ProjectDirectorySelection> {
    const options: Electron.OpenDialogOptions = {
      title: title || 'Select Project Directory',
      properties: ['openDirectory', 'createDirectory'],
    }

    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options)

    if (result.canceled || result.filePaths.length === 0) {
      return { name: '', path: '' }
    }

    const selectedPath = path.resolve(result.filePaths[0])
    try {
      const stats = await fs.stat(selectedPath)
      if (!stats.isDirectory()) {
        throw new Error(`selected path "${selectedPath}" is not a directory`)
      }
      return {
        name: path.basename(selectedPath),
        path: selectedPath,
      }
    } catch (err: unknown) {
      throw new Error(`stat selected project directory "${selectedPath}": ${(err as Error)?.message || err}`)
    }
  }

  async revealInFileManager(targetPath: string): Promise<void> {
    const trimmed = (targetPath || '').trim()
    if (!trimmed) {
      throw new Error('path is required')
    }

    try {
      const stats = await fs.stat(trimmed)
      if (stats.isDirectory()) {
        await shell.openPath(trimmed)
      } else {
        shell.showItemInFolder(trimmed)
      }
    } catch (err: unknown) {
      throw new Error(`stat reveal path: ${(err as Error)?.message || err}`)
    }
  }

  async clipboardSetText(text: string): Promise<void> {
    await clipboard.writeText(text || '')
  }

  async clipboardGetText(): Promise<string> {
    return clipboard.readText()
  }
}
