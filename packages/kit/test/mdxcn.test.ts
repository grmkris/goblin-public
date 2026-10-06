import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Mdxcn, mdxcnSpec, type MdxcnSpec } from '../src/mdxcn.tsx'

const examples: readonly MdxcnSpec[] = [
  { kind: 'timeline', title: 'Release', events: [{ date: 'Today', label: 'Review', state: 'now', note: 'Ready' }] },
  {
    kind: 'check',
    title: 'Tasks',
    items: [{ label: 'Review', done: true, items: [{ label: 'Tests', items: [{ label: 'Smoke' }] }] }],
  },
  {
    kind: 'compare',
    title: 'Options',
    columns: ['A', 'B'],
    rows: [
      { label: 'Offline', values: [true, false] },
      { label: 'Price', values: [3, 'Free'] },
    ],
  },
  { kind: 'stat', title: 'Summary', items: [{ label: 'Done', value: 12, hint: 'Today', accent: true }] },
  { kind: 'spark', title: 'Week', data: [0, 3, 5, 4], caption: 'Tasks per day' },
]

const read = (value: unknown) => mdxcnSpec(JSON.stringify(value))
const render = (source: string) =>
  renderToStaticMarkup(createElement(Mdxcn, { source, fallback: createElement('pre', null, source) }))

describe('mdxcn figures', () => {
  it.each(examples)('validates and renders $kind data', (spec) => {
    expect(read(spec)).toEqual(spec)
    const html = render(JSON.stringify(spec))
    expect(html).toContain('class="kit-mdxcn not-typeset"')
    expect(html).toContain(spec.title)
    expect(html).not.toContain('<pre>')
    expect(html).not.toContain('<input')
  })
  it('shows nested checks, state, boolean alternatives and every spark value accessibly', () => {
    expect(render(JSON.stringify(examples[0]))).toContain('(now)')
    const check = render(JSON.stringify(examples[1]))
    expect(check).toContain('Smoke')
    expect(check).toContain('1 of 3 done')
    const compare = render(JSON.stringify(examples[2]))
    expect(compare).toContain('scope="col"')
    expect(compare).toContain('>Yes</span>')
    expect(compare).toContain('>No</span>')
    expect(render(JSON.stringify(examples[4]))).toContain('4 points: 0, 3, 5, 4')
  })
  it.each(['{', 'null', '[]', '"text"', '{"kind":"unknown","title":"No"}', ' '.repeat(32_769)])(
    'keeps malformed, unsupported or oversized input as code',
    (source) => {
      expect(mdxcnSpec(source)).toBeUndefined()
      expect(render(source)).toContain('<pre>')
    },
  )
  it('requires bounded, nonempty titles, labels and dates and rejects extra fields', () => {
    for (const spec of examples) {
      expect(read({ ...spec, title: '' })).toBeUndefined()
      expect(read({ ...spec, title: 'x'.repeat(121) })).toBeUndefined()
      expect(read({ ...spec, html: '<img src="https://example.test">' })).toBeUndefined()
    }
    expect(read({ ...examples[0], events: [{ date: '', label: 'Ready' }] })).toBeUndefined()
    expect(read({ ...examples[0], events: [{ date: 'Today', label: 'x'.repeat(121) }] })).toBeUndefined()
    expect(read({ ...examples[0], events: [{ date: 'Today', label: 'Ready', state: 'later' }] })).toBeUndefined()
  })
  it('bounds all arrays and rejects empty displays', () => {
    const cases = [
      ['events', 33, { date: 'Today', label: 'Ready' }, examples[0]],
      ['items', 21, { label: 'Ready' }, examples[1]],
      ['rows', 25, { label: 'Ready', values: [true, false] }, examples[2]],
      ['items', 9, { label: 'Ready', value: 3 }, examples[3]],
      ['data', 65, 3, examples[4]],
    ] as const
    for (const [key, count, item, base] of cases) {
      expect(read({ ...base, [key]: Array.from({ length: count }, () => item) })).toBeUndefined()
      expect(read({ ...base, [key]: [] })).toBeUndefined()
    }
    expect(read({ ...examples[2], columns: ['Only'] })).toBeUndefined()
    expect(read({ ...examples[2], columns: ['A', 'B', 'C', 'D', 'E'] })).toBeUndefined()
    expect(read({ ...examples[2], columns: ['A', 'A'] })).toBeUndefined()
    expect(read({ ...examples[2], rows: [{ label: 'One', values: [true] }] })).toBeUndefined()
    expect(read({ ...examples[2], rows: [{ label: 'Five', values: [1, 2, 3, 4, 5] }] })).toBeUndefined()
  })
  it('bounds nested check width, depth and total count before rendering', () => {
    const leaf = { label: 'Leaf', done: false }
    const branch = { label: 'Branch', items: [leaf] }
    expect(
      read({
        kind: 'check',
        title: 'Checks',
        items: [{ label: 'Root', items: [{ ...branch, items: [{ ...leaf, items: [leaf] }] }] }],
      }),
    ).toBeUndefined()
    expect(
      read({
        kind: 'check',
        title: 'Checks',
        items: [{ label: 'Root', items: Array.from({ length: 21 }, () => leaf) }],
      }),
    ).toBeUndefined()
    const lots = Array.from({ length: 20 }, () => ({ ...branch, items: [leaf, leaf, leaf] }))
    expect(read({ kind: 'check', title: 'Checks', items: lots })).toBeUndefined()
    expect(read({ kind: 'check', title: 'Checks', items: lots.slice(0, 16) })).toBeDefined()
  })
  it('bounds notes, hints, captions and value strings, and rejects non-finite or negative spark values', () => {
    const long = 'x'.repeat(241)
    expect(read({ ...examples[0], events: [{ date: 'Today', label: 'Ready', note: long }] })).toBeUndefined()
    expect(
      read({ ...examples[1], items: [{ label: 'Ready', items: [{ label: 'Nested', note: long }] }] }),
    ).toBeUndefined()
    expect(read({ ...examples[2], rows: [{ label: 'Ready', values: [long, true] }] })).toBeUndefined()
    expect(read({ ...examples[3], items: [{ label: 'Ready', value: 'x'.repeat(65) }] })).toBeUndefined()
    expect(read({ ...examples[3], items: [{ label: 'Ready', value: 3, hint: long }] })).toBeUndefined()
    expect(read({ ...examples[4], caption: long })).toBeUndefined()
    for (const data of [[-1, 3], [1, 1e13], [1], [null, 3]]) expect(read({ ...examples[4], data })).toBeUndefined()
    expect(mdxcnSpec('{"kind":"spark","title":"Bad","data":[1,1e999]}')).toBeUndefined()
    expect(read({ ...examples[3], items: [{ label: 'Ready', value: { nested: true } }] })).toBeUndefined()
  })
  it('keeps hostile text inert instead of interpreting HTML, URLs or Markdown', () => {
    const html = render(
      JSON.stringify({
        kind: 'stat',
        title: '<script>bad()</script>',
        items: [{ label: '![load](https://example.test)', value: '<b>12</b>' }],
      }),
    )
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('<img')
    expect(html).not.toContain('<b>')
    expect(html).toContain('&lt;b&gt;12&lt;/b&gt;')
  })
})
