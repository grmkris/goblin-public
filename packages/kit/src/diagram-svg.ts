const SVG_NS = 'http://www.w3.org/2000/svg'
const ELEMENTS = new Set([
  'svg',
  'style',
  'defs',
  'marker',
  'polygon',
  'polyline',
  'line',
  'path',
  'rect',
  'circle',
  'ellipse',
  'g',
  'text',
  'tspan',
  'title',
  'desc',
])
const ATTRIBUTES = new Set([
  'id',
  'class',
  'style',
  'viewBox',
  'width',
  'height',
  'x',
  'y',
  'x1',
  'y1',
  'x2',
  'y2',
  'cx',
  'cy',
  'r',
  'rx',
  'ry',
  'd',
  'points',
  'transform',
  'dx',
  'dy',
  'fill',
  'stroke',
  'stroke-width',
  'stroke-dasharray',
  'stroke-linecap',
  'stroke-linejoin',
  'opacity',
  'fill-opacity',
  'stroke-opacity',
  'marker-start',
  'marker-end',
  'markerWidth',
  'markerHeight',
  'markerUnits',
  'refX',
  'refY',
  'orient',
  'font-size',
  'font-weight',
  'font-style',
  'text-decoration',
  'text-anchor',
  'dominant-baseline',
  'data-id',
  'data-label',
  'data-from',
  'data-to',
  'data-entity1',
  'data-entity2',
  'data-actor',
])
const VARIABLES = new Set([
  '--bg',
  '--fg',
  '--line',
  '--accent',
  '--muted',
  '--surface',
  '--border',
  '--_text',
  '--_text-sec',
  '--_text-muted',
  '--_text-faint',
  '--_line',
  '--_arrow',
  '--_node-fill',
  '--_node-stroke',
  '--_group-fill',
  '--_group-hdr',
  '--_inner-stroke',
  '--_key-badge',
])
const STYLE_PROPERTIES = new Set(['font-family', 'fill', 'stroke', ...VARIABLES])
const CLASSES = new Set([
  'node',
  'actor',
  'class-node',
  'entity',
  'subgraph',
  'edge',
  'edge-label',
  'class-relationship',
  'er-relationship',
  'message',
  'lifeline',
  'activation',
  'mono',
])

/** A deliberately small CSS vocabulary: no escapes, URLs, declarations or inherited arbitrary variables. */
function safeValue(value: string): boolean {
  if (!/^[\w\s#.,()%+'"-]+$/u.test(value) || /(?:url|image|expression)\s*\(/iu.test(value)) return false
  for (const variable of value.matchAll(/var\(\s*(--[\w-]+)/gu)) {
    if (!VARIABLES.has(variable[1] ?? '')) return false
  }
  return true
}

function safeStyle(style: CSSStyleDeclaration): string {
  const result: string[] = []
  for (const property of style) {
    const value = style.getPropertyValue(property)
    if (STYLE_PROPERTIES.has(property) && safeValue(value)) result.push(`${property}:${value}`)
  }
  return result.join(';')
}

/** Parse CSS without attaching it: imports and every rule except the renderer's three selectors are discarded. */
function scopedStyle(css: string, scope: string): string {
  const sheet = new CSSStyleSheet()
  sheet.replaceSync(css.replaceAll(/@import\s+url\([^)]*\)\s*;?/giu, ''))
  const result: string[] = []
  for (const rule of sheet.cssRules) {
    if (!(rule instanceof CSSStyleRule)) continue
    const selector = rule.selectorText
    if (!['svg', 'text', '.mono'].includes(selector)) continue
    const scoped = selector === 'svg' ? `#${scope}` : `#${scope} ${selector}`
    result.push(`${scoped}{${safeStyle(rule.style)}}`)
  }
  return result.join('\n')
}

function safeAttribute(name: string, value: string, ids: ReadonlyMap<string, string>): string | undefined {
  if (name === 'id') return ids.get(value)
  if (name === 'class')
    return value
      .split(/\s+/u)
      .filter((item) => CLASSES.has(item))
      .join(' ')
  if (name === 'style') {
    const style = document.createElement('span').style
    style.cssText = value
    return safeStyle(style)
  }
  if (name.startsWith('data-')) return value
  const reference = /^url\(\s*["']?#([^\s)'"]+)["']?\s*\)$/iu.exec(value)
  if (reference !== null) {
    const id = ids.get(reference[1] ?? '')
    return id === undefined ? undefined : `url(#${id})`
  }
  return safeValue(value) ? value : undefined
}

function copyAttributes(element: Element, safe: Element, ids: ReadonlyMap<string, string>): void {
  for (const attribute of element.attributes) {
    if (!ATTRIBUTES.has(attribute.name) || attribute.namespaceURI !== null) continue
    const value = safeAttribute(attribute.name, attribute.value, ids)
    if (value !== undefined) safe.setAttribute(attribute.name, value)
  }
}

function copyElement(element: Element, ids: ReadonlyMap<string, string>, scope: string): Element | undefined {
  if (element.namespaceURI !== SVG_NS || !ELEMENTS.has(element.localName)) return
  const safe = document.createElementNS(SVG_NS, element.localName)
  copyAttributes(element, safe, ids)
  if (element.localName === 'style') safe.textContent = scopedStyle(element.textContent ?? '', scope)
  else
    for (const child of element.childNodes) {
      const safeChild = copyChild(child, ids, scope)
      if (safeChild !== undefined) safe.appendChild(safeChild)
    }
  return safe
}

function copyChild(child: Node, ids: ReadonlyMap<string, string>, scope: string): Node | undefined {
  if (child instanceof Element) return child.localName === 'svg' ? undefined : copyElement(child, ids, scope)
  if (child.nodeType === Node.TEXT_NODE) return document.createTextNode(child.textContent ?? '')
  return
}

/**
 * Only the pinned renderer's passive SVG vocabulary may cross the inline boundary.
 * Rebuild it in a detached tree so raw style/paint values never reach the page.
 */
export function sanitizeDiagramSvg(source: string, instance: string): string | undefined {
  const scope = instance.replaceAll(/[^a-zA-Z0-9_-]/gu, '-')
  const parsed = new DOMParser().parseFromString(source, 'image/svg+xml')
  const root = parsed.documentElement
  if (root.localName !== 'svg' || root.namespaceURI !== SVG_NS || parsed.querySelector('parsererror') !== null) return
  const ids = new Map<string, string>()
  for (const element of root.querySelectorAll('[id]')) {
    const id = element.getAttribute('id')
    if (id !== null && !ids.has(id)) ids.set(id, `${scope}-marker-${ids.size}`)
  }
  const safe = copyElement(root, ids, scope)
  if (safe === undefined) return
  safe.setAttribute('id', scope)
  return new XMLSerializer().serializeToString(safe)
}
