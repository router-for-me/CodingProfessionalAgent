import { useEffect, useState } from 'react'
import type { AppSettings, ThemeMode } from '@/types/models'

export type ResolvedTheme = 'dark' | 'light'

/**
 * Resolve a ThemeMode setting into a concrete dark/light theme.
 * When mode is "system", follow the OS prefers-color-scheme preference.
 */
export function resolveTheme(mode: ThemeMode, systemDark: boolean): ResolvedTheme {
  if (mode === 'dark') return 'dark'
  if (mode === 'light') return 'light'
  return systemDark ? 'dark' : 'light'
}

export function useResolvedTheme(themeMode: ThemeMode): ResolvedTheme {
  const [systemDark, setSystemDark] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false
    return window.matchMedia?.('(prefers-color-scheme: dark)')?.matches ?? false
  })

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => setSystemDark(media.matches)
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [])

  return resolveTheme(themeMode, systemDark)
}

export interface ThemePreset {
  id: string
  label: string
  accent: string
  bg: string
  fg: string
  contrast: number
  isDark: boolean
}

export const DARK_THEME_PRESETS: ThemePreset[] = [
  {
    id: 'codex',
    label: 'CPA',
    accent: '#339CFF',
    bg: '#181818',
    fg: '#FFFFFF',
    contrast: 60,
    isDark: true,
  },
  {
    id: 'github-dark',
    label: 'GitHub Dark',
    accent: '#58a6ff',
    bg: '#0d1117',
    fg: '#c9d1d9',
    contrast: 50,
    isDark: true,
  },
  {
    id: 'vscode-dark',
    label: 'VS Code Dark',
    accent: '#007acc',
    bg: '#1e1e1e',
    fg: '#d4d4d4',
    contrast: 55,
    isDark: true,
  },
  {
    id: 'monokai',
    label: 'Monokai',
    accent: '#a6e22e',
    bg: '#272822',
    fg: '#f8f8f2',
    contrast: 70,
    isDark: true,
  },
  {
    id: 'dracula',
    label: 'Dracula',
    accent: '#bd93f9',
    bg: '#282a36',
    fg: '#f8f8f2',
    contrast: 65,
    isDark: true,
  },
  {
    id: 'one-dark',
    label: 'One Dark',
    accent: '#61afef',
    bg: '#282c34',
    fg: '#abb2bf',
    contrast: 50,
    isDark: true,
  },
  {
    id: 'solarized-dark',
    label: 'Solarized Dark',
    accent: '#268bd2',
    bg: '#002b36',
    fg: '#839496',
    contrast: 60,
    isDark: true,
  },
  {
    id: 'nord',
    label: 'Nord',
    accent: '#88c0d0',
    bg: '#2e3440',
    fg: '#eceff4',
    contrast: 55,
    isDark: true,
  },
  {
    id: 'custom',
    label: 'Custom',
    accent: '#339CFF',
    bg: '#181818',
    fg: '#FFFFFF',
    contrast: 60,
    isDark: true,
  },
]

export const LIGHT_THEME_PRESETS: ThemePreset[] = [
  {
    id: 'codex',
    label: 'CPA',
    accent: '#339CFF',
    bg: '#FFFFFF',
    fg: '#1A1C1F',
    contrast: 45,
    isDark: false,
  },
  {
    id: 'github-light',
    label: 'GitHub Light',
    accent: '#0969da',
    bg: '#ffffff',
    fg: '#1f2328',
    contrast: 50,
    isDark: false,
  },
  {
    id: 'vscode-light',
    label: 'VS Code Light',
    accent: '#007acc',
    bg: '#ffffff',
    fg: '#24292e',
    contrast: 50,
    isDark: false,
  },
  {
    id: 'one-light',
    label: 'One Light',
    accent: '#4078f2',
    bg: '#fafafa',
    fg: '#383a42',
    contrast: 45,
    isDark: false,
  },
  {
    id: 'solarized-light',
    label: 'Solarized Light',
    accent: '#268bd2',
    bg: '#fdf6e3',
    fg: '#657b83',
    contrast: 55,
    isDark: false,
  },
  {
    id: 'custom',
    label: 'Custom',
    accent: '#339CFF',
    bg: '#FFFFFF',
    fg: '#1A1C1F',
    contrast: 45,
    isDark: false,
  },
]

export const THEME_PRESETS: ThemePreset[] = DARK_THEME_PRESETS

export function getThemePresets(isDark: boolean): ThemePreset[] {
  return isDark ? DARK_THEME_PRESETS : LIGHT_THEME_PRESETS
}

