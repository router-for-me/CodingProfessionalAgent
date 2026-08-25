import { useEffect, useState } from 'react'
import type { ThemeMode } from '@cpa/plugin-api'

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
