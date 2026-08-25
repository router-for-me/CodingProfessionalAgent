import { describe, expect, it } from 'vitest'
import {
  applyAppearanceToDOM,
  getLuminance,
  hexWithAlpha,
  mixRgb,
  parseHex,
  resolveTheme,
} from './theme'

describe('resolveTheme', () => {
  it('returns dark when mode is dark regardless of system', () => {
    expect(resolveTheme('dark', false)).toBe('dark')
    expect(resolveTheme('dark', true)).toBe('dark')
  })

  it('returns light when mode is light regardless of system', () => {
    expect(resolveTheme('light', true)).toBe('light')
    expect(resolveTheme('light', false)).toBe('light')
  })

  it('follows system preference when mode is system', () => {
    expect(resolveTheme('system', true)).toBe('dark')
    expect(resolveTheme('system', false)).toBe('light')
  })
})

describe('color helpers', () => {
  it('parses valid 3-digit and 6-digit hex strings', () => {
    expect(parseHex('#fff')).toEqual({ r: 255, g: 255, b: 255 })
    expect(parseHex('#000')).toEqual({ r: 0, g: 0, b: 0 })
    expect(parseHex('#339CFF')).toEqual({ r: 51, g: 156, b: 255 })
    expect(parseHex('invalid')).toBeNull()
  })

  it('calculates luminance correctly', () => {
    expect(getLuminance({ r: 0, g: 0, b: 0 })).toBe(0)
    expect(getLuminance({ r: 255, g: 255, b: 255 })).toBe(1)
  })

  it('mixes two colors by weight', () => {
    const mixed = mixRgb({ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 }, 0.5)
    expect(mixed).toBe('#808080')
  })

  it('creates rgba string from hex and alpha', () => {
    expect(hexWithAlpha('#ffffff', 0.5)).toBe('rgba(255, 255, 255, 0.5)')
  })
})

describe('applyAppearanceToDOM', () => {
  it('applies custom background and foreground colors to document root variables', () => {
    applyAppearanceToDOM(
      {
        theme: 'dark',
        backgroundColor: '#1E1E2E',
        foregroundColor: '#CDD6F4',
        accentColor: '#CBA6F7',
        contrast: 80,
      },
      true,
    )

    const root = document.documentElement
    expect(root.getAttribute('data-theme')).toBe('dark')
    expect(root.style.getPropertyValue('--bg-app')).toBe('#1E1E2E')
    expect(root.style.getPropertyValue('--text-primary')).toBe('#CDD6F4')
    expect(root.style.getPropertyValue('--accent-blue')).toBe('#CBA6F7')
    expect(root.style.getPropertyValue('--app-contrast')).toBe('80%')
    expect(root.style.getPropertyValue('--text-secondary')).toContain('rgba(205, 214, 244')
    expect(root.style.getPropertyValue('--bg-sidebar')).toBeTruthy()
    expect(root.style.getPropertyValue('--bg-sidebar-hover')).toBeTruthy()
    expect(root.style.getPropertyValue('--bg-composer')).toBeTruthy()
    expect(root.style.getPropertyValue('--bg-composer-bar')).toBeTruthy()
    expect(root.style.getPropertyValue('--border-composer')).toContain('rgba(255, 255, 255')
  })

  it('calculates elevated composer colors from dark background with contrast', () => {
    applyAppearanceToDOM(
      {
        theme: 'dark',
        backgroundColor: '#111111',
        contrast: 60,
      },
      true,
    )

    const root = document.documentElement
    // Composer background should be elevated relative to #111111
    const bgComposer = root.style.getPropertyValue('--bg-composer')
    const bgBar = root.style.getPropertyValue('--bg-composer-bar')
    const borderComposer = root.style.getPropertyValue('--border-composer')

    expect(bgComposer).toBe('#252525')
    expect(bgBar).toBe('#1b1b1b')
    expect(borderComposer).toBe('rgba(255, 255, 255, 0.140)')
  })

  it('calculates elevated composer colors from light background', () => {
    applyAppearanceToDOM(
      {
        theme: 'light',
        backgroundColor: '#f5f5f5',
        contrast: 45,
      },
      false,
    )

    const root = document.documentElement
    expect(root.style.getPropertyValue('--bg-composer')).toBeTruthy()
    expect(root.style.getPropertyValue('--bg-composer-bar')).toBeTruthy()
    expect(root.style.getPropertyValue('--border-composer')).toContain('rgba(0, 0, 0')
  })

  it('applies UI font size and code font size', () => {
    applyAppearanceToDOM(
      {
        theme: 'dark',
        uiFontSize: 16,
        codeFontSize: 14,
      },
      true,
    )
    const root = document.documentElement
    expect(root.style.getPropertyValue('--ui-font-size')).toBe('16px')
    expect(root.style.getPropertyValue('--code-font-size')).toBe('14px')
    expect(root.style.getPropertyValue('zoom')).toBe('114.29%')
  })
})