export const UI_FONT_FAMILIES = [
  {
    value: 'system',
    labelKey: 'settings.appearance.fontFamily.system',
    css: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  },
  { value: 'inter', labelKey: 'Inter', css: '"Inter", -apple-system, sans-serif' },
  {
    value: 'sf-pro',
    labelKey: 'SF Pro',
    css: '"SF Pro Display", "SF Pro Text", -apple-system, sans-serif',
  },
  {
    value: 'pingfang',
    labelKey: 'PingFang SC',
    css: '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif',
  },
  { value: 'segoe-ui', labelKey: 'Segoe UI', css: '"Segoe UI", -apple-system, sans-serif' },
  { value: 'roboto', labelKey: 'Roboto', css: '"Roboto", -apple-system, sans-serif' },
  {
    value: 'helvetica',
    labelKey: 'Helvetica Neue',
    css: '"Helvetica Neue", Helvetica, Arial, sans-serif',
  },
]

export const CODE_FONT_FAMILIES = [
  {
    value: 'system',
    labelKey: 'settings.appearance.fontFamily.system',
    css: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
  },
  {
    value: 'jetbrains-mono',
    labelKey: 'JetBrains Mono',
    css: '"JetBrains Mono", ui-monospace, monospace',
  },
  {
    value: 'fira-code',
    labelKey: 'Fira Code',
    css: '"Fira Code", ui-monospace, monospace',
  },
  { value: 'menlo', labelKey: 'Menlo', css: 'Menlo, ui-monospace, monospace' },
  { value: 'monaco', labelKey: 'Monaco', css: 'Monaco, ui-monospace, monospace' },
  { value: 'consolas', labelKey: 'Consolas', css: 'Consolas, ui-monospace, monospace' },
  {
    value: 'source-code-pro',
    labelKey: 'Source Code Pro',
    css: '"Source Code Pro", ui-monospace, monospace',
  },
]

export const FONT_WEIGHT_OPTIONS = [
  { value: 'normal', labelKey: 'settings.appearance.fontWeight.normal', css: '400' },
  { value: 'medium', labelKey: 'settings.appearance.fontWeight.medium', css: '500' },
  {
    value: 'semibold',
    labelKey: 'settings.appearance.fontWeight.semibold',
    css: '600',
  },
  { value: 'bold', labelKey: 'settings.appearance.fontWeight.bold', css: '700' },
]

export function parseHex(hex: string): { r: number; g: number; b: number } | null {
  const clean = hex.trim().replace(/^#/, '')
  if (clean.length === 3) {
    const r = parseInt(clean[0] + clean[0], 16)
    const g = parseInt(clean[1] + clean[1], 16)
    const b = parseInt(clean[2] + clean[2], 16)
    if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)) {
      return { r, g, b }
    }
  }
  if (clean.length === 6 || clean.length === 8) {
    const r = parseInt(clean.slice(0, 2), 16)
    const g = parseInt(clean.slice(2, 4), 16)
    const b = parseInt(clean.slice(4, 6), 16)
    if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)) {
      return { r, g, b }
    }
  }
  return null
}

export function getLuminance(rgb: { r: number; g: number; b: number }): number {
  return (0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b) / 255
}

export function mixRgb(
  c1: { r: number; g: number; b: number },
  c2: { r: number; g: number; b: number },
  weight: number,
): string {
  const w = Math.max(0, Math.min(1, weight))
  const r = Math.round(c1.r * (1 - w) + c2.r * w)
  const g = Math.round(c1.g * (1 - w) + c2.g * w)
  const b = Math.round(c1.b * (1 - w) + c2.b * w)
  const toHex = (n: number) => n.toString(16).padStart(2, '0')
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`
}

export function hexWithAlpha(hex: string, alpha: number): string {
  const rgb = parseHex(hex)
  if (!rgb) return hex
  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${Math.max(0, Math.min(1, alpha))})`
}

