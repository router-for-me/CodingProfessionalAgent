import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, type BrowserWindow, Menu, nativeImage, Tray } from 'electron'
import { isDevEnvironment } from '../utils/version.js'
import { rotateNativeImage45 } from '../utils/imageRotate.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

export type TrayLocale = 'zh-CN' | 'en'

/** Localized labels for the tray context menu (single "Quit CPA" entry). */
const QUIT_LABELS: Record<TrayLocale, string> = {
  'zh-CN': 'Quit CPA',
  en: 'Quit CPA',
}

/** Logical size of the menu bar icon. */
const ICON_SIZE = 18
const ICON_SCALE = 2

/** Embedded 1x template image (18x18 monochrome black/alpha) as bulletproof fallback. */
export const TRAY_TEMPLATE_1X_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABIAAAASCAQAAAD8x0bcAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAACYktHRAD/h4/MvwAAAAd0SU1FB+oIGwgCJ1VMj0oAAAAldEVYdGRhdGU6Y3JlYXRlADIwMjYtMDgtMjdUMDg6MDI6MzkrMDA6MDAb6AglAAAAJXRFWHRkYXRlOm1vZGlmeQAyMDI2LTA4LTI3VDA4OjAyOjM5KzAwOjAwarWwmQAAACh0RVh0ZGF0ZTp0aW1lc3RhbXAAMjAyNi0wOC0yN1QwODowMjozOSswMDowMD2gkUYAAAExSURBVCjPhdC9TpMBFAbgp/0opA1Ji/yUP42yQCOJCAEGIDIxEwavgHgP3oMDF+CECzgxszJCEIaaGolRUn5DIAgtfthSB2Owpco7vnlycs4J1CYmolJdBXfQrB5fqqtoDRk0YVz3/yalzVv22YycsD5q98qabQkJo3Zu2S3qM6+saE5SVNQzuwrVaNKsY03yCgKH+mRNCR39QSkvDXsvoV/cI81o9cO6aW3ySoFmrxWcKel3pteGnx77psW1spQXtqKKVsWFAmUFETGBiKRTJ5qkbAoDFV8deO5STMaeLi3OPZQV88SKDyq/Fz+XM+Zao32NjuxpkPTAOwd/Xxf6KONGIO7SlU7fLbqo/VPJJwMuLFk3hEVX9T5etmPajYyn3ir6Z9LeWNDhnowZuY/UzS/wuFXctxvtXgAAAABJRU5ErkJggg=='

/** Embedded Retina 2x template image (36x36 monochrome black/alpha) as bulletproof fallback. */
export const TRAY_TEMPLATE_2X_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACQAAAAkCAQAAABLCVATAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAACYktHRAD/h4/MvwAAAAd0SU1FB+oIGwgCJ1VMj0oAAAAldEVYdGRhdGU6Y3JlYXRlADIwMjYtMDgtMjdUMDg6MDI6MzkrMDA6MDAb6AglAAAAJXRFWHRkYXRlOm1vZGlmeQAyMDI2LTA4LTI3VDA4OjAyOjM5KzAwOjAwarWwmQAAACh0RVh0ZGF0ZTp0aW1lc3RhbXAAMjAyNi0wOC0yN1QwODowMjozOSswMDowMD2gkUYAAAJ/SURBVEjH1dVfSJYHFMfxTzbNltvFosB4KVzlFv0hgoIIlPQqCoJBWtAqgkW1FgsKHNJFf3cxZFFtrESh4SLQ2sgg3QoUG5biG82EMGK513D4JygjI4unm2dvc6vU9/Vi+12dczjP9zmH85zz8F/T+BHkfG6S35N/1Th3nBmLispFRPRqTa6eNZ6bZYkuk5PBZOm3H3yjPnHMBH+ojnsNvk8U1K5liB/1bWKYG3F7vjzQ5LvRQTLENIT2FNe0OO0329GgauSYOR44J8MpMVf1uBDGG23GTxq9NRLMOoGvcEsNyNHgjExkh80e1mHBcJgTAhtRpB1sADvctVqqmCrpWOW+ra+HTHNHpxRQb5sZekTVyEGxk9K12KsxzG7z498fTolbu91zUcRM0GynqAKLpKtXYY5uaVId8KfP8L65YjrCacY1zyV9cnBIM4iGU7usTpo8XYqlaMcOlfjZR1juroPGvQT1G/AuCjwCJW6h0AOBeWG9ZbbpQLlSMCgXEQND17laqwiOOoybViKw2BVLwC6DmpCp31TUOo7pmpyXMbS9XZ4qxCY0yUcnakV9IE+HYiz1yD7wMQo99MWrppapWzk45CxiuOSEWoGdOOW2Zl+H2eV6ffj6T+By2PE1v2rFbTlY66oe1TimAtz4x0K/QiXuewcH9GGFLnvAAqQIZJqgL8QNo62emok2W0Cl69Z4zyYPbZdtMDx2I9Bqgfkm6nbaFjU6lapzXralgjctx7+VLzAbRcp8Go8uElg/GgysEIgMiSwThEs8Sn3isbfjXpbA7kQwcCQ8JjCQ2MX+S43hX7bNlWQw8ESBLz1JFkOuZwYtTB7EL34YC8z/Vi8AJd7ByLXdRy4AAAAASUVORK5CYII='

