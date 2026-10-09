/**
 * The web data layer's invariants: the app's client feeds query and mutation factories, React effects start no network
 * work, and views read API data from the Query cache (docs/agents/lint-quality.md).
 *
 * Ported from myapps (`grmkris/myapps` `27416c98`, `tools/oxlint/data-invariants.ts`, the rules of its ADR 0013) with
 * its tests (tools/test/data-invariants.test.ts). Changed: the messages point at goblin's docs, and the
 * `@myapps/query` import no longer names the query bridge (goblin's lives in `apps/web/src/lib/query/`; a
 * `makeApiQuery` call is recognised by name either way). goblin's transport list is the `callees` option in
 * oxlint.config.ts.
 */
import { defineRule } from '@oxlint/plugins'
import type { Context, ESTree } from '@oxlint/plugins'
import { memberName, someNode } from './ast.ts'
import { isFreeReference, isStringLiteral } from './scope.ts'

const transportCallees = [
  'fetch',
  'XMLHttpRequest',
  'HttpClient.*',
  'HttpApiClient.make',
  'callApi',
  '*.run',
  '*.callTool',
  'chrome.runtime.sendMessage',
]
const transportSchema = [
  {
    type: 'object',
    properties: { callees: { type: 'array', items: { type: 'string' }, uniqueItems: true } },
    additionalProperties: false,
  },
]
const isString = (value: unknown): value is string => typeof value === 'string'
const isCalleeOption = (value: unknown): value is { readonly callees: readonly string[] } =>
  typeof value === 'object' &&
  value !== null &&
  'callees' in value &&
  Array.isArray(value.callees) &&
  value.callees.every(isString)

const unwrap = (node: ESTree.Node): ESTree.Node => {
  if (
    node.type === 'ChainExpression' ||
    node.type === 'TSAsExpression' ||
    node.type === 'TSNonNullExpression' ||
    node.type === 'TSSatisfiesExpression' ||
    node.type === 'TSTypeAssertion' ||
    node.type === 'ParenthesizedExpression'
  )
    return unwrap(node.expression)
  return node
}

/** Resolve the actual binding, so imports can be aliased without confusing a shadowing parameter with a global. */
const definitionOf = (context: Context, node: ESTree.Node) => {
  for (
    let scope: ReturnType<Context['sourceCode']['getScope']> | null = context.sourceCode.getScope(node);
    scope !== null;
    scope = scope.upper
  ) {
    const reference = scope.references.find((candidate) => candidate.identifier === node)
    if (reference !== undefined) return reference.resolved?.defs[0]
  }
  return undefined
}

const importSource = (node: ESTree.Node): string | undefined =>
  node.parent?.type === 'ImportDeclaration' ? node.parent.source.value : undefined

const importedName = (node: ESTree.ImportSpecifier): string =>
  node.imported.type === 'Identifier' ? node.imported.name : node.imported.value

const identifierName = (context: Context, node: ESTree.Node & { readonly name: string }): string | undefined => {
  const definition = definitionOf(context, node)?.node
  if (definition === undefined) return isFreeReference(context, node) ? node.name : undefined
  const source = importSource(definition)
  if (definition.type === 'ImportSpecifier') {
    const name = importedName(definition)
    if (source?.endsWith('/HttpClient')) return `HttpClient.${name}`
    if (source?.endsWith('/HttpApiClient')) return `HttpApiClient.${name}`
    return name
  }
  if (source === 'react') return 'React'
  if (source?.endsWith('/HttpClient')) return 'HttpClient'
  if (source?.endsWith('/HttpApiClient')) return 'HttpApiClient'
  return [
    'fetch',
    'XMLHttpRequest',
    'HttpClient',
    'HttpApiClient',
    'useEffect',
    'useLayoutEffect',
    'useLoaderData',
    'window',
    'globalThis',
    'self',
    'chrome',
    'React',
  ].includes(node.name)
    ? undefined
    : node.name
}

