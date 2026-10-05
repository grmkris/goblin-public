import {
  sanitize,
  type FloatingPanel,
  type LayoutDocument,
  type LayoutNode,
  type PanelNode,
  type SplitNode,
} from '@danfessler/trellis'
import { record } from './boundary.ts'
import { PANEL_TYPE, withoutFrame } from './trellis-layout.ts'

function panelOf(value: unknown): PanelNode | undefined {
  const item = record(value)
  if (
    item?.kind !== 'panel' ||
    typeof item.id !== 'string' ||
    !Array.isArray(item.views) ||
    typeof item.selected !== 'string'
  )
    return undefined
  const views = item.views.filter((id: unknown): id is string => typeof id === 'string')
  return views.length === item.views.length && views.length > 0
    ? { kind: 'panel', id: item.id, views, selected: item.selected }
    : undefined
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
  return children.length === item.children.length && weights.length === children.length
    ? { kind: 'split', id: item.id, axis: item.axis, children, weights }
    : undefined
}
function nodeOf(value: unknown, depth = 0): LayoutNode | undefined {
  if (depth > 16) return undefined
  const item = record(value)
  if (typeof item?.id !== 'string') return undefined
  if (item.kind === 'panel') return panelOf(value)
  if (item.kind === 'stage') {
    if (item.child === undefined) return { kind: 'stage', id: item.id }
    const child = nodeOf(item.child, depth + 1)
    return child === undefined || child.kind === 'stage' ? undefined : { kind: 'stage', id: item.id, child }
  }
  return item.kind === 'split' ? splitOf(item, depth) : undefined
}
function viewsOf(records: Record<string, unknown>): LayoutDocument['views'] {
  const views: LayoutDocument['views'] = {}
  for (const [id, data] of Object.entries(records)) {
    const view = record(data)
    const known = view?.type === PANEL_TYPE || (id === 'main' && view?.type === 'purrable-main')
    if (known && typeof view?.type === 'string')
      views[id] = { type: view.type, ...(typeof view.title === 'string' ? { title: view.title } : {}) }
  }
  return views
}
function floatingOf(entry: unknown): FloatingPanel[] {
  const item = record(entry)
  const panel = panelOf(item?.panel)
  const rect = record(item?.rect)
  if (panel === undefined || rect === undefined || panel.views.includes('main')) return []
  const { x, y, w, h } = rect
  if (
    typeof x !== 'number' ||
    typeof y !== 'number' ||
    typeof w !== 'number' ||
    typeof h !== 'number' ||
    w <= 0 ||
    h <= 0 ||
    ![x, y, w, h].every(Number.isFinite)
  )
    return []
  return [
    {
      panel,
      rect: { x, y, w, h },
      z: typeof item?.z === 'number' && Number.isFinite(item.z) ? item.z : 0,
      layer: 'overlay',
    },
  ]
}
function mainInStage(node: LayoutNode | null, staged = false): boolean {
  if (node === null) return false
  if (node.kind === 'panel') return staged && node.views.includes('main')
  if (node.kind === 'stage') return mainInStage(node.child ?? null, true)
  return node.children.some((child) => mainInStage(child, staged))
}

/** Decode only a bounded document shape; saved layout grants no authority to open a view. */
export function parseWorkspaceDocument(raw: string | null): LayoutDocument | undefined {
  if (raw === null || raw.length > 128_000) return undefined
  try {
    const value = record(JSON.parse(raw))
    const records = record(value?.views)
    if (value?.schema !== 1 || value.version !== 1 || records === undefined || Object.keys(records).length > 64)
      return undefined
    if (record(records.main)?.type !== 'purrable-main') return undefined
    const root = nodeOf(value.root) ?? null
    if (!mainInStage(root)) return undefined
    const floating = Array.isArray(value.floating) ? value.floating.flatMap(floatingOf) : []
    const document = sanitize({ schema: 1, version: 1, root, views: viewsOf(records), floating, hidden: [] })
    return mainInStage(document.root) ? document : undefined
  } catch {
    return undefined
  }
}

/** Remove stale/ephemeral view references before Trellis mounts them. Main is always retained. */
export function pruneDocument(document: LayoutDocument, allowed: ReadonlySet<string>): LayoutDocument {
  const views = Object.fromEntries(Object.entries(document.views).filter(([id]) => id === 'main' || allowed.has(id)))
  let root = document.root
  const staleFrames: string[] = []
  const visit = (node: LayoutNode | undefined) => {
    if (node === undefined) return
    if (node.kind === 'panel') {
      if (node.views.every((id) => !(id in views))) staleFrames.push(node.id)
    } else if (node.kind === 'stage') visit(node.child)
    else node.children.forEach(visit)
  }
  visit(root ?? undefined)
  for (const id of staleFrames) root = withoutFrame(root, id)
  return sanitize({
    ...document,
    root,
    views,
    floating: document.floating.filter((item) => item.panel.views.some((id) => id in views)),
    hidden: [],
  })
}
