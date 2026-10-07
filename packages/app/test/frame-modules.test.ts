import { describe, expect, it } from 'vitest'
import { frameRequire, provide } from '../src/ui/modules.ts'

describe("an app frame's modules", () => {
  it('names the bundle that failed when a module a view may import is missing', () => {
    expect(() => frameRequire('@goblin/kit/diagram')).toThrow(
      '"@goblin/kit/diagram" is unavailable: goblin\'s diagrams bundle failed to load in this frame.',
    )
    expect(() => frameRequire('left-pad')).toThrow('"left-pad" is not available in an app\'s view.')
    expect(() => frameRequire('@goblin/kit/mdxcn')).toThrow('"@goblin/kit/mdxcn" is not available in an app\'s view.')
    provide({ '@goblin/kit/diagram': { Diagram: 'diagram' } })
    expect(frameRequire('@goblin/kit/diagram')).toEqual({ Diagram: 'diagram' })
  })
})
