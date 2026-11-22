// Previews: decoding, uniformity (A39) and comparison with the expected previews within a tolerance.

import { PNG } from 'pngjs'

export interface Picture {
  width: number
  height: number
  /** RGBA, 8 bits per channel. */
  data: Buffer
}

export function decodePng(bytes: Buffer): Picture {
  const png = PNG.sync.read(bytes)
  return { width: png.width, height: png.height, data: png.data }
}

/** Why a preview is not a real rendering: blank, transparent, single colour (A39). */
export function uniformity(picture: Picture): string | undefined {
  if (picture.width === 0 || picture.height === 0) return 'the preview is empty'
  const colours = new Set<number>()
  let opaque = false
  for (let i = 0; i < picture.data.length; i += 4) {
    const alpha = picture.data[i + 3] ?? 0
    if (alpha > 0) opaque = true
    colours.add(picture.data.readUInt32BE(i))
    if (colours.size > 1 && opaque) return undefined
  }
  if (!opaque) return 'the preview is fully transparent'
  return `the preview has ${colours.size} colour${colours.size === 1 ? '' : 's'}`
}

/**
 * The tolerance a kit states in `expected/tolerance.json`. KHP does not fix its keys; khp check
 * reads `maxChannelDelta` (the largest difference of one channel that still counts as equal) and
 * `maxDifferentPixels` (how many pixels may differ by more), both 0 when absent.
 */
export interface Tolerance {
  maxChannelDelta: number
  maxDifferentPixels: number
}

export function readTolerance(value: unknown): Tolerance {
  const object = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
  const number = (key: string) => (typeof object[key] === 'number' && (object[key] as number) >= 0 ? (object[key] as number) : 0)
  return { maxChannelDelta: number('maxChannelDelta'), maxDifferentPixels: number('maxDifferentPixels') }
}

/** Why `actual` differs from `expected` beyond the tolerance, or undefined when it does not. */
export function compare(actual: Picture, expected: Picture, tolerance: Tolerance): string | undefined {
  if (actual.width !== expected.width || actual.height !== expected.height) {
    return `the preview is ${actual.width} × ${actual.height}, the expected preview ${expected.width} × ${expected.height}`
  }
  let different = 0
  for (let i = 0; i < actual.data.length; i += 4) {
    for (let channel = 0; channel < 4; channel++) {
      if (Math.abs((actual.data[i + channel] ?? 0) - (expected.data[i + channel] ?? 0)) > tolerance.maxChannelDelta) {
        different++
        break
      }
    }
  }
  if (different > tolerance.maxDifferentPixels) return `${different} pixels differ, the tolerance allows ${tolerance.maxDifferentPixels}`
  return undefined
}