export function applyAppearanceToDOM(
  settings: Partial<AppSettings>,
  systemDark: boolean,
): void {
  if (typeof document === 'undefined') return
  const mode = settings.theme ?? 'dark'
  const resolved = resolveTheme(mode, systemDark)
  const root = document.documentElement

  root.setAttribute('data-theme', resolved)

  // Contrast factor (0.0 to 1.0, e.g. 60% -> 0.60, 45% -> 0.45)
  const contrastVal =
    typeof settings.contrast === 'number' && Number.isFinite(settings.contrast)
      ? Math.max(0, Math.min(100, settings.contrast))
      : resolved === 'dark'
        ? 60
        : 45
  const contrastFactor = contrastVal / 100
  root.style.setProperty('--app-contrast', `${contrastVal}%`)
  root.style.setProperty('--contrast-factor', String(contrastFactor))

  // Accent color
  if (settings.accentColor) {
    root.style.setProperty('--accent-blue', settings.accentColor)
  } else {
    root.style.removeProperty('--accent-blue')
  }

  // Background color - controls entire page background, and contrast-multiplied hover/selection/card surfaces
  const bgColor =
    settings.backgroundColor || (resolved === 'dark' ? '#181818' : '#FFFFFF')
  const bgRgb = parseHex(bgColor)

  if (bgRgb) {
    const isDarkBg = getLuminance(bgRgb) < 0.5
    root.style.setProperty('--bg-app', bgColor)

    if (isDarkBg) {
      // Dark theme surfaces scaled with contrast factor
      const sidebarMix = 0.02 + contrastFactor * 0.05
      const hoverMix = 0.04 + contrastFactor * 0.11
      const elevatedMix = 0.03 + contrastFactor * 0.08
      const borderAlpha = 0.04 + contrastFactor * 0.09
      const cardAlpha = 0.015 + contrastFactor * 0.035

      // Composer calculations relative to background
      const composerBarMix = 0.02 + contrastFactor * 0.035
      const composerMix = 0.045 + contrastFactor * 0.065
      const composerBorderAlpha = 0.08 + contrastFactor * 0.10

      root.style.setProperty(
        '--bg-sidebar',
        mixRgb(bgRgb, { r: 255, g: 255, b: 255 }, sidebarMix),
      )
      root.style.setProperty(
        '--bg-sidebar-hover',
        mixRgb(bgRgb, { r: 255, g: 255, b: 255 }, hoverMix),
      )
      root.style.setProperty(
        '--bg-elevated',
        mixRgb(bgRgb, { r: 255, g: 255, b: 255 }, elevatedMix),
      )
      root.style.setProperty(
        '--bg-card',
        `rgba(255, 255, 255, ${cardAlpha.toFixed(3)})`,
      )
      root.style.setProperty(
        '--bg-composer',
        mixRgb(bgRgb, { r: 255, g: 255, b: 255 }, composerMix),
      )
      root.style.setProperty(
        '--bg-composer-bar',
        mixRgb(bgRgb, { r: 255, g: 255, b: 255 }, composerBarMix),
      )
      root.style.setProperty(
        '--border-subtle',
        `rgba(255, 255, 255, ${borderAlpha.toFixed(3)})`,
      )
      root.style.setProperty(
        '--border-composer',
        `rgba(255, 255, 255, ${composerBorderAlpha.toFixed(3)})`,
      )
    } else {
      // Light theme surfaces scaled with contrast factor
      const sidebarMix = 0.02 + contrastFactor * 0.07
      const hoverMix = 0.04 + contrastFactor * 0.12
      const borderAlpha = 0.03 + contrastFactor * 0.1
      const cardAlpha = 0.01 + contrastFactor * 0.04

      // Composer calculations relative to background
      const composerBarMix = 0.02 + contrastFactor * 0.04
      const composerMix = 0.5 + contrastFactor * 0.45
      const composerBorderAlpha = 0.06 + contrastFactor * 0.08

      root.style.setProperty(
        '--bg-sidebar',
        mixRgb(bgRgb, { r: 0, g: 0, b: 0 }, sidebarMix),
      )
      root.style.setProperty(
        '--bg-sidebar-hover',
        mixRgb(bgRgb, { r: 0, g: 0, b: 0 }, hoverMix),
      )
      root.style.setProperty(
        '--bg-elevated',
        mixRgb(bgRgb, { r: 255, g: 255, b: 255 }, 0.5),
      )
      root.style.setProperty(
        '--bg-card',
        `rgba(0, 0, 0, ${cardAlpha.toFixed(3)})`,
      )
      root.style.setProperty(
        '--bg-composer',
        mixRgb(bgRgb, { r: 255, g: 255, b: 255 }, composerMix),
      )
      root.style.setProperty(
        '--bg-composer-bar',
        mixRgb(bgRgb, { r: 0, g: 0, b: 0 }, composerBarMix),
      )
      root.style.setProperty(
        '--border-subtle',
        `rgba(0, 0, 0, ${borderAlpha.toFixed(3)})`,
      )
      root.style.setProperty(
        '--border-composer',
        `rgba(0, 0, 0, ${composerBorderAlpha.toFixed(3)})`,
      )
    }
  } else {
    root.style.removeProperty('--bg-app')
    root.style.removeProperty('--bg-sidebar')
    root.style.removeProperty('--bg-sidebar-hover')
    root.style.removeProperty('--bg-elevated')
    root.style.removeProperty('--bg-card')
    root.style.removeProperty('--bg-composer')
    root.style.removeProperty('--bg-composer-bar')
    root.style.removeProperty('--border-subtle')
    root.style.removeProperty('--border-composer')
  }

  // Foreground color - controls entire page text, headings, and menu text
  if (settings.foregroundColor) {
    root.style.setProperty('--text-primary', settings.foregroundColor)
    root.style.setProperty(
      '--text-secondary',
      hexWithAlpha(settings.foregroundColor, 0.68),
    )
    root.style.setProperty(
      '--text-muted',
      hexWithAlpha(settings.foregroundColor, 0.45),
    )
  } else {
    root.style.removeProperty('--text-primary')
    root.style.removeProperty('--text-secondary')
    root.style.removeProperty('--text-muted')
  }

  // UI & Code Fonts
  if (settings.uiFontFamily && settings.uiFontFamily !== 'system') {
    const font = UI_FONT_FAMILIES.find((f) => f.value === settings.uiFontFamily)
    if (font) {
      root.style.setProperty('--font-sans', font.css)
      root.style.fontFamily = font.css
    }
  } else {
    root.style.removeProperty('--font-sans')
    root.style.removeProperty('font-family')
  }

  if (settings.uiFontWeight && settings.uiFontWeight !== 'normal') {
    const fontOpt = FONT_WEIGHT_OPTIONS.find((f) => f.value === settings.uiFontWeight)
    if (fontOpt) {
      root.style.setProperty('--font-weight-ui', fontOpt.css)
      root.style.fontWeight = fontOpt.css
    }
  } else {
    root.style.removeProperty('--font-weight-ui')
    root.style.removeProperty('font-weight')
  }

  if (settings.codeFontFamily && settings.codeFontFamily !== 'system') {
    const font = CODE_FONT_FAMILIES.find((f) => f.value === settings.codeFontFamily)
    if (font) {
      root.style.setProperty('--font-mono', font.css)
    }
  } else {
    root.style.removeProperty('--font-mono')
  }

  if (settings.codeFontWeight && settings.codeFontWeight !== 'normal') {
    const fontOpt = FONT_WEIGHT_OPTIONS.find((f) => f.value === settings.codeFontWeight)
    if (fontOpt) {
      root.style.setProperty('--font-weight-code', fontOpt.css)
    }
  } else {
    root.style.removeProperty('--font-weight-code')
  }

  // UI Font Size & Scaling (combined into zoom & font size variables)
  const baseFontSize =
    typeof settings.uiFontSize === 'number' && Number.isFinite(settings.uiFontSize)
      ? settings.uiFontSize
      : 14
  const scaleFactor =
    typeof settings.uiScale === 'number' && Number.isFinite(settings.uiScale)
      ? settings.uiScale / 100
      : 1
  const combinedZoomPercent = (baseFontSize / 14) * scaleFactor * 100

  root.style.setProperty('--ui-font-size', `${baseFontSize}px`)
  root.style.fontSize = `${baseFontSize}px`

  if (Math.abs(combinedZoomPercent - 100) > 0.01) {
    root.style.setProperty('zoom', `${combinedZoomPercent.toFixed(2)}%`)
  } else {
    root.style.removeProperty('zoom')
  }

  // Code Font Size
  const codeFontSize =
    typeof settings.codeFontSize === 'number' && Number.isFinite(settings.codeFontSize)
      ? settings.codeFontSize
      : 12
  root.style.setProperty('--code-font-size', `${codeFontSize}px`)

  // Font smoothing
  if (settings.fontSmoothing !== false) {
    root.style.setProperty('-webkit-font-smoothing', 'antialiased')
    root.style.setProperty('-moz-osx-font-smoothing', 'grayscale')
  } else {
    root.style.setProperty('-webkit-font-smoothing', 'auto')
    root.style.setProperty('-moz-osx-font-smoothing', 'auto')
  }

  // Compact mode
  if (settings.compactMode) {
    root.setAttribute('data-compact', 'true')
  } else {
    root.removeAttribute('data-compact')
  }
}
