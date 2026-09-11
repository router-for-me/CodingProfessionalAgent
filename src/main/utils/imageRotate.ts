import { nativeImage } from 'electron'

/**
 * Rotates an Electron NativeImage clockwise by 45 degrees.
 * Uses bilinear interpolation for smooth antialiased edges.
 */
export function rotateNativeImage45(image: Electron.NativeImage, scale: number = 0.78): Electron.NativeImage {
  if (!image || image.isEmpty?.()) {
    return image
  }

  const size = image.getSize()
  const width = size.width
  const height = size.height

  if (width <= 0 || height <= 0) {
    return image
  }

  // Electron's toBitmap() returns raw pixel data (typically BGRA)
  const srcBitmap = typeof image.toBitmap === 'function' ? image.toBitmap() : null
  const expectedLen = width * height * 4
  if (!srcBitmap || srcBitmap.length < expectedLen) {
    return image
  }

  const outBitmap = Buffer.alloc(expectedLen, 0)

  const cx = (width - 1) / 2
  const cy = (height - 1) / 2

  // Clockwise 45-degree rotation inverse mapping:
  // Rotation angle theta = 45 deg.
  // Inverse rotation theta_inv = -45 deg.
  // cos(-45) = sqrt(2)/2, sin(-45) = -sqrt(2)/2.
  const cosInv = Math.SQRT1_2
  const sinInv = -Math.SQRT1_2

  for (let yd = 0; yd < height; yd += 1) {
    const dy = (yd - cy) / scale
    for (let xd = 0; xd < width; xd += 1) {
      const dx = (xd - cx) / scale

      // Inverse mapping to source coordinates
      const xs = cx + (dx * cosInv - dy * sinInv)
      const ys = cy + (dx * sinInv + dy * cosInv)

      if (xs < 0 || xs >= width - 1 || ys < 0 || ys >= height - 1) {
        if (xs >= -0.5 && xs < width - 0.5 && ys >= -0.5 && ys < height - 0.5) {
          // Near edge boundary clamp
          const clampedX = Math.max(0, Math.min(width - 1, Math.round(xs)))
          const clampedY = Math.max(0, Math.min(height - 1, Math.round(ys)))
          const srcIdx = (clampedY * width + clampedX) * 4
          const dstIdx = (yd * width + xd) * 4
          outBitmap[dstIdx] = srcBitmap[srcIdx]
          outBitmap[dstIdx + 1] = srcBitmap[srcIdx + 1]
          outBitmap[dstIdx + 2] = srcBitmap[srcIdx + 2]
          outBitmap[dstIdx + 3] = srcBitmap[srcIdx + 3]
        }
        continue
      }

      const x0 = Math.floor(xs)
      const y0 = Math.floor(ys)
      const x1 = x0 + 1
      const y1 = y0 + 1

      const wx = xs - x0
      const wy = ys - y0
      const w00 = (1 - wx) * (1 - wy)
      const w10 = wx * (1 - wy)
      const w01 = (1 - wx) * wy
      const w11 = wx * wy

      const idx00 = (y0 * width + x0) * 4
      const idx10 = (y0 * width + x1) * 4
      const idx01 = (y1 * width + x0) * 4
      const idx11 = (y1 * width + x1) * 4

      const dstIdx = (yd * width + xd) * 4

      for (let c = 0; c < 4; c += 1) {
        const val =
          w00 * srcBitmap[idx00 + c] +
          w10 * srcBitmap[idx10 + c] +
          w01 * srcBitmap[idx01 + c] +
          w11 * srcBitmap[idx11 + c]
        outBitmap[dstIdx + c] = Math.round(val)
      }
    }
  }

  if (!nativeImage || typeof nativeImage.createFromBitmap !== 'function') {
    return image
  }

  return nativeImage.createFromBitmap(outBitmap, { width, height })
}
