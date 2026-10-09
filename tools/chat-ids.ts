import { parseSync, Visitor, type Node } from 'oxc-parser'

export type ChatIdViolation = { readonly line: number; readonly reason: string }

const rootNames = new Set(['ROOT_CONVERSATION_ID', 'ROOT_SESSION'])
const propertyName = (node: Node): string | undefined => {
  if (node.type === 'Identifier' || node.type === 'PrivateIdentifier') return node.name
  return node.type === 'Literal' && typeof node.value === 'string' ? node.value : undefined
}
const harnessReceiver = (node: Node): boolean =>
  (node.type === 'Identifier' && node.name === 'harness') ||
  (node.type === 'MemberExpression' && propertyName(node.property) === 'harness')

const explicitSession = (node: Node | undefined): boolean =>
  node?.type === 'ObjectExpression' &&
  node.properties.some((property) => property.type === 'Property' && propertyName(property.key) === 'session')

/** Parse calls so comments, strings, nested commas and a neighbouring call cannot satisfy the guard. */
export function chatIdViolations(
  source: string,
  allowed: { readonly root?: boolean; readonly directory?: boolean } = {},
): readonly ChatIdViolation[] {
  const result = parseSync('runtime.ts', source)
  const violations: ChatIdViolation[] = []
  const fail = (start: number, reason: string) =>
    violations.push({ line: source.slice(0, start).split('\n').length, reason })
  for (const error of result.errors) fail(error.labels[0]?.start ?? 0, `parse failed: ${error.message}`)
  new Visitor({
    Identifier(node) {
      if (!allowed.root && rootNames.has(node.name)) fail(node.start, `forbidden ${node.name}`)
    },
    CallExpression(node) {
      const call = node.callee
      if (call.type !== 'MemberExpression' || !harnessReceiver(call.object)) return
      const name = propertyName(call.property)
      if (name === 'session' && node.arguments.length === 0)
        fail(node.start, 'harness.session requires an explicit Pi session')
      if (name === 'submit' && !explicitSession(node.arguments[1]))
        fail(node.start, 'harness.submit requires an explicit Pi session')
    },
    NewExpression(node) {
      if (!allowed.directory && node.callee.type === 'Identifier' && node.callee.name === 'ChatDirectory')
        fail(node.start, 'ChatDirectory must be shared from compose.ts')
    },
  }).visit(result.program)
  return violations
}
