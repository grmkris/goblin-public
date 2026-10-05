import { describe, expect, it } from 'vitest'
import { starterManifest, validateManifest } from '../src/manifest.ts'

describe('manifest model catalog', () => {
  it('accepts the available DeepSeek Flash route in a controlled manifest', () => {
    const manifest = {
      ...starterManifest(),
      variants: [{ id: 'deepseek-flash', policy: 'standard' as const, reader: 'deepseek-v4.1-flash' }],
    }

    expect(validateManifest(manifest)).toEqual([])
  })
})
