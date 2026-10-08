import { diagramSvg } from '../../../../packages/kit/src/diagram.tsx'
import { sanitizeDiagramSvg } from '../../../../packages/kit/src/diagram-svg.ts'
import { diagramNodes, highlightDiagram } from '../../../../packages/kit/src/diagram-selection.ts'

const colors = { bg: '#ffffff', fg: '#27272a', accent: '#2563eb', muted: '#71717a', border: '#e4e4e7' }
const families = [
  'graph LR\n A --> B\n C --> D',
  'stateDiagram-v2\n [*] --> Idle\n Idle --> Running',
  'sequenceDiagram\n participant A as Alice\n participant B as Bob\n A->>B: Hello\n B->>A: Reply',
  'classDiagram\n Animal <|-- Dog\n class Animal {\n +name: String\n }',
  'erDiagram\n PERSON ||--o{ ORDER : places',
]

function checkFamilies(container: HTMLDivElement, check: (condition: boolean, name: string) => void) {
  for (const [index, source] of families.entries()) {
    const raw = diagramSvg(source, colors)
    const safe = raw === undefined ? undefined : sanitizeDiagramSvg(raw, `family-${index}`)
    check(safe !== undefined, `sanitize family ${index}`)
    container.innerHTML = safe ?? ''
    const svg = container.querySelector('svg')
    if (!(svg instanceof SVGSVGElement)) throw new Error('SVG missing')
    const nodes = diagramNodes(svg)
    check(nodes.length >= 2, `family ${index} selectable metadata`)
    const first = nodes[0]
    if (first === undefined) throw new Error('node missing')
    check(highlightDiagram(svg, first.id) >= 1, `family ${index} neighbors`)
    check(first.element.classList.contains('kit-diagram-selected'), `family ${index} selected`)
    highlightDiagram(svg, undefined)
    check(svg.querySelector('.kit-diagram-dimmed, .kit-diagram-selected') === null, `family ${index} clear`)
  }
}

export function checkDiagramSafety(): string[] {
  const checks: string[] = []
  const check = (condition: boolean, name: string) => {
    if (!condition) throw new Error(`SVG acceptance failed: ${name}`)
    checks.push(name)
  }
  const container = document.createElement('div')
  document.body.appendChild(container)
  try {
    checkFamilies(container, check)
    const raw = diagramSvg('graph LR\n A --> B\n style A fill:url(https://example.invalid/paint.svg#p)', colors)
    check(raw?.includes('example.invalid') === true, 'renderer external paint regression fixture')
    const safe = sanitizeDiagramSvg(raw ?? '', 'paint')
    check(safe !== undefined && !safe.includes('example.invalid'), 'model external paint removed')
    const hostile = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 100 100" onload="alert(1)">
      <style>@import url('https://example.invalid/font'); @font-face{font-family:bad;src:url(https://example.invalid/font)} text{font-family:serif} body{color:red} svg{--_text:var(--fg)} .mono{font-family:monospace}</style>
      <script>alert(1)</script><foreignObject><div xmlns="http://www.w3.org/1999/xhtml">bad</div></foreignObject>
      <image href="https://example.invalid/a"/><use xlink:href="https://example.invalid/a#b"/>
      <defs><marker id="arrowhead"><path d="M0 0 L1 1"/></marker></defs>
      <g class="node foreign" data-id="A" data-label="&lt;img src=x onerror=alert(1)&gt;" onclick="alert(1)">
        <rect width="20" height="20" fill="url(relative.svg#p)" stroke="u&#92;72l(https://example.invalid/p)" style="fill:url(https://example.invalid/p);--bg:url(https://example.invalid/p)"/>
        <path d="M0 0 L10 10" marker-end="url(#arrowhead)"/><text>&lt;script&gt;literal&lt;/script&gt;</text>
      </g></svg>`
    const first = sanitizeDiagramSvg(hostile, 'first')
    const second = sanitizeDiagramSvg(hostile, 'second')
    check(first !== undefined && second !== undefined, 'hostile SVG parsed')
    container.innerHTML = `${first ?? ''}${second ?? ''}`
    check(container.querySelector('script, foreignObject, image, use, a') === null, 'active SVG elements removed')
    check(
      !container.innerHTML.includes('example.invalid') && !container.innerHTML.includes('relative.svg'),
      'all external references removed',
    )
    check(
      container.querySelector('[onload], [onclick], [href], [xlink\\:href]') === null,
      'event and href attributes removed',
    )
    check(container.querySelector('text')?.textContent === '<script>literal</script>', 'labels remain literal text')
    check(container.querySelector('.foreign') === null, 'foreign classes removed')
    const ids = [...container.querySelectorAll('[id]')].map((element) => element.id)
    check(new Set(ids).size === ids.length, 'per-instance IDs unique')
    for (const svg of container.querySelectorAll('svg')) {
      const marker = svg.querySelector('marker')
      check(
        svg.querySelector('[marker-end]')?.getAttribute('marker-end') === `url(#${marker?.id})`,
        'marker refers to own instance',
      )
    }
    check(
      !container.innerHTML.includes('@import') &&
        !container.innerHTML.includes('@font-face') &&
        !container.innerHTML.includes('body{'),
      'only scoped renderer CSS retained',
    )
    check(sanitizeDiagramSvg('<svg><', 'invalid') === undefined, 'malformed SVG rejected')
    const xy = diagramSvg('xychart-beta\n x-axis [Jan, Feb]\n y-axis 0 --> 10\n bar [3, 7]', colors)
    container.innerHTML = sanitizeDiagramSvg(xy ?? '', 'xy') ?? ''
    const chart = container.querySelector('svg')
    check(chart instanceof SVGSVGElement && diagramNodes(chart).length === 0, 'XY charts render without invented nodes')
    return checks
  } finally {
    container.remove()
  }
}