/**
 * Creates the menu bar tray icon (template-image friendly on macOS).
 */
export function createTrayIcon(isDev: boolean = isDevEnvironment()): Electron.NativeImage {
  const appPath = app.getAppPath?.() || ''
  const resourcesPath = process.resourcesPath || ''
  const cwd = process.cwd()

  if (isDev) {
    const devCandidatePaths = [
      path.resolve(appPath, 'build/trayTemplate-dev.png'),
      path.resolve(appPath, 'frontend/dist/trayTemplate-dev.png'),
      path.resolve(resourcesPath, 'build/trayTemplate-dev.png'),
      path.resolve(resourcesPath, 'frontend/dist/trayTemplate-dev.png'),
      path.resolve(__dirname, '../../../../build/trayTemplate-dev.png'),
      path.resolve(__dirname, '../../../build/trayTemplate-dev.png'),
      path.resolve(__dirname, '../../build/trayTemplate-dev.png'),
      path.resolve(cwd, 'build/trayTemplate-dev.png'),
      path.resolve(cwd, 'frontend/dist/trayTemplate-dev.png'),
      path.resolve(appPath, 'build/trayTemplate-dev@2x.png'),
      path.resolve(appPath, 'frontend/dist/trayTemplate-dev@2x.png'),
      path.resolve(resourcesPath, 'build/trayTemplate-dev@2x.png'),
      path.resolve(resourcesPath, 'frontend/dist/trayTemplate-dev@2x.png'),
      path.resolve(__dirname, '../../../../build/trayTemplate-dev@2x.png'),
      path.resolve(__dirname, '../../../build/trayTemplate-dev@2x.png'),
      path.resolve(__dirname, '../../build/trayTemplate-dev@2x.png'),
      path.resolve(cwd, 'build/trayTemplate-dev@2x.png'),
      path.resolve(cwd, 'frontend/dist/trayTemplate-dev@2x.png'),
    ]

    for (const devPath of devCandidatePaths) {
      try {
        const img = nativeImage.createFromPath(devPath)
        if (img && !img.isEmpty?.()) {
          const size = img.getSize ? img.getSize() : { width: ICON_SIZE, height: ICON_SIZE }
          const shouldResize = Math.abs(size.width - ICON_SIZE) > 4 || Math.abs(size.height - ICON_SIZE) > 4
          const result = shouldResize && img.resize ? img.resize({ width: ICON_SIZE, height: ICON_SIZE }) : img
          if (process.platform === 'darwin' && result.setTemplateImage) {
            result.setTemplateImage(true)
          }
          return result
        }
      } catch {}
    }
  }

  // Base icon name (trayTemplate.png) automatically associates trayTemplate@2x.png on macOS
  const candidatePaths = [
    path.resolve(appPath, 'build/trayTemplate.png'),
    path.resolve(appPath, 'frontend/dist/trayTemplate.png'),
    path.resolve(resourcesPath, 'build/trayTemplate.png'),
    path.resolve(resourcesPath, 'frontend/dist/trayTemplate.png'),
    path.resolve(__dirname, '../../../../build/trayTemplate.png'),
    path.resolve(__dirname, '../../../build/trayTemplate.png'),
    path.resolve(__dirname, '../../build/trayTemplate.png'),
    path.resolve(__dirname, '../../../../frontend/dist/trayTemplate.png'),
    path.resolve(__dirname, '../../../frontend/dist/trayTemplate.png'),
    path.resolve(__dirname, '../../frontend/dist/trayTemplate.png'),
    path.resolve(cwd, 'build/trayTemplate.png'),
    path.resolve(cwd, 'frontend/dist/trayTemplate.png'),
    // High-DPI fallbacks in case base name is missing
    path.resolve(appPath, 'build/trayTemplate@2x.png'),
    path.resolve(appPath, 'frontend/dist/trayTemplate@2x.png'),
    path.resolve(resourcesPath, 'build/trayTemplate@2x.png'),
    path.resolve(resourcesPath, 'frontend/dist/trayTemplate@2x.png'),
    path.resolve(__dirname, '../../../../build/trayTemplate@2x.png'),
    path.resolve(__dirname, '../../../build/trayTemplate@2x.png'),
    path.resolve(__dirname, '../../build/trayTemplate@2x.png'),
    path.resolve(__dirname, '../../../../frontend/dist/trayTemplate@2x.png'),
    path.resolve(__dirname, '../../../frontend/dist/trayTemplate@2x.png'),
    path.resolve(__dirname, '../../frontend/dist/trayTemplate@2x.png'),
    path.resolve(cwd, 'build/trayTemplate@2x.png'),
    path.resolve(cwd, 'frontend/dist/trayTemplate@2x.png'),
  ]

  for (const candidatePath of candidatePaths) {
    const img = nativeImage.createFromPath(candidatePath)
    if (img && !img.isEmpty?.()) {
      const size = img.getSize ? img.getSize() : { width: ICON_SIZE, height: ICON_SIZE }
      const shouldResize = Math.abs(size.width - ICON_SIZE) > 4 || Math.abs(size.height - ICON_SIZE) > 4
      const resized = shouldResize && img.resize ? img.resize({ width: ICON_SIZE, height: ICON_SIZE }) : img
      const result = isDev ? rotateNativeImage45(resized) : resized
      if (process.platform === 'darwin' && result.setTemplateImage) {
        result.setTemplateImage(true)
      }
      return result
    }
  }

  // Fallback: embedded multi-resolution Template PNG data URLs
  const fallbackImg = nativeImage.createEmpty ? nativeImage.createEmpty() : null
  if (fallbackImg && fallbackImg.addRepresentation) {
    try {
      fallbackImg.addRepresentation({
        scaleFactor: 1.0,
        dataURL: TRAY_TEMPLATE_1X_DATA_URL,
      })
      fallbackImg.addRepresentation({
        scaleFactor: 2.0,
        dataURL: TRAY_TEMPLATE_2X_DATA_URL,
      })
      if (!fallbackImg.isEmpty()) {
        const result = isDev ? rotateNativeImage45(fallbackImg) : fallbackImg
        if (process.platform === 'darwin' && result.setTemplateImage) {
          result.setTemplateImage(true)
        }
        return result
      }
    } catch {
      // If addRepresentation fails, proceed to createFromDataURL
    }
  }

  const imgFromDataUrl = nativeImage.createFromDataURL(TRAY_TEMPLATE_2X_DATA_URL)
  if (imgFromDataUrl && !imgFromDataUrl.isEmpty?.()) {
    const size = imgFromDataUrl.getSize ? imgFromDataUrl.getSize() : { width: ICON_SIZE, height: ICON_SIZE }
    const shouldResize = Math.abs(size.width - ICON_SIZE) > 4 || Math.abs(size.height - ICON_SIZE) > 4
    const resized = shouldResize && imgFromDataUrl.resize
      ? imgFromDataUrl.resize({ width: ICON_SIZE, height: ICON_SIZE })
      : imgFromDataUrl
    const result = isDev ? rotateNativeImage45(resized) : resized
    if (process.platform === 'darwin' && result.setTemplateImage) {
      result.setTemplateImage(true)
    }
    return result
  }

  // Final fallback programmatic generation
  const size = ICON_SIZE * ICON_SCALE
  const buffer = Buffer.alloc(size * size * 4, 0)
  const center = (size - 1) / 2
  const radius = size * 0.32
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = x - center
      const dy = y - center
      if (dx * dx + dy * dy <= radius * radius) {
        const offset = (y * size + x) * 4
        buffer[offset] = 0
        buffer[offset + 1] = 0
        buffer[offset + 2] = 0
        buffer[offset + 3] = 255
      }
    }
  }
  const image = nativeImage.createFromBitmap(buffer, {
    width: size,
    height: size,
    scaleFactor: ICON_SCALE,
  })
  if (process.platform === 'darwin' && image.setTemplateImage) {
    image.setTemplateImage(true)
  }
  return image
}

