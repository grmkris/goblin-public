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
  it('renders the little HTML a reply may use', () => {
    const html = chat(
      '| a | b |\n| - | - |\n| one<br>two | x |\n\n<details><summary>More</summary>\n\nHidden **text**\n\n</details>\n\n' +
        'Press <kbd>Ctrl</kbd>, H<sub>2</sub>O, x<sup>2</sup>, <mark>hi</mark>, <del>a</del><ins>b</ins>',
    )
    expect(html).toContain('<td>one<br/>two</td>')
    expect(html).toContain('<details><summary>More</summary>')
    expect(html).toContain('<strong>text</strong>')
    for (const tag of ['kbd', 'sub', 'sup', 'mark', 'del', 'ins']) expect(html).toContain(`<${tag}>`)
  })
  it('keeps nothing that runs, loads or restyles', () => {
    const html = chat(
      '<script>alert(1)</script><style>p{color:red}</style><iframe src="https://x.example"></iframe>' +
        '<div onclick="x()" style="color:red" class="evil" id="perf">div text</div><svg><circle/></svg>',
    )
    for (const gone of [
      '<script',
      'alert(1)',
      '<style',
      'color:red',
      '<iframe',
      'onclick',
      'class="evil"',
      'id="perf"',
      '<svg',
      '<div onclick',
    ])
      expect(html).not.toContain(gone)
    expect(html).toContain('div text')
  })
  it.each([
    '[x](javascript:alert(1))',
    '<a href="javascript:alert(1)">x</a>',
    '[x](vbscript:msgbox(1))',
    '[x](data:text/html,hi)',
    '[x](/relative/path)',
    '<a href="../api/conversations">x</a>',
    '[x](irc://irc.example/room)',
  ])('keeps a link that is not a web or mail address as its text: %s', (text) => {
    const html = chat(text)
    expect(html).not.toContain('href')
    expect(html).toContain('<span>x</span>')
    expect(html).not.toContain('[blocked]')
  })
  it('links a footnote both ways inside the reply, without asking or a new tab', () => {
    const html = chat('Note[^1].\n\n[^1]: Details.')
    expect(html).toContain('<a href="#user-content-fn-1" id="user-content-fnref-1">1</a>')
    expect(html).toContain('<li id="user-content-fn-1">')
    expect(html).toContain('href="#user-content-fnref-1"')
  })
  it('names an image and its host instead of loading it, until the owner asks', () => {
    const html = chat('![quarterly chart](https://tracker.example/pixel.png?d=secret)')
    expect(html).not.toContain('<img')
    expect(html).toContain('<button type="button"')
    expect(html).toContain('quarterly chart')
    expect(html).toContain('tracker.example')
    expect(html).toContain('aria-label="Load image quarterly chart from tracker.example"')
  })
  it.each([
    '![x](data:image/png;base64,AAAA)',
    '![x](javascript:alert(1))',
    '![x](/relative.png)',
    '<img src="x.png" onerror="alert(1)">',
  ])('only names an image that is not a web address: %s', (text) => {
    const html = chat(text)
    expect(html).not.toContain('<img')
    expect(html).not.toContain('<button')
  })
  it('marks a reply still streaming for its caret, and fades its words in; a settled one is plain', () => {
    const live = chat('Writing this now', true)
    expect(live).toMatch(/^<div class="typeset typeset-chat" data-live="">/u)
    expect(live).toContain('data-sd-animate')
    const settled = chat('Writing this now', false)
    expect(settled).not.toContain('data-live')
    expect(settled).not.toContain('data-sd-animate')
  })
  it('keeps an unfinished reply readable while it streams', () => {
    expect(chat('Hello **wor', true)).toMatch(/<strong[^>]*>(?:<span[^>]*>)?wor(?:<\/span>)?<\/strong>/u)
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
