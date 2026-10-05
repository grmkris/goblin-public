import type { Edge, LayoutDocument, LayoutNode, PanelNode, SplitNode } from '@danfessler/trellis'

/**
 * Pure edits of a Trellis layout document in which every panel holds exactly one view, its view id being the item it
 * shows (`lib/workspace.ts`). There is no stage: the root is a panel or a tree of splits, and the edits leave a stage
 * node (which a parsed document never has) as it is. Geometry follows MyPlan's 0.3.0 adapter; no cross-repository
 * runtime imports.
 */

/** The one view type: every pane holds one item. */
export const PANE_TYPE = 'purrable-pane'

/** The layout version stored with a document; a different one is discarded rather than migrated. */
export const LAYOUT_VERSION = 2

const isPanel = (node: LayoutNode): node is PanelNode => node.kind === 'panel'

/** The panel showing `view`, if any. */
function panelOf(node: LayoutNode | null | undefined, view: string): PanelNode | undefined {
  if (node === null || node === undefined) return undefined
  if (isPanel(node)) return node.views.includes(view) ? node : undefined
  if (node.kind === 'stage') return panelOf(node.child, view)
  for (const child of node.children) {
    const found = panelOf(child, view)
    if (found !== undefined) return found
  }
  return undefined
}

/** Every node id in the tree, to keep new ids unique. */
function ids(node: LayoutNode | null | undefined, into = new Set<string>()): Set<string> {
  if (node === null || node === undefined) return into
  into.add(node.id)
  if (node.kind === 'stage') ids(node.child, into)
  else if (node.kind === 'split') for (const child of node.children) ids(child, into)
  return into
}

/** `base`, or `base:2`, `base:3`… whichever no node has. */
function freshId(taken: ReadonlySet<string>, base: string): string {
  let id = base
  for (let n = 2; taken.has(id); n += 1) id = `${base}:${n}`
  return id
}

/** How many panes sit side by side at the widest: what the scrolling strip makes room for. */
export function columnCount(node: LayoutNode | null | undefined): number {
  if (node === null || node === undefined || isPanel(node)) return 1
  if (node.kind === 'stage') return columnCount(node.child)
  const each = node.children.map(columnCount)
  return node.axis === 'x' ? each.reduce((sum, count) => sum + count, 0) : Math.max(...each)
}

/** Even shares again: a row gives each child its number of columns, so every column is as wide; a column, equal parts. */
function balance(node: LayoutNode): LayoutNode {
  if (isPanel(node)) return node
  if (node.kind === 'stage') {
    if (node.child === undefined) return node
    const child = balance(node.child)
    return child.kind === 'stage' ? node : { ...node, child }
  }
  const children = node.children.map(balance)
  const raw = node.axis === 'x' ? children.map(columnCount) : children.map(() => 1)
  const total = raw.reduce((sum, weight) => sum + weight, 0)
  return { ...node, children, weights: raw.map((weight) => weight / total) }
}

/** The document with every row and column back to even shares. */
export const balanced = (document: LayoutDocument): LayoutDocument =>
  document.root === null ? document : { ...document, root: balance(document.root) }

/** The views in reading order: left to right, then top to bottom within a column. */
export function leafOrder(document: LayoutDocument): string[] {
  const order: string[] = []
  const visit = (node: LayoutNode | undefined) => {
    if (node === undefined) return
    if (isPanel(node)) order.push(...node.views)
    else if (node.kind === 'stage') visit(node.child)
    else node.children.forEach(visit)
  }
  visit(document.root ?? undefined)
  return order
}

/** A document of one pane showing `view`. */
export function singlePane(view: string, title: string): LayoutDocument {
  return {
    schema: 1,
    version: LAYOUT_VERSION,
    root: { kind: 'panel', id: `p:${view}`, views: [view], selected: view },
    floating: [],
    hidden: [],
    views: { [view]: { type: PANE_TYPE, title } },
  }
}

/** Remove a panel from a layout, giving its share to the nearest remaining sibling. */
function removeChild(node: SplitNode, direct: number): LayoutNode | null {
  const children = node.children.filter((_, index) => index !== direct)
  if (children.length === 0) return null
  const weights = node.weights.filter((_, index) => index !== direct)
  weights[Math.min(direct, weights.length - 1)]! += node.weights[direct]!
  return children.length === 1 ? children[0]! : { ...node, children, weights }
}

