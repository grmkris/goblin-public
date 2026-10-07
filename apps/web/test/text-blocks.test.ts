import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AssistantText, MessageText } from '../src/components/parts/text-part.tsx'

const source = '{"kind":"stat","title":"Done","items":[{"label":"Tasks","value":3}]}'
const fence = `\`\`\`mdxcn\n${source}\n\`\`\``

describe('assistant figure Markdown before hydration', () => {
  it('keeps removed mdxcn readable as ordinary code', () => {
    const html = renderToStaticMarkup(createElement(AssistantText, { text: fence }))
    expect(html).toContain('bubble-assistant')
    expect(html).toContain('<pre><code class="language-mdxcn">')
    expect(html).toContain('&quot;title&quot;:&quot;Done&quot;')
    expect(html).not.toContain('kit-loading')
  })
  it('keeps an open streaming mdxcn fence readable even if its JSON is already complete', () => {
    const html = renderToStaticMarkup(createElement(AssistantText, { text: `\`\`\`mdxcn\n${source}`, live: true }))
    expect(html).toContain('<pre><code class="language-mdxcn">')
    expect(html).not.toContain('kit-mdxcn')
  })
  it.each(['{"kind":"future","title":"Unknown"}', '{"kind":', '{"kind":"stat","title":"Empty","items":[]}'])(
    'keeps malformed or unsupported specs readable: %s',
    (invalid) => {
      const html = renderToStaticMarkup(createElement(AssistantText, { text: `\`\`\`mdxcn\n${invalid}\n\`\`\`` }))
      expect(html).toContain('<pre><code class="language-mdxcn">')
    },
  )
  it('keeps mdxcn as code when rendering shared-note Markdown', () => {
    const html = renderToStaticMarkup(createElement(MessageText, { text: fence }))
    expect(html).toContain('<pre><code class="language-mdxcn">')
    expect(html).not.toContain('kit-mdxcn')
  })
})
