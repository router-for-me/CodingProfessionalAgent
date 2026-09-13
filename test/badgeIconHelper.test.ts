import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockNativeImage } = vi.hoisted(() => {
  const mockNativeImage = {
    createFromBitmap: vi.fn((buf: Buffer, opts: { width: number; height: number }) => ({
      isEmpty: () => false,
      getSize: () => ({ width: opts.width, height: opts.height }),
      getBitmap: () => buf,
    })),
    createFromDataURL: vi.fn((dataUrl: string) => ({
      toDataURL: () => dataUrl,
      isEmpty: () => false,
    })),
  }
  return { mockNativeImage }
})

vi.mock('electron', () => ({
  nativeImage: mockNativeImage,
}))

import {
  generateWindowsBadgeSvg,
  generateWindowsBadgeBitmap,
  createWindowsBadgeOverlay,
} from '../src/main/services/badgeIconHelper.js'

describe('badgeIconHelper', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('generateWindowsBadgeBitmap', () => {
    it('generates a 1024-byte buffer (16x16x4) with transparent corners and red background', () => {
      const buffer = generateWindowsBadgeBitmap(1)
      expect(buffer).toBeInstanceOf(Buffer)
      expect(buffer.length).toBe(1024)

      // Top-left corner (0, 0) should be transparent (outside circle)
      const cornerOffset = (0 * 16 + 0) * 4
      expect(buffer[cornerOffset]).toBe(0)
      expect(buffer[cornerOffset + 1]).toBe(0)
      expect(buffer[cornerOffset + 2]).toBe(0)
      expect(buffer[cornerOffset + 3]).toBe(0)

      // Red background pixel inside circle (e.g. (7, 1))
      // BGRA format: B=62, G=62, R=229, A=255
      const redOffset = (1 * 16 + 7) * 4
      expect(buffer[redOffset]).toBe(62)
      expect(buffer[redOffset + 1]).toBe(62)
      expect(buffer[redOffset + 2]).toBe(229)
      expect(buffer[redOffset + 3]).toBe(255)

      // Foreground digit pixel for '1' at center (7, 7) should be white
      const whiteOffset = (7 * 16 + 7) * 4
      expect(buffer[whiteOffset]).toBe(255)
      expect(buffer[whiteOffset + 1]).toBe(255)
      expect(buffer[whiteOffset + 2]).toBe(255)
      expect(buffer[whiteOffset + 3]).toBe(255)
    })

    it('generates distinct bitmaps for 1, 9, and 10 (9+)', () => {
      const buf1 = generateWindowsBadgeBitmap(1)
      const buf9 = generateWindowsBadgeBitmap(9)
      const buf10 = generateWindowsBadgeBitmap(10)
      const buf99 = generateWindowsBadgeBitmap(99)

      expect(buf1.length).toBe(1024)
      expect(buf9.length).toBe(1024)
      expect(buf10.length).toBe(1024)
      expect(buf99.length).toBe(1024)

      // Bitmap for 1 should differ from 9
      expect(buf1.equals(buf9)).toBe(false)
      // Bitmap for 9 should differ from 10 (9+)
      expect(buf9.equals(buf10)).toBe(false)
      // Both 10 and 99 should render identical '9+' glyphs
      expect(buf10.equals(buf99)).toBe(true)
    })
  })

  describe('createWindowsBadgeOverlay', () => {
    it('creates nativeImage via createFromBitmap with 16x16 dimensions', () => {
      const icon = createWindowsBadgeOverlay(3)
      expect(icon).toBeDefined()
      expect(icon.isEmpty()).toBe(false)

      expect(mockNativeImage.createFromBitmap).toHaveBeenCalledTimes(1)
      const [calledBuffer, calledOptions] = mockNativeImage.createFromBitmap.mock.calls[0]
      expect(calledBuffer).toBeInstanceOf(Buffer)
      expect(calledBuffer.length).toBe(1024)
      expect(calledOptions).toEqual({ width: 16, height: 16 })
    })
  })

  describe('generateWindowsBadgeSvg', () => {
    it('generates SVG with exact number for 1-9', () => {
      const svg1 = generateWindowsBadgeSvg(1)
      expect(svg1).toContain('>1<')
      expect(svg1).toContain('fill="#E53E3E"')

      const svg9 = generateWindowsBadgeSvg(9)
      expect(svg9).toContain('>9<')
    })

    it('generates 9+ for numbers greater than 9', () => {
      const svg10 = generateWindowsBadgeSvg(10)
      expect(svg10).toContain('>9+<')

      const svg99 = generateWindowsBadgeSvg(99)
      expect(svg99).toContain('>9+<')
    })
  })
})
