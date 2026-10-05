import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ThreadPaneHeader } from '../src/components/thread-pane-header.tsx'

const props = { title: 'New thread', onClose: () => undefined }

describe('thread chrome follows its host', () => {
  it('lets the Trellis tab own the title and close action', () => {
    expect(renderToStaticMarkup(createElement(ThreadPaneHeader, { ...props, host: 'workspace' }))).toBe('')
  })
  it('keeps the title and close action for the narrow sheet', () => {
    const html = renderToStaticMarkup(createElement(ThreadPaneHeader, { ...props, host: 'sheet' }))
    expect(html).toContain('New thread')
    expect(html).toContain('aria-label="Close the thread"')
    expect(html).toContain('data-slot="top-bar"')
  })
})