const calleeName = (context: Context, node: ESTree.Node): string | undefined => {
  const value = unwrap(node)
  if (value.type === 'Identifier') return identifierName(context, value)
  if (value.type !== 'MemberExpression') return undefined
  const head = calleeName(context, value.object)
  const tail = memberName(value)
  if (
    head !== undefined &&
    ['window', 'globalThis', 'self'].includes(head) &&
    ['fetch', 'XMLHttpRequest'].includes(tail ?? '')
  )
    return tail
  return head === undefined || tail === undefined ? undefined : `${head}.${tail}`
}

const propertyName = (node: ESTree.Node): string | undefined => {
  if (node.type !== 'Property') return undefined
  if (!node.computed && node.key.type === 'Identifier') return node.key.name
  return isStringLiteral(node.key) ? node.key.value : undefined
}

/** Follow local aliases and functions without traversing another source file or cycling through a self-reference. */
const localValue = (context: Context, node: ESTree.Node, seen = new Set<ESTree.Node>()): ESTree.Node => {
  const value = unwrap(node)
  if (value.type !== 'Identifier' || seen.has(value)) return value
  const definition = definitionOf(context, value)?.node
  if (definition?.type === 'FunctionDeclaration') return definition
  if (definition?.type !== 'VariableDeclarator' || definition.init === null) return value
  return localValue(context, definition.init, new Set(seen).add(value))
}

/** `*.run` is reserved for makeApiQuery results and exports from the app's lib/api client, not arbitrary task runners. */
const isApiQueryOwner = (context: Context, node: ESTree.Node, seen = new Set<ESTree.Node>()): boolean => {
  const value = localValue(context, node)
  if (seen.has(value)) return false
  if (value.type === 'CallExpression') return /(?:^|\.)makeApiQuery$/u.test(calleeName(context, value.callee) ?? '')
  if (value.type === 'MemberExpression') return isApiQueryOwner(context, value.object, new Set(seen).add(value))
  if (value.type !== 'Identifier') return false
  const definition = definitionOf(context, value)?.node
  const source = definition === undefined ? undefined : importSource(definition)
  return source !== undefined && /(?:^|\/)lib\/api[^/]*$/u.test(source)
}

const matchesCallee = (pattern: string, name: string): boolean => {
  const expected = pattern.split('.')
  const actual = name.split('.')
  return expected.length === actual.length && expected.every((part, index) => part === '*' || part === actual[index])
}

const isTransport = (
  context: Context,
  node: ESTree.CallExpression | ESTree.NewExpression,
  callees: readonly string[],
): boolean => {
  const callee = unwrap(node.callee)
  if (callee.type === 'MemberExpression') {
    const method = memberName(callee)
    if (method === 'run' && callees.includes('*.run') && isApiQueryOwner(context, callee.object)) return true
    if (method === 'callTool' && callees.includes('*.callTool')) return true
  }
  const name = calleeName(context, callee)
  // The wildcard run entry is provenance-checked above; a custom exact runner remains configurable.
  return name !== undefined && callees.some((pattern) => pattern !== '*.run' && matchesCallee(pattern, name))
}

const isImmediatelyCalled = (node: ESTree.Node): boolean => {
  let current = node
  while (current.parent !== undefined && current.parent !== null && unwrap(current.parent) === node)
    current = current.parent
  return current.parent?.type === 'CallExpression' && current.parent.callee === current
}

const insideQueryFunction = (node: ESTree.Node): boolean => {
  let current = node.parent
  let insideFunction = false
  while (current !== undefined && current !== null) {
    if (
      (current.type === 'ArrowFunctionExpression' || current.type === 'FunctionExpression') &&
      !isImmediatelyCalled(current)
    )
      insideFunction = true
    if (current.type === 'Property' && current.parent?.type === 'ObjectExpression') {
      const name = propertyName(current)
      if (insideFunction && (name === 'queryFn' || name === 'mutationFn')) return true
    }
    current = current.parent
  }
  return false
}

