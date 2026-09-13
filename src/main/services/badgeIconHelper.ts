import { nativeImage, type NativeImage } from 'electron'

const BADGE_SIZE = 16
const BUFFER_SIZE = BADGE_SIZE * BADGE_SIZE * 4

// 32-bit BGRA format for Electron nativeImage.createFromBitmap (#E53E3E red circle)
const RED_B = 62
const RED_G = 62
const RED_R = 229
const RED_A = 255

// White foreground for digits (#FFFFFF)
const WHITE_B = 255
const WHITE_G = 255
const WHITE_R = 255
const WHITE_A = 255

/**
 * 3x5 dot-matrix bitmap patterns for digits '0'-'9' and '+' symbol.
 * Each entry contains 5 rows, where each row is a 3-bit binary integer.
 */
const DIGIT_PATTERNS: Record<string, number[]> = {
  '0': [0b111, 0b101, 0b101, 0b101, 0b111],
  '1': [0b010, 0b110, 0b010, 0b010, 0b111],
  '2': [0b111, 0b001, 0b111, 0b100, 0b111],
  '3': [0b111, 0b001, 0b111, 0b001, 0b111],
  '4': [0b101, 0b101, 0b111, 0b001, 0b001],
  '5': [0b111, 0b100, 0b111, 0b001, 0b111],
  '6': [0b111, 0b100, 0b111, 0b101, 0b111],
  '7': [0b111, 0b001, 0b001, 0b001, 0b001],
  '8': [0b111, 0b101, 0b111, 0b101, 0b111],
  '9': [0b111, 0b101, 0b111, 0b001, 0b111],
  '+': [0b000, 0b010, 0b111, 0b010, 0b000],
}

/**
 * Helper to write a 32-bit BGRA pixel into buffer.
 */
function setPixel(
  buffer: Buffer,
  x: number,
  y: number,
  b: number,
  g: number,
  r: number,
  a: number,
): void {
  const offset = (y * BADGE_SIZE + x) * 4
  buffer[offset] = b
  buffer[offset + 1] = g
  buffer[offset + 2] = r
  buffer[offset + 3] = a
}

/**
 * Generates an SVG string representation of a badge counter for Windows taskbar overlay.
 * Uses a red circular background (#E53E3E) and white bold typography.
 */
export function generateWindowsBadgeSvg(count: number): string {
  const text = count > 9 ? '9+' : String(count)
  const fontSize = count > 9 ? 8 : 10
  const yOffset = count > 9 ? 11 : 12

  return `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">
  <circle cx="8" cy="8" r="8" fill="#E53E3E" />
  <text x="8" y="${yOffset}" text-anchor="middle" font-size="${fontSize}" font-family="Segoe UI, Arial, sans-serif" font-weight="bold" fill="#FFFFFF">${text}</text>
</svg>`
}

/**
 * Generates a 16x16 raw BGRA bitmap buffer (1024 bytes) containing
 * a red circle (#E53E3E) with crisp 3x5 dot-matrix white digits (1-9 or 9+).
 */
export function generateWindowsBadgeBitmap(count: number): Buffer {
  const buffer = Buffer.alloc(BUFFER_SIZE, 0)
  const cx = 7.5
  const cy = 7.5
  const radiusSq = 56.25 // radius 7.5

  // Render red circular badge background
  for (let y = 0; y < BADGE_SIZE; y += 1) {
    for (let x = 0; x < BADGE_SIZE; x += 1) {
      const dx = x - cx
      const dy = y - cy
      if (dx * dx + dy * dy <= radiusSq) {
        setPixel(buffer, x, y, RED_B, RED_G, RED_R, RED_A)
      }
    }
  }

  // Determine glyphs: '1'-'9' or '9'+
  const glyphs = count > 9 ? ['9', '+'] : [String(Math.max(0, Math.floor(count)))]
  const totalWidth = glyphs.length === 1 ? 3 : 7
  const startX = Math.floor((BADGE_SIZE - totalWidth) / 2)
  const startY = Math.floor((BADGE_SIZE - 5) / 2)

  let curX = startX
  for (const g of glyphs) {
    const pattern = DIGIT_PATTERNS[g] ?? DIGIT_PATTERNS['0']
    for (let r = 0; r < 5; r += 1) {
      const row = pattern[r]
      for (let c = 0; c < 3; c += 1) {
        if ((row >> (2 - c)) & 1) {
          setPixel(buffer, curX + c, startY + r, WHITE_B, WHITE_G, WHITE_R, WHITE_A)
        }
      }
    }
    curX += 3 + 1
  }

  return buffer
}

/**
 * Creates an Electron NativeImage overlay badge for the Windows taskbar.
 * Rasterizes directly to a 16x16 bitmap buffer to avoid SVG decoder limitations.
 */
export function createWindowsBadgeOverlay(count: number): NativeImage {
  const buffer = generateWindowsBadgeBitmap(count)
  return nativeImage.createFromBitmap(buffer, { width: BADGE_SIZE, height: BADGE_SIZE })
}
