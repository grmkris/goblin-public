import { describe, expect, it } from 'vitest'
import { blockKind } from '../src/lib/fences.ts'

describe('block kinds', () => {
  it('name the languages the chat draws, and nothing else', () => {
    expect(blockKind(['language-mermaid'])).toBe('mermaid')
    expect(blockKind('language-chart')).toBe('chart')
    expect(blockKind(['hljs', 'language-map'])).toBe('map')
    expect(blockKind('language-mdxcn')).toBeUndefined()
    expect(blockKind(['language-ts'])).toBeUndefined()
    expect(blockKind(undefined)).toBeUndefined()
  })
})
