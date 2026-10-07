import { describe, expect, it } from 'vitest'
import { blockKind, openFenceAt } from '../src/lib/fences.ts'

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

describe('open fences', () => {
  it('find the fence a streaming reply has not closed yet', () => {
    const text = 'Here:\n```mermaid\ngraph LR\n  A --> B'
    expect(openFenceAt(text)).toBe(6)
    expect(openFenceAt(`${text}\n\`\`\`\nDone.`)).toBeUndefined()
  })
  it('tracks a removed language as an ordinary streaming code fence', () => {
    const text = 'Progress:\n```mdxcn\n{"kind":"stat","title":"Done","items":[{"label":"Tasks","value":3}]}'
    expect(openFenceAt(text)).toBe(10)
    expect(openFenceAt(`${text}\n\`\`\``)).toBeUndefined()
  })
  it('close only on the same character, at least as long, with nothing after it', () => {
    expect(openFenceAt('````chart\n{}\n```\n')).toBe(0)
    expect(openFenceAt('~~~map\n{}\n```\n')).toBe(0)
    expect(openFenceAt('```chart\n{}\n``` x\n')).toBe(0)
    expect(openFenceAt('```chart\n{}\n~~~\n```')).toBeUndefined()
  })
  it('see no fence in a backtick line with a backtick in its info, or in plain prose', () => {
    expect(openFenceAt('``` a`b\nno fence')).toBeUndefined()
    expect(openFenceAt('Use `code` inline.')).toBeUndefined()
  })
})