/**
 * macOS menu bar tray. Left click toggles the main window and dock icon visibility,
 * right click pops up a context menu with a single localized quit item.
 */
export class TrayService {
  private tray: Tray | null = null
  private locale: TrayLocale = 'zh-CN'
  private enabled = false
  private getMainWindow: () => BrowserWindow | null
  private readonly isDev: boolean

  constructor(getMainWindow: () => BrowserWindow | null, isDev?: boolean) {
    this.getMainWindow = getMainWindow
    this.isDev = isDev ?? isDevEnvironment()
  }

  /** Returns whether the tray icon / menu bar mode is currently active. */
  isEnabled(): boolean {
    return this.enabled
  }

  /** Enables/disables the tray icon; keeps current locale when omitted. */
  setEnabled(enabled: boolean, locale?: TrayLocale): void {
    this.enabled = enabled
    if (locale) {
      this.locale = locale
    }
    if (enabled) {
      this.show()
    } else {
      this.hide()
      if (process.platform === 'darwin') {
        app.dock?.show?.()
      }
    }
  }

  /** Updates the localized menu label without changing visibility. */
  setLocale(locale: TrayLocale): void {
    this.locale = locale
  }

  /** Toggles main window visibility. If visible, hides window and dock; otherwise shows them. */
  toggleWindow(): void {
    const win = this.getMainWindow()
    if (!win || win.isDestroyed()) {
      return
    }
    if (win.isVisible() && !win.isMinimized()) {
      this.hideWindow()
    } else {
      this.showWindow()
    }
  }