/** Calls are checked lexically through all nested functions and promise callbacks within an effect callback. */
const insideEffect = (context: Context, node: ESTree.Node, callbacks: ReadonlySet<ESTree.Node>): boolean => {
  let current: ESTree.Node = node
  for (let parent = current.parent; parent !== undefined && parent !== null; parent = current.parent) {
    if (callbacks.has(parent)) return true
    if (parent.type === 'CallExpression' && parent.arguments[0] === current) {
      const name = calleeName(context, parent.callee)
      if (
        name !== undefined &&
        ['useEffect', 'useLayoutEffect', 'React.useEffect', 'React.useLayoutEffect'].includes(name)
      )
        return true
    }
    current = parent
  }
  return false
}

/** Client-module exemptions belong in documented config overrides; this rule has no filename escape hatch. */
export const noTransportOutsideClient = defineRule({
  meta: {
    type: 'problem',
    docs: {
      description:
        'Server calls use app client query/mutation factories (myapps ADR 0013); callees replaces the default list.',
    },
    messages: {
      transport:
        "Server calls go through the app's client in a query or mutation factory (docs/agents/lint-quality.md).",
    },
    schema: transportSchema,
  },
  create(context: Context) {
    const option: unknown = context.options[0]
    const callees = isCalleeOption(option) ? option.callees : transportCallees
    const check = (node: ESTree.CallExpression | ESTree.NewExpression): void => {
      if (isTransport(context, node, callees) && !insideQueryFunction(node))
        context.report({ node, messageId: 'transport' })
    }
    return { CallExpression: check, NewExpression: check }
  },
})

/** Query/mutation wrappers do not permit network work or mutation starts inside a React effect (myapps ADR 0013). */
export const noNetworkInEffect = defineRule({
  meta: {
    type: 'problem',
    docs: {
      description:
        'Effects start no server reads or writes (myapps ADR 0013); callees replaces the default transport list.',
    },
    messages: {
      network:
        'Read server data with a query factory (useQuery/useSuspenseQuery); start writes from the event handler with a mutation (docs/agents/lint-quality.md).',
    },
    schema: transportSchema,
  },
  create(context: Context) {
    const option: unknown = context.options[0]
    const callees = isCalleeOption(option) ? option.callees : transportCallees
    const calls: (ESTree.CallExpression | ESTree.NewExpression)[] = []
    const callbacks = new Set<ESTree.Node>()
    const check = (node: ESTree.CallExpression | ESTree.NewExpression): void => {
      const method = memberName(unwrap(node.callee))
      if (method === 'mutate' || method === 'mutateAsync' || isTransport(context, node, callees)) calls.push(node)
      const name = calleeName(context, node.callee)
      const callback = node.arguments[0]
      if (
        name !== undefined &&
        ['useEffect', 'useLayoutEffect', 'React.useEffect', 'React.useLayoutEffect'].includes(name) &&
        callback !== undefined
      )
        callbacks.add(localValue(context, callback))
    }
    return {
      CallExpression: check,
      NewExpression: check,
      'Program:exit'() {
        for (const node of calls) {
          if (insideEffect(context, node, callbacks)) context.report({ node, messageId: 'network' })
        }
      },
    }
  },
})

const usesQueryCache = (context: Context, node: ESTree.Node): boolean =>
  someNode(context, localValue(context, node), (child) => {
    if ((child.type === 'Identifier' && child.name === 'queryClient') || memberName(child) === 'queryClient')
      return true
    if (child.type !== 'CallExpression') return false
    const name = calleeName(context, child.callee) ?? memberName(unwrap(child.callee))
    return name !== undefined && /(?:Query|Options)$/u.test(name)
  })

const isLoaderRead = (context: Context, node: ESTree.CallExpression): boolean => {
  const callee = unwrap(node.callee)
  return (
    (callee.type === 'Identifier' && identifierName(context, callee) === 'useLoaderData') ||
    memberName(callee) === 'useLoaderData'
  )
}

