/**
 * AST helpers for the goblin oxlint plugins. Ported from myapps (`grmkris/myapps` `27416c98`, `tools/oxlint/ast.ts`)
 * with tools/oxlint/data-invariants.ts, unchanged.
 */
import type { Context, ESTree } from '@oxlint/plugins'
import { isStringLiteral } from './scope.ts'

export const isNode = (value: unknown): value is ESTree.Node =>
  typeof value === 'object' && value !== null && 'type' in value && typeof value.type === 'string'

/** Parser visitor keys exclude parent links, comments and token metadata. */
export const childrenOf = (context: Context, node: ESTree.Node): ESTree.Node[] => {
  const children: ESTree.Node[] = []
  const keys = context.sourceCode.visitorKeys[node.type] ?? []
  for (const [key, value] of Object.entries(node)) {
    if (!keys.includes(key)) continue
    const values: readonly unknown[] = Array.isArray(value) ? value : [value]
    children.push(...values.filter(isNode))
  }
  return children
}

export const someNode = (context: Context, node: ESTree.Node, matches: (node: ESTree.Node) => boolean): boolean =>
  matches(node) || childrenOf(context, node).some((child) => someNode(context, child, matches))

export const memberName = (node: ESTree.Node): string | undefined => {
  if (node.type !== 'MemberExpression') return
  if (!node.computed && node.property.type === 'Identifier') return node.property.name
  if (node.computed && isStringLiteral(node.property)) return node.property.value
  return undefined
}
