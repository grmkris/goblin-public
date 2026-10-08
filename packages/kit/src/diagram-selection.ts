const NODES = '.node[data-id], .actor[data-id], .class-node[data-id], .entity[data-id]'
const LINKS = '.edge, .edge-label, .class-relationship, .er-relationship, .message, .lifeline, .activation'

export type DiagramNode = { readonly id: string; readonly label: string; readonly element: SVGGElement }

export function diagramNodes(svg: SVGSVGElement): DiagramNode[] {
  return [...svg.querySelectorAll<SVGGElement>(NODES)].map((element) => ({
    id: element.dataset.id ?? '',
    label: (element.dataset.label || element.dataset.id || 'Node').replaceAll(/<br\s*\/?\s*>/giu, ' '),
    element,
  }))
}

function diagramLinks(svg: SVGSVGElement) {
  return [...svg.querySelectorAll(LINKS)].map((element) => ({
    element,
    from:
      element.getAttribute('data-from') ?? element.getAttribute('data-entity1') ?? element.getAttribute('data-actor'),
    to: element.getAttribute('data-to') ?? element.getAttribute('data-entity2') ?? element.getAttribute('data-actor'),
  }))
}

/** SVG metadata covers flowchart/state, sequence, class and ER without a second Mermaid parser. */
export function highlightDiagram(svg: SVGSVGElement, selected: string | undefined): number {
  const links = diagramLinks(svg)
  const incident = links.filter(({ from, to }) => selected !== undefined && (from === selected || to === selected))
  const neighbors = new Set(
    incident.flatMap(({ from, to }) => [from, to]).filter((id) => id !== null && id !== selected),
  )
  for (const { id, element } of diagramNodes(svg)) {
    element.classList.toggle('kit-diagram-selected', id === selected)
    element.classList.toggle('kit-diagram-related', neighbors.has(id))
    element.classList.toggle('kit-diagram-dimmed', selected !== undefined && id !== selected && !neighbors.has(id))
  }
  for (const link of links) {
    const related = incident.includes(link)
    link.element.classList.toggle('kit-diagram-related', related)
    link.element.classList.toggle('kit-diagram-dimmed', selected !== undefined && !related)
  }
  return neighbors.size
}
