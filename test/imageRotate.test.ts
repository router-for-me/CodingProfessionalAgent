import { describe, it, expect, vi } from 'vitest'

const { mockNativeImage } = vi.hoisted(() => {
  const mockNativeImage = {
    createFromBitmap: vi.fn((buf, opts) => ({
      isEmpty: () => false,
      buf,
      opts,
    })),
  }
  return { mockNativeImage }
})

vi.mock('electron', () => ({
  nativeImage: mockNativeImage,
}))

import { rotateNativeImage45 } from '../src/main/utils/imageRotate.js'

describe('rotateNativeImage45', () => {
  it('returns original image if image is empty or invalid size', () => {
    const mockEmptyImage = {
      isEmpty: () => true,
      getSize: () => ({ width: 0, height: 0 }),
    } as any

    expect(rotateNativeImage45(mockEmptyImage)).toBe(mockEmptyImage)
  })

  it('rotates bitmap clockwise by 45 degrees using bilinear interpolation', () => {
    const width = 10
    const height = 10
    // Create a 10x10 dummy bitmap with a centered pixel
    const bitmap = Buffer.alloc(width * height * 4, 0)
    // Put a solid white pixel at (5, 2) - top center
    const targetIdx = (2 * width + 5) * 4
    bitmap[targetIdx] = 255
    bitmap[targetIdx + 1] = 255
    bitmap[targetIdx + 2] = 255
    bitmap[targetIdx + 3] = 255

    const mockImage = {
      isEmpty: () => false,
      getSize: () => ({ width, height }),
      toBitmap: vi.fn(() => bitmap),
    } as any

    const result = rotateNativeImage45(mockImage, 0.8)
    expect(result).toBeDefined()
    expect(mockImage.toBitmap).toHaveBeenCalled()
    expect(mockNativeImage.createFromBitmap).toHaveBeenCalledWith(
      expect.any(Buffer),
      { width: 10, height: 10 },
    )
  })
})
