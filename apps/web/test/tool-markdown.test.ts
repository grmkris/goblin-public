import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ToolMarkdown } from '../src/components/parts/tool-markdown.tsx'

const render = (text: string) => renderToStaticMarkup(createElement(ToolMarkdown, { text }))

describe('formatted tool Markdown', () => {
  it('sets headings, code and tables in the compact preset', () => {
    const html = render('# Notes\n\n```ts\nconst a = 1\n```\n\n| a | b |\n| - | - |\n| 1 | 2 |')
    expect(html).toContain('class="typeset typeset-tool"')
    expect(html).toContain('<h1>Notes</h1>')
    expect(html).toContain('<pre><code class="language-ts">')
    expect(html).toContain('<div class="typeset-scroll"><table>')
  })
  it('names an image instead of loading it', () => {
    const html = render('![build badge](https://tracker.example/pixel.png)')
    expect(html).not.toContain('<img')
    expect(html).not.toContain('tracker.example')
    expect(html).toContain('build badge')
  })
  it.each(['[docs](docs/ui.md)', '[top](#top)', '[run](javascript:alert(1))'])(
    'keeps the text of a link that is not an absolute web or mail address: %s',
    (text) => {
      const html = render(text)
      expect(html).not.toContain('<a')
      expect(html).not.toContain('href')
    },
  )
  it('opens a web link apart and says where it leads', () => {
    const html = render('[the guide](https://example.com/guide)')
    expect(html).toContain(
      '<a href="https://example.com/guide" title="https://example.com/guide" target="_blank" rel="noreferrer noopener">the guide</a>',
    )
    expect(html).toContain('(example.com)')
  })
  it('does not repeat the host a bare address already shows', () => {
    expect(render('See https://example.com/a.')).not.toContain('(example.com)')
  })
  it('keeps raw HTML visible as text', () => {
    const html = render('<script>alert(1)</script>\n\n<img src="https://x.example/p.png" onerror="alert(1)">')
    expect(html).not.toContain('<script')
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
  })
  it('leaves a diagram fence as code', () => {
    expect(render('```mermaid\ngraph TD; A-->B\n```')).toContain('<pre><code class="language-mermaid">')
  })
})