const isQueryLoaderMode = (option: unknown): option is { readonly mode: 'query-loaders' } =>
  typeof option === 'object' && option !== null && 'mode' in option && option.mode === 'query-loaders'

const originBindingValue = (
  context: Context,
  node: ESTree.Node & { readonly name: string },
): ESTree.Node | undefined => {
  const definition = definitionOf(context, node)?.node
  if (definition?.type !== 'VariableDeclarator' || definition.init === null) return undefined
  if (definition.id.type === 'Identifier') return definition.init
  if (definition.id.type !== 'ArrayPattern') return undefined
  const index = definition.id.elements.findIndex(
    (element) => element?.type === 'Identifier' && element.name === node.name,
  )
  const init = definition.init.type === 'AwaitExpression' ? definition.init.argument : definition.init
  if (init.type !== 'CallExpression' || calleeName(context, init.callee) !== 'Promise.all') return undefined
  const items = init.arguments[0]
  return items?.type === 'ArrayExpression' ? (items.elements[index] ?? undefined) : undefined
}

const isOriginValue = (context: Context, node: ESTree.Node, seen = new Set<ESTree.Node>()): boolean => {
  const value = unwrap(node)
  if (seen.has(value)) return false
  const next = new Set(seen).add(value)
  if (value.type === 'AwaitExpression') return isOriginValue(context, value.argument, next)
  if (isStringLiteral(value)) return true
  if (value.type === 'CallExpression') return /(?:^|\.)getOrigin$/u.test(calleeName(context, value.callee) ?? '')
  if (value.type !== 'Identifier') return false
  const binding = originBindingValue(context, value)
  return binding !== undefined && isOriginValue(context, binding, next)
}

/** Start origin metadata remains legal when the loader only primes Query and returns an origin object. */
const returnsOnlyOrigin = (context: Context, loader: ESTree.Node): boolean => {
  const value = localValue(context, loader)
  const originObject = (node: ESTree.Node): boolean =>
    node.type === 'ObjectExpression' &&
    node.properties.length === 1 &&
    node.properties[0]?.type === 'Property' &&
    propertyName(node.properties[0]) === 'origin' &&
    isOriginValue(context, node.properties[0].value)
  if (value.type === 'ArrowFunctionExpression' && value.body.type !== 'BlockStatement') return originObject(value.body)
  let found = false
  const otherReturn = someNode(context, value, (node) => {
    if (node.type !== 'ReturnStatement') return false
    found = true
    return node.argument === null || !originObject(node.argument)
  })
  return found && !otherReturn
}

/** In query-loaders mode, origin-only server-function metadata is not API data (myapps ADR 0013). */
export const noLoaderData = defineRule({
  meta: {
    type: 'problem',
    docs: {
      description:
        'Views read API data from Query; query-loaders mode retains Start origin metadata (myapps ADR 0013).',
    },
    messages: {
      loader:
        "API data comes from the cache (useSuspenseQuery with the loader's query options), not useLoaderData (docs/agents/lint-quality.md).",
    },
    schema: [{ type: 'object', properties: { mode: { enum: ['all', 'query-loaders'] } }, additionalProperties: false }],
  },
  create(context: Context) {
    const queryLoaders = isQueryLoaderMode(context.options[0])
    const loaders: ESTree.Node[] = []
    const reads: ESTree.CallExpression[] = []
    return {
      Property(node: ESTree.Node) {
        if (node.type === 'Property' && propertyName(node) === 'loader' && node.parent?.type === 'ObjectExpression')
          loaders.push(node.value)
      },
      CallExpression(node: ESTree.CallExpression) {
        if (isLoaderRead(context, node)) reads.push(node)
      },
      'Program:exit'() {
        if (queryLoaders && !loaders.some((loader) => usesQueryCache(context, loader))) return
        if (queryLoaders && loaders.length > 0 && loaders.every((loader) => returnsOnlyOrigin(context, loader))) return
        for (const node of reads) context.report({ node, messageId: 'loader' })
      },
    }
  },
})
