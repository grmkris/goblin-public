import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { JsonView, ToolPayload, type ToolPayloadView } from '@goblin/ui'
import { outputBlocks, payloadView } from '../src/lib/tool-payload.ts'

const envelope = (content: readonly unknown[], structuredContent: unknown = '[unsupported]') => ({
  origin: { serverId: 'fixture', trust: 'untrusted' },
  structuredContent,
  content,
})
const text = (value: string) => ({ type: 'text', text: value })
const renderJson = (value: unknown) => renderToStaticMarkup(createElement(JsonView, { value }))
const renderPayload = (view: ToolPayloadView) =>
  renderToStaticMarkup(createElement(ToolPayload, { label: 'Output', raw: 'raw', view, children: 'shown' }))

describe('tool output presentation', () => {
  it('uses structured MCP output despite the model text origin prefix, without repeating its JSON text', () => {
    const value = { documents: [{ title: 'A' }], hasMore: false }
    const raw = '{"origin":{"serverId":"fixture","trust":"untrusted"}}\n' + JSON.stringify(value)
    expect(outputBlocks({ text: raw, details: envelope([text(JSON.stringify(value))], value) })).toEqual([
      { kind: 'json', value },
    ])
  })
  it('keeps supplementary prose and other JSON blocks beside structured output', () => {
    const value = { count: 1 }
    expect(
      outputBlocks({ text: 'raw', details: envelope([text('One result.'), text('{"next":"cursor"}')], value) }),
    ).toEqual([
      { kind: 'json', value },
      { kind: 'text', text: 'One result.' },
      { kind: 'json', value: { next: 'cursor' } },
    ])
  })
  it('parses individual text blocks when structured output was absent and redacted to unsupported', () => {
    expect(outputBlocks({ text: 'prefix\n{"count":2}', details: envelope([text('{"count":2}')]) })).toEqual([
      { kind: 'json', value: { count: 2 } },
    ])
  })
  it.each([null, false, 0, ''])('keeps a valid scalar structured value: %j', (value) => {
    expect(outputBlocks({ text: 'raw', details: envelope([], value) })).toEqual([{ kind: 'json', value }])
  })
  it('shows non-text MCP blocks as data without fetching them or losing their metadata', () => {
    const resource = { type: 'resource_link', name: 'Attachment', uri: 'https://example.com/data' }
    expect(outputBlocks({ text: 'raw', details: envelope([resource]) })).toEqual([{ kind: 'json', value: resource }])
  })
  it.each(['Permission denied.', '{"unfinished":', 'prefix\n{"count":2}', ''])(
    'retains non-JSON text exactly: %j',
    (raw) => {
      expect(outputBlocks({ text: raw, details: undefined })).toEqual([{ kind: 'text', text: raw }])
    },
  )
  it('does not treat a native tool details object as an MCP envelope', () => {
    expect(
      outputBlocks({ text: '{"ok":true}', details: { structuredContent: { different: true }, content: [] } }),
    ).toEqual([{ kind: 'json', value: { ok: true } }])
  })
  it('marks a Markdown result for formatting and keeps its text exactly', () => {
    const page = '# Notes\n\n```ts\nconst a = 1\n```\n'
    expect(outputBlocks({ text: page, details: undefined })).toEqual([{ kind: 'markdown', text: page }])
  })
  it('formats Markdown prose that accompanies structured MCP output', () => {
    const value = { count: 1 }
    const prose = '| Name | Count |\n| --- | --- |\n| a | 1 |'
    expect(outputBlocks({ text: 'raw', details: envelope([text(prose)], value) })).toEqual([
      { kind: 'json', value },
      { kind: 'markdown', text: prose },
    ])
  })
  it('falls back to the original text for an empty MCP result', () => {
    expect(outputBlocks({ text: 'No data', details: envelope([]) })).toEqual([{ kind: 'text', text: 'No data' }])
  })
})

describe('the bounded JSON viewer', () => {
  it('leaves nested branches unmounted until opened, and displays their item counts', () => {
    const markup = renderJson({ documents: [{ title: 'Hidden until expanded' }], active: false })
    expect(markup).toContain('Expand documents')
    expect(markup).toContain('1 items')
    expect(markup).not.toContain('Hidden until expanded')
    expect(markup).toContain('false')
  })
  it('bounds a large top-level array to 50 children instead of mounting them all', () => {
    const markup = renderJson(Array.from({ length: 1000 }, (_, index) => `value-${index}`))
    expect(markup).toContain('value-49')
    expect(markup).not.toContain('value-50')
    expect(markup).toContain('950')
  })
  it('shows escaped quotes and control characters and lets React escape HTML', () => {
    const markup = renderJson({ 'key"\n': '<script>alert("x")</script>\n' })
    expect(markup).not.toContain('<script>')
    expect(markup).toContain('&lt;script&gt;')
    expect(markup).toContain('\\n')
    expect(markup).toContain('\\&quot;')
  })
  it('shortens a long string in the tree while offering a keyboard-accessible show-more button', () => {
    const markup = renderJson('x'.repeat(300))
    expect(markup).not.toContain('x'.repeat(121))
    expect(markup).toContain('Show more')
    expect(markup).toContain('aria-expanded="false"')
  })
})

describe('tool output views', () => {
  it.each([
    [[{ kind: 'text', text: 'ok' }], 'plain'],
    [[{ kind: 'json', value: 1 }], 'tree'],
    [[{ kind: 'markdown', text: '# a' }], 'formatted'],
    [
      [
        { kind: 'json', value: 1 },
        { kind: 'markdown', text: '# a' },
      ],
      'formatted',
    ],
  ] as const)('opens %j on %s', (blocks, view) => {
    expect(payloadView(blocks)).toBe(view)
  })
  it('offers Raw beside a tree or formatted view, and no tabs for plain text', () => {
    expect(renderPayload('tree')).toMatch(/Tree.*Raw/su)
    expect(renderPayload('formatted')).toMatch(/Formatted.*Raw/su)
    const plain = renderPayload('plain')
    expect(plain).toContain('shown')
    expect(plain).not.toContain('Raw')
    expect(plain).not.toContain('role="tablist"')
  })
})
