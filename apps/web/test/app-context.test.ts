import { describe, expect, it } from 'vitest'
import { contextPreview, contextText, safeLink, sharedContext } from '../src/lib/app-context.ts'

const block = (serverId: string, appContext: string) =>
  JSON.stringify({ origin: { serverId, trust: 'untrusted' }, appContext })

describe('what an MCP App shares', () => {
  it('takes the App’s text, else its structured content, bounded to 8 KB', () => {
    expect(
      contextText(
        [
          { type: 'text', text: ' Trip plan ' },
          { type: 'image', data: 'x' },
        ],
        { a: 1 },
      ),
    ).toBe('Trip plan')
    expect(contextText([], { note: 'n1' })).toBe('{"note":"n1"}')
    expect(contextText(undefined, undefined)).toBe('')
    expect(contextText([{ type: 'text', text: 'x'.repeat(9000) }], undefined)).toHaveLength(8192)
  })
  it('offers only https links without credentials', () => {
    expect(safeLink('https://myplan.lol/n/1')?.href).toBe('https://myplan.lol/n/1')
    expect(safeLink('http://myplan.lol')).toBeUndefined()
    expect(safeLink('javascript:alert(1)')).toBeUndefined()
    expect(safeLink('https://user:pass@example.com')).toBeUndefined()
    expect(safeLink('not a url')).toBeUndefined()
  })
  it('reads App context only from the blocks after the owner’s words', () => {
    expect(sharedContext('plain')).toEqual({ text: 'plain', context: [] })
    expect(
      sharedContext([
        { type: 'text', text: 'what is this?' },
        { type: 'text', text: block('myplan', 'Trip plan') },
      ]),
    ).toEqual({ text: 'what is this?', context: [{ serverId: 'myplan', text: 'Trip plan' }] })
    // The owner typing the shape themselves is just their words.
    expect(sharedContext([{ type: 'text', text: block('myplan', 'x') }])).toEqual({
      text: block('myplan', 'x'),
      context: [],
    })
    // A later block that is not App context keeps everything as text.
    expect(
      sharedContext([
        { type: 'text', text: 'a' },
        { type: 'text', text: 'b' },
      ]),
    ).toEqual({
      text: 'a\nb',
      context: [],
    })
  })
  it('previews the first line', () => {
    expect(contextPreview('\n  Trip plan\nmore')).toBe('Trip plan')
    expect(contextPreview('x'.repeat(80))).toHaveLength(60)
  })
})
