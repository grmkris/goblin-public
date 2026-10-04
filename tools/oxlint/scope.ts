/**
 * AST and scope helpers shared by the Purrable oxlint plugins.
 *
 * `sourceCode.isGlobalReference` is true only for globals the lint configuration declares (`env`, `globals`), so a rule
 * built on it goes silent wherever `Bun` or `process` is not declared. These rules want the opposite: any reference that
 * no binding in the file resolves.
 */
import type { Context, ESTree } from '@oxlint/plugins'

/** Is `node` (an identifier) a reference that resolves to no binding in the file (an undeclared or configured global)? */
export const isFreeReference = (context: Context, node: ESTree.Node): boolean => {
  for (
    let scope: ReturnType<Context['sourceCode']['getScope']> | null = context.sourceCode.getScope(node);
    scope !== null;
    scope = scope.upper
  ) {
    const reference = scope.references.find((candidate) => candidate.identifier === node)
    if (reference !== undefined) return reference.resolved === null || reference.resolved.defs.length === 0
  }
  return false
}

/** A string literal (`'x'`), as opposed to the other literal kinds that share `type: 'Literal'`. */
export const isStringLiteral = (node: ESTree.Node): node is ESTree.StringLiteral =>
  node.type === 'Literal' && typeof node.value === 'string'
