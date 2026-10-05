import { sanitize, type LayoutDocument, type LayoutNode, type PanelNode, type SplitNode } from '@danfessler/trellis'
import { record } from './boundary.ts'
import { LAYOUT_VERSION, PANE_TYPE, withoutView } from './trellis-layout.ts'

/** At most this many panes come back from storage. */
const MAX_VIEWS = 64

function panelOf(item: Record<string, unknown>): PanelNode | undefined {
  if (typeof item.id !== 'string' || !Array.isArray(item.views) || item.views.length !== 1) return undefined
  const [view] = item.views
  return typeof view === 'string' ? { kind: 'panel', id: item.id, views: [view], selected: view } : undefined
}

function splitOf(item: Record<string, unknown>, depth: number): SplitNode | undefined {
  if (
    typeof item.id !== 'string' ||
    (item.axis !== 'x' && item.axis !== 'y') ||
    !Array.isArray(item.children) ||
    !Array.isArray(item.weights)
  )
    return undefined
  const children = item.children.flatMap((child: unknown) => nodeOf(child, depth + 1) ?? [])
  const weights = item.weights.filter(
    (weight: unknown): weight is number => typeof weight === 'number' && Number.isFinite(weight) && weight > 0,
  )
  return children.length === item.children.length && weights.length === children.length && children.length > 1
    ? { kind: 'split', id: item.id, axis: item.axis, children, weights }
    : undefined
}

/** One node of a stored tree: a one-view panel or a split of them; a stage or anything deeper than 16 is rejected. */
function nodeOf(value: unknown, depth = 0): LayoutNode | undefined {
  const item = record(value)
  if (item === undefined || depth > 16) return undefined
  if (item.kind === 'panel') return panelOf(item)
  return item.kind === 'split' ? splitOf(item, depth) : undefined
}

/**
 * A stored layout, decoded only as far as its bounded shape (128 KB, 64 panes, one view per pane, no stage, nothing
 * floating), keeping the panes whose view `keep` accepts. A stored layout grants no authority to open anything: it only
 * says where items the owner may open would go.
 */
export function parseLayoutDocument(value: unknown, keep: (view: string) => boolean): LayoutDocument | undefined {
  const item = record(value)
  const records = record(item?.views)
  if (item?.schema !== 1 || item.version !== LAYOUT_VERSION || records === undefined) return undefined
  const entries = Object.entries(records)
  if (entries.length === 0 || entries.length > MAX_VIEWS) return undefined
  const root = nodeOf(item.root)
  if (root === undefined) return undefined
  const views: LayoutDocument['views'] = {}
  for (const [id, data] of entries) {
    const view = record(data)
    if (view?.type !== PANE_TYPE) return undefined
    views[id] = { type: PANE_TYPE, ...(typeof view.title === 'string' ? { title: view.title.slice(0, 120) } : {}) }
  }
  let document: LayoutDocument = { schema: 1, version: LAYOUT_VERSION, root, floating: [], hidden: [], views }
  for (const id of Object.keys(views)) if (!keep(id)) document = withoutView(document, id)
  const clean = sanitize(document)
  return clean.root === null ? undefined : clean
}
