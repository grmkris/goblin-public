import { describe, expect, it } from 'vitest'
import { contextPreview, contextText, safeLink, sharedContext } from '../src/lib/app-context.ts'

const block = (connectionId: string, appContext: string) =>
  JSON.stringify({ origin: { connectionId, trust: 'untrusted' }, appContext })

describe('what an App shares', () => {
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
    ).toEqual({ text: 'what is this?', context: [{ from: 'myplan', text: 'Trip plan' }] })
    // An agent app is named by itself.
    const agentBlock = JSON.stringify({ origin: { app: 'task-board', trust: 'untrusted' }, appContext: '3 tasks' })
    expect(
      sharedContext([
        { type: 'text', text: 'and these?' },
        { type: 'text', text: agentBlock },
      ]),
    ).toEqual({ text: 'and these?', context: [{ from: 'task-board', text: '3 tasks' }] })
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
  it('reads the files attached to a message, before any App context', () => {
    const file = { path: '/uploads/2026-10-06/data.csv', name: 'data.csv', size: 120, mimeType: 'text/csv' }
    const files = JSON.stringify({ attachments: [file] })
    expect(
      sharedContext([
        { type: 'text', text: 'summarise this' },
        { type: 'text', text: files },
        { type: 'text', text: block('myplan', 'Trip plan') },
      ]),
    ).toEqual({
      text: 'summarise this',
      context: [{ from: 'myplan', text: 'Trip plan' }],
      attachments: [file],
    })
    // The same shape typed by the owner, or naming a path outside their files, stays words.
    expect(sharedContext([{ type: 'text', text: files }])).toEqual({ text: files, context: [] })
    const outside = JSON.stringify({ attachments: [{ ...file, path: '/etc/passwd' }] })
    expect(
      sharedContext([
        { type: 'text', text: 'x' },
        { type: 'text', text: outside },
      ]),
    ).toEqual({ text: `x\n${outside}`, context: [] })
  })
  it('previews the first line', () => {
    expect(contextPreview('\n  Trip plan\nmore')).toBe('Trip plan')
    expect(contextPreview('x'.repeat(80))).toHaveLength(60)
  })
})
