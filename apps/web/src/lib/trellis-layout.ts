import { type LayoutDocument, type LayoutNode } from '@danfessler/trellis'

/** Geometry ported from MyPlan's proven 0.3.0 adapter; no cross-repository runtime imports. */
export const PANEL_TYPE = 'purrable-pane'

type Split = Extract<LayoutNode, { kind: 'split' }>
function withStageChild(node: Extract<LayoutNode, { kind: 'stage' }>, child: LayoutNode | undefined): LayoutNode {
  const selected = child?.kind === 'stage' ? child.child : child
  const { child: _child, ...base } = node
  return selected === undefined ? base : { ...base, child: selected }
}

function mapSplits(document: LayoutDocument, edit: (split: Split) => Split | null): LayoutDocument {
  let changed = false
  const visit = (node: LayoutNode): LayoutNode => {
    if (node.kind === 'panel') return node
    if (node.kind === 'stage') {
      const child = node.child === undefined ? undefined : visit(node.child)
      if (child === node.child) return node
      return withStageChild(node, child)
    }
    const children = node.children.map(visit)
    const base = children.every((child, index) => child === node.children[index]) ? node : { ...node, children }
    const next = edit(base)
    if (next !== null || base !== node) changed = true
    return next ?? base
  }
  const root = document.root === null ? null : visit(document.root)
  return changed ? { ...document, root } : document
}

const equalSplit = (split: Split): Split | null => {
  const share = 1 / split.children.length
  return split.weights.every((weight) => Math.abs(weight - share) < 1e-6)
    ? null
    : { ...split, weights: split.children.map(() => share) }
}

/** Rebalance every row and column to equal shares. */
export const evenDocument = (document: LayoutDocument): LayoutDocument => mapSplits(document, equalSplit)

/** Equalize the row or column that contains a newly inserted panel. */
export function balanceAround(document: LayoutDocument, panelId: string): LayoutDocument {
  return mapSplits(document, (split) =>
    split.children.some((child) => child.kind === 'panel' && child.id === panelId) ? equalSplit(split) : null,
  )
}

/** Remove a panel from a layout, giving its share to the nearest remaining sibling. */
function removeChild(node: Split, direct: number): LayoutNode | null {
  const children = node.children.filter((_, index) => index !== direct)
  if (children.length === 0) return null
  const weights = node.weights.filter((_, index) => index !== direct)
  weights[Math.min(direct, weights.length - 1)]! += node.weights[direct]!
  return { ...node, children, weights }
}

function removeDescendant(node: Split, frameId: string): LayoutNode | null {
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
  const total = weights.reduce((sum, weight) => sum + weight, 0)
  const unchanged =
    children.length === node.children.length && children.every((child, index) => child === node.children[index])
  return unchanged ? node : { ...node, children, weights: weights.map((weight) => weight / total) }
}

export function withoutFrame(node: LayoutNode | null | undefined, frameId: string): LayoutNode | null {
  if (node === null || node === undefined) return null
  if (node.kind === 'panel') return node.id === frameId ? null : node
  if (node.kind === 'stage') {
    const child = withoutFrame(node.child, frameId)
    return child === (node.child ?? null) ? node : withStageChild(node, child ?? undefined)
  }
  const direct = node.children.findIndex((child) => child.id === frameId)
  return direct >= 0 ? removeChild(node, direct) : removeDescendant(node, frameId)
}
