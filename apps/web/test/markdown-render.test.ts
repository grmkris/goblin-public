import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { defaultComponents } from 'streamdown'
import { describe, expect, it } from 'vitest'
import { ChatMarkdown, PLAIN } from '../src/components/parts/markdown.tsx'
import { ToolMarkdown } from '../src/components/parts/tool-markdown.tsx'

const chat = (text: string, live = false) => renderToStaticMarkup(createElement(ChatMarkdown, { text, live }))
const tool = (text: string) => renderToStaticMarkup(createElement(ToolMarkdown, { text }))

/** Sources each figure kind can draw. */
const SOURCES = {
  mermaid: 'graph TD\n A-->B',
  chart: '{"type":"bar","x":"month","series":[{"key":"sales"}],"data":[{"month":"Jan","sales":3}]}',
  map: '{"center":[52.52,13.405],"zoom":10}',
} as const

/** A fence fixture: its text, whether the reply is still streaming, and which figures should draw, in order. */
type Fence = { readonly name: string; readonly text: string; readonly live: boolean; readonly draws: readonly string[] }
const PLACES = [
  ['first', ''],
  ['after prose', 'Intro.\n\n'],
  ['after code', '```js\nconsole.log(1)\n```\n\n'],
] as const
const BOTH = [false, true] as const
/** Every figure kind, fence character and place, open and closed, streaming and settled. */
const fences: Fence[] = (['mermaid', 'chart', 'map'] as const).flatMap((kind) =>
  ['```', '~~~'].flatMap((mark) =>
    PLACES.flatMap(([where, before]) =>
      BOTH.flatMap((closed) =>
        BOTH.map((live) => ({
          name: `${kind} ${mark[0] === '`' ? 'backtick' : 'tilde'} ${where} ${closed ? 'closed' : 'open'}`,
          text: `${before}${mark}${kind}\n${SOURCES[kind]}${closed ? `\n${mark}` : ''}`,
          live,
          // The one rule: while a reply streams, a figure whose fence is still open stays code.
          draws: closed || !live ? [kind] : [],
        })),
      ),
    ),
  ),
)
/** CommonMark corners: a fence closes only with the same character, at least as long. */
for (const [name, text, open] of [
  ['a longer fence a shorter one cannot close', 'Intro.\n\n````mermaid\ngraph TD\n A-->B\n```', true],
  ['a longer fence closed by a longer one', 'Intro.\n\n````mermaid\ngraph TD\n A-->B\n`````', false],
  ['a backtick fence a tilde cannot close', 'Intro.\n\n```mermaid\ngraph TD\n A-->B\n~~~', true],
  ['an open fence in a list', '1. Steps\n\n   ```mermaid\n   graph TD\n    A-->B', true],
  ['a closed fence in a list', '1. Steps\n\n   ```mermaid\n   graph TD\n    A-->B\n   ```', false],
] as const)
  for (const live of [false, true]) fences.push({ name, text, live, draws: open && live ? [] : ['mermaid'] })
// A closing line with text after it does not close a fence, but Streamdown calls the block whole: the figure is offered
// one batch early with that line still in its source, so it cannot draw and shows its code until the fence closes.
for (const live of [false, true])
  fences.push({
    name: 'a closing line with text after it',
    text: '```mermaid\ngraph TD\n A-->B\n``` x',
    live,
    draws: ['mermaid'],
  })
for (const live of [false, true])
  fences.push({
    name: 'two figures, the last still open',
    text: `\`\`\`mermaid\n${SOURCES.mermaid}\n\`\`\`\n\n\`\`\`chart\n${SOURCES.chart}`,
    live,
    draws: live ? ['mermaid'] : ['mermaid', 'chart'],
  })
for (const live of [false, true]) {
  fences.push({ name: 'an unknown language', text: 'Intro.\n\n```not-goblin\nx', live, draws: [] })
  fences.push({ name: 'no language', text: 'Intro.\n\n```\nx', live, draws: [] })
  fences.push({ name: 'a backtick in the info string, so no fence', text: '``` mer`maid\ngraph TD', live, draws: [] })
}

/** The figures a render will draw once in the browser (before hydration each shows its code, marked). */
const drawn = (html: string) => [...html.matchAll(/data-figure="(\w+)"/gu)].map((match) => match[1])

describe('chat Markdown through Streamdown', () => {
  it('covers every fence case the react-markdown renderer was checked against', () => {
    expect(fences.length).toBeGreaterThanOrEqual(88)
  })
  it('replaces every Streamdown renderer with its plain element, so typeset sets the text', () => {
    expect(Object.keys(PLAIN).toSorted()).toEqual(Object.keys(defaultComponents).toSorted())
  })
  it.each(fences.map((fence) => [`${fence.name} (${fence.live ? 'live' : 'settled'})`, fence] as const))(
    'draws figures only from whole fences: %s',
    (_name, fence) => {
      expect(drawn(chat(fence.text, fence.live))).toEqual(fence.draws)
    },
  )
  it('renders GitHub-flavoured Markdown as plain elements inside the typeset root', () => {
    const html = chat(
      '| a | b |\n| - | - |\n| 1 | 2 |\n\n- [x] Done\n- [ ] Pending\n\n~~removed~~ https://example.com\n\nNote[^1].\n\n[^1]: Details.',
    )
    expect(html).toMatch(/^<div class="typeset typeset-chat">/u)
    expect(html).toContain('<div class="typeset-scroll"><table>')
    expect(html).toContain('type="checkbox"')
    expect(html).toContain('<del>removed</del>')
    expect(html).toContain('<a href="https://example.com" target="_blank" rel="noreferrer noopener">')
    expect(html).toContain('data-footnotes')
    expect(html).not.toContain('data-streamdown')
  })
  it('never renders raw HTML', () => {
    const html = chat('<script>alert(1)</script>\n\nSome <b>bold</b> text.')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).not.toContain('<script')
    expect(html).not.toContain('<b>')
  })
  it.each(['[x](javascript:alert(1))', '[x](vbscript:msgbox(1))', '[x](data:text/html,hi)'])(
    'keeps a script or data link as text: %s',
    (text) => expect(chat(text)).not.toContain('href'),
  )
  it('keeps an unfinished reply readable while it streams', () => {
    expect(chat('Hello **wor', true)).toContain('<strong>wor</strong>')
    expect(chat('Hello **wor', false)).toContain('**wor')
  })
})

describe('tool Markdown through Streamdown', () => {
  it('replaces the renderers the same way', () => {
    const html = tool('# Title\n\n**bold**')
    expect(html).toMatch(/^<div class="typeset typeset-tool">/u)
    expect(html).toContain('<strong>bold</strong>')
    expect(html).not.toContain('data-streamdown')
  })
})