function removeDescendant(node: SplitNode, frameId: string): LayoutNode | null {
  const children: LayoutNode[] = []
  const weights: number[] = []
  node.children.forEach((child, index) => {
    const next = withoutFrame(child, frameId)
    if (next !== null) {
      children.push(next)
      weights.push(node.weights[index]!)
    } else if (weights.length > 0) weights[weights.length - 1]! += node.weights[index]!
  })
  if (children.length === 0) return null
  if (children.length === 1) return children[0]!
  const total = weights.reduce((sum, weight) => sum + weight, 0)
  const unchanged =
    children.length === node.children.length && children.every((child, index) => child === node.children[index])
  return unchanged ? node : { ...node, children, weights: weights.map((weight) => weight / total) }
}

/** The tree without the frame (panel or split) `frameId`; a split left with one child collapses into it. */
export function withoutFrame(node: LayoutNode | null | undefined, frameId: string): LayoutNode | null {
  if (node === null || node === undefined) return null
  if (isPanel(node)) return node.id === frameId ? null : node
  if (node.kind === 'stage') {
    const child = withoutFrame(node.child, frameId)
    if (child === (node.child ?? null)) return node
    const { child: _dropped, ...base } = node
    return child === null || child.kind === 'stage' ? base : { ...base, child }
  }
  const direct = node.children.findIndex((child) => child.id === frameId)
  return direct >= 0 ? removeChild(node, direct) : removeDescendant(node, frameId)
}

/** The document without `view` and its pane. */
export function withoutView(document: LayoutDocument, view: string): LayoutDocument {
  const panel = panelOf(document.root, view)
  if (panel === undefined) return document
  const { [view]: _dropped, ...views } = document.views
  return { ...document, root: withoutFrame(document.root, panel.id), views }
}

const AXIS: Readonly<Record<Edge, 'x' | 'y'>> = { left: 'x', right: 'x', top: 'y', bottom: 'y' }
const BEFORE: Readonly<Record<Edge, boolean>> = { left: true, right: false, top: true, bottom: false }

/**
 * A new pane for `view` at `edge` of the pane showing `target`: beside it in the same row or column when the edge runs
 * that way, else the two share a new split in the target's place. It starts with half the target's share.
 */
export function insertBeside(
  document: LayoutDocument,
  target: string,
  view: string,
  title: string,
  edge: Edge,
): LayoutDocument {
  const at = panelOf(document.root, target)
  if (at === undefined || document.root === null) return document
  const taken = ids(document.root)
  const panel: PanelNode = { kind: 'panel', id: freshId(taken, `p:${view}`), views: [view], selected: view }
  const axis = AXIS[edge]
  const before = BEFORE[edge]
  const place = (node: LayoutNode): LayoutNode => {
    if (node === at) {
      const id = freshId(taken, `s:${view}`)
      return { kind: 'split', id, axis, weights: [0.5, 0.5], children: before ? [panel, node] : [node, panel] }
    }
    if (node.kind !== 'split') return node
    const direct = node.children.indexOf(at)
    if (direct >= 0 && node.axis === axis) {
      const half = node.weights[direct]! / 2
      const children = node.children.toSpliced(before ? direct : direct + 1, 0, panel)
      const weights = node.weights.with(direct, half).toSpliced(before ? direct : direct + 1, 0, half)
      return { ...node, children, weights }
    }
    return { ...node, children: node.children.map(place) }
  }
  return {
    ...document,
    root: place(document.root),
    views: { ...document.views, [view]: { type: PANE_TYPE, title } },
  }
}

/** The pane showing `from` shows `to` instead, in the same place. */
export function replaceView(document: LayoutDocument, from: string, to: string, title: string): LayoutDocument {
  const at = panelOf(document.root, from)
  if (at === undefined || document.root === null) return document
  const swap = (node: LayoutNode): LayoutNode => {
    if (node === at) return { ...node, views: [to], selected: to }
    return node.kind === 'split' ? { ...node, children: node.children.map(swap) } : node
  }
  const { [from]: _dropped, ...views } = document.views
  return { ...document, root: swap(document.root), views: { ...views, [to]: { type: PANE_TYPE, title } } }
}

/** Two panes trade what they show; each keeps its place and size. */
export function swapViews(document: LayoutDocument, one: string, other: string): LayoutDocument {
  const first = panelOf(document.root, one)
  const second = panelOf(document.root, other)
  if (first === undefined || second === undefined || first === second || document.root === null) return document
  const swap = (node: LayoutNode): LayoutNode => {
    if (node === first) return { ...node, views: [other], selected: other }
    if (node === second) return { ...node, views: [one], selected: one }
    return node.kind === 'split' ? { ...node, children: node.children.map(swap) } : node
  }
  return { ...document, root: swap(document.root) }
}
