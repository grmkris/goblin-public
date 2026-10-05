import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { readCollapsed, ThreadPreviewBlock } from '../src/components/thread-preview.tsx'

const view = {
  id: '9',
  kind: 'thread' as const,
  archived: false,
  busy: true,
  createdAt: 0,
  replies: 2,
  title: 'Car search',
}

describe('inline thread blocks', () => {
  it('renders expanded by default with a compact header, busy mark and an explicit opening action', () => {
    const html = renderToStaticMarkup(createElement(ThreadPreviewBlock, { view, now: 0, onOpen: () => undefined }))
    expect(html).toContain('aria-expanded="true"')
    expect(html).toContain('2 replies')
    expect(html).toContain('Car search')
    expect(html).toContain('Open thread')
    expect(html).toContain('aria-label="Working"')
    expect(html).toContain('Loading preview')
  })
  it('gives owner-started threads the same expanded block', () => {
    const html = renderToStaticMarkup(
      createElement(ThreadPreviewBlock, { view, now: 0, onOpen: () => undefined, started: true }),
    )
    expect(html).toContain('You started a thread')
    expect(html).toContain('thread-preview-body')
    expect(html).not.toContain('<button><button')
  })
  it('reads a per-thread device preference and survives denied storage', () => {
    const calls: string[] = []
    expect(
      readCollapsed('9', {
        getItem: (key) => {
          calls.push(key)
          return 'collapsed'
        },
      }),
    ).toBe(true)
    expect(calls).toEqual(['purrable:thread-preview:9'])
    expect(readCollapsed('10', { getItem: () => null })).toBe(false)
    expect(
      readCollapsed('9', {
        getItem: () => {
          throw new Error('denied')
        },
      }),
    ).toBe(false)
  })
})