  /** Hides main window and macOS dock icon. */
  hideWindow(): void {
    const win = this.getMainWindow()
    if (win && !win.isDestroyed()) {
      const doHide = () => {
        win.hide()
        if (process.platform === 'darwin') {
          app.dock?.hide?.()
        }
      }
      if (win.isFullScreen()) {
        win.once('leave-full-screen', doHide)
        win.setFullScreen(false)
      } else {
        doHide()
      }
    }
  }

  /** Shows, restores, and focuses the main window, and shows macOS dock icon. */
  showWindow(): void {
    if (process.platform === 'darwin') {
      app.dock?.show?.()
    }
    const win = this.getMainWindow()
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) {
        win.restore()
      }
      if (!win.isVisible()) {
        win.show()
      }
      win.focus()
    }
  }

  dispose(): void {
    this.hide()
    if (process.platform === 'darwin') {
      app?.dock?.show?.()
    }
  }

  private show(): void {
    if (this.tray) {
      return
    }
    this.tray = new Tray(createTrayIcon(this.isDev))
    this.tray.setToolTip('Coding Professional Agent')
    this.tray.on('click', () => this.toggleWindow())
    this.tray.on('double-click', () => this.toggleWindow())
    this.tray.on('right-click', () => this.popupMenu())
  }

  private hide(): void {
    if (this.tray) {
      this.tray.destroy()
      this.tray = null
    }
  }

  private popupMenu(): void {
    if (!this.tray) {
      return
    }
    const menu = Menu.buildFromTemplate([
      {
        label: QUIT_LABELS[this.locale],
        click: () => {
          app.quit()
        },
      },
    ])
    this.tray.popUpContextMenu(menu)
  }
}
