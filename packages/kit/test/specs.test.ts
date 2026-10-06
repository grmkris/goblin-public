import { describe, expect, it } from 'vitest'
import { diagramSvg } from '../src/diagram.tsx'
import { mapPoints } from '../src/specs.ts'
import { chartSpec, mapSpec } from '../src/index.ts'

const colors = { bg: '#ffffff', fg: '#27272a', accent: '#2563eb', muted: '#71717a', border: '#e4e4e7' }

describe('chart specs', () => {
  it('read a bar chart with its series and rows', () => {
    const spec = chartSpec(
      JSON.stringify({
        type: 'bar',
        title: 'Sales',
        x: 'month',
        series: [{ key: 'eu', label: 'Europe' }, { key: 'us' }],
        data: [
          { month: 'Jan', eu: 3, us: 4 },
          { month: 'Feb', eu: 5, us: null },
        ],
      }),
    )
    expect(spec?.series.map((series) => series.key)).toEqual(['eu', 'us'])
    expect(spec?.data).toHaveLength(2)
  })
  it('refuse what is not one: bad JSON, an unknown type, no series, too many series or a non-finite value', () => {
    const base = { type: 'line', x: 'day', series: [{ key: 'v' }], data: [{ day: 'Mon', v: 1 }] }
    expect(chartSpec('{"type":')).toBeUndefined()
    expect(chartSpec(JSON.stringify({ ...base, type: 'radar' }))).toBeUndefined()
    expect(chartSpec(JSON.stringify({ ...base, series: [] }))).toBeUndefined()
    expect(
      chartSpec(JSON.stringify({ ...base, series: Array.from({ length: 6 }, (_, n) => ({ key: `s${n}` })) })),
    ).toBeUndefined()
    expect(chartSpec(JSON.stringify({ ...base, data: [{ day: 'Mon', v: { nested: true } }] }))).toBeUndefined()
    expect(chartSpec(`{"pad":"${'x'.repeat(200_001)}"}`)).toBeUndefined()
  })
})

describe('map specs', () => {
  it('read markers and lines and list every point to fit', () => {
    const spec = mapSpec(
      JSON.stringify({
        markers: [{ lat: 46.37, lng: 14.11, label: 'Bled' }],
        lines: [
          {
            points: [
              [46.05, 14.5],
              [46.37, 14.11],
            ],
          },
        ],
      }),
    )
    expect(spec === undefined ? [] : mapPoints(spec)).toEqual([
      [46.37, 14.11],
      [46.05, 14.5],
      [46.37, 14.11],
    ])
  })
  it('refuse an empty map, coordinates off the globe and a fractional zoom', () => {
    expect(mapSpec('{}')).toBeUndefined()
    expect(mapSpec(JSON.stringify({ markers: [{ lat: 91, lng: 0 }] }))).toBeUndefined()
    expect(mapSpec(JSON.stringify({ center: [0, 181] }))).toBeUndefined()
    expect(mapSpec(JSON.stringify({ center: [46, 14], zoom: 2.5 }))).toBeUndefined()
    expect(mapSpec(JSON.stringify({ center: [46, 14], zoom: 9 }))).toEqual({ center: [46, 14], zoom: 9 })
  })
})

describe('diagrams', () => {
  it('draw a flowchart without fetching a font', () => {
    const svg = diagramSvg('graph LR\n  Draft --> Review --> Ship', colors)
    expect(svg?.startsWith('<svg')).toBe(true)
    expect(svg).toContain('Review')
    expect(svg).not.toContain('@import')
    expect(svg).not.toContain('googleapis')
  })
  it('give nothing for what is not a diagram it can draw', () => {
    expect(diagramSvg('not a diagram at all', colors)).toBeUndefined()
    expect(diagramSvg(`graph LR\n${'  A --> B\n'.repeat(3000)}`, colors)).toBeUndefined()
  })
})
