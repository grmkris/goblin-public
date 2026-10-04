/**
 * The `purrable` oxlint plugin: repository invariants from AGENTS.md that a generic linter cannot know.
 *
 * - `no-process-env`: app settings reach Workers only through `Config`; module-level code that must name things before
 *   the stack runs reads the environment through `stageFromEnv(app, process.env)`. Exemptions live in oxlint.config.ts.
 * - `resource-name-via-stage`: named Alchemy resources take their physical name from the stage
 *   (`stage.resourceName(role)` or `stage.workerName`), so the naming scheme and the pinned prod names apply.
 * - `require-disable-description`: every disable directive says why (`-- reason`): oxlint and eslint ones, and an
 *   `@effect-diagnostics` directive that turns a diagnostic off.
 */
import { definePlugin, defineRule } from '@oxlint/plugins'
import type { Context, ESTree } from '@oxlint/plugins'
import { isFreeReference, isStringLiteral } from './scope.ts'

type AnyNode = ESTree.Node

/** Strips the wrappers that do not change what an expression is: TS casts, non-null, optional chains. */
const unwrap = (node: AnyNode): AnyNode => {
  let current = node
  for (;;) {
    if (
      current.type === 'TSAsExpression' ||
      current.type === 'TSNonNullExpression' ||
      current.type === 'TSSatisfiesExpression' ||
      current.type === 'TSTypeAssertion' ||
      current.type === 'ParenthesizedExpression'
    ) {
      current = current.expression
    } else if (current.type === 'ChainExpression') {
      current = current.expression
    } else {
      return current
    }
  }
}

const propertyName = (node: ESTree.MemberExpression): string | undefined => {
  if (!node.computed && node.property.type === 'Identifier') return node.property.name
  if (node.computed && isStringLiteral(node.property)) return node.property.value
  return undefined
}

// ---------------------------------------------------------------------------------------------------------------------
// no-process-env

/** Is `node` (the object of `.env`) the global `process`, directly or as `globalThis.process`? */
const isGlobalProcess = (context: Context, node: AnyNode): boolean => {
  const object = unwrap(node)
  if (object.type === 'Identifier') return object.name === 'process' && isFreeReference(context, object)
  if (object.type === 'MemberExpression' && propertyName(object) === 'process') {
    const owner = unwrap(object.object)
    return owner.type === 'Identifier' && (owner.name === 'globalThis' || owner.name === 'global')
  }
  return false
}

/** `f` for `f(...)` and `x.f(...)`. */
const calleeName = (call: ESTree.CallExpression): string | undefined => {
  const callee = unwrap(call.callee)
  if (callee.type === 'Identifier') return callee.name
  if (callee.type === 'MemberExpression') return propertyName(callee)
  return undefined
}

/** Is this `process.env` read the second argument of `stageFromEnv(app, env)` (possibly behind `??` or a cast)? */
const feedsStageFromEnv = (node: AnyNode): boolean => {
  let current: AnyNode = node
  let parent = current.parent
  while (
    parent !== undefined &&
    parent !== null &&
    (parent.type === 'LogicalExpression' ||
      parent.type === 'ChainExpression' ||
      parent.type === 'TSAsExpression' ||
      parent.type === 'TSNonNullExpression' ||
      parent.type === 'TSSatisfiesExpression' ||
      parent.type === 'ParenthesizedExpression')
  ) {
    current = parent
    parent = current.parent
  }
  if (parent === undefined || parent === null || parent.type !== 'CallExpression') return false
  return calleeName(parent) === 'stageFromEnv' && parent.arguments[1] === current
}

export const noProcessEnv = defineRule({
  meta: {
    type: 'problem',
    docs: { description: 'Settings come through Effect Config or stageFromEnv, never process.env.' },
    messages: {
      env: '`process.env` is read here. App settings reach a Worker only through Effect `Config` (Config.String / Config.Redacted and the env bindings); module-level code that must name resources before the stack runs calls `stageFromEnv(app, process.env)`. Read the value through one of those (docs/agents/lint-quality.md). Exempt files are listed in oxlint.config.ts.',
    },
    schema: [],
  },
  create(context: Context) {
    return {
      MemberExpression: (node: ESTree.MemberExpression): void => {
        if (propertyName(node) !== 'env' || !isGlobalProcess(context, node.object)) return
        if (feedsStageFromEnv(node)) return
        context.report({ messageId: 'env', node })
      },
    }
  },
})

// ---------------------------------------------------------------------------------------------------------------------
// resource-name-via-stage

const DEFAULT_NAMED = ['D1.Database', 'R2.Bucket', 'Website.Vite', 'Worker']

const isString = (value: unknown): value is string => typeof value === 'string'

/** The rule's option, `{ named: string[] }` (oxlint validates it against the schema below first). */
const isNamedOption = (value: unknown): value is { readonly named: readonly string[] } =>
  typeof value === 'object' &&
  value !== null &&
  'named' in value &&
  Array.isArray(value.named) &&
  value.named.every(isString)

/** `Cloudflare.D1.Database` for a member chain of identifiers; undefined for anything else. */
const dottedName = (node: AnyNode): string | undefined => {
  const n = unwrap(node)
  if (n.type === 'Identifier') return n.name
  if (n.type === 'MemberExpression') {
    const head = dottedName(n.object)
    const tail = propertyName(n)
    return head === undefined || tail === undefined ? undefined : `${head}.${tail}`
  }
  return undefined
}

/** The resource constructor a call names: `Cloudflare.X(...)` or the curried class factory `Cloudflare.X<T>()(...)`. */
const constructorName = (call: ESTree.CallExpression): string | undefined => {
  const callee = unwrap(call.callee)
  if (callee.type === 'CallExpression') return dottedName(callee.callee)
  return dottedName(callee)
}

/** The `name` values a props expression can set: plain properties, spreads and both arms of a conditional. */
const nameValues = (node: AnyNode): AnyNode[] | undefined => {
  const n = unwrap(node)
  if (n.type === 'ConditionalExpression') {
    const consequent = nameValues(n.consequent)
    const alternate = nameValues(n.alternate)
    if (consequent === undefined || alternate === undefined) return undefined
    return [...consequent, ...alternate]
  }
  if (n.type !== 'ObjectExpression') return undefined
  const found: AnyNode[] = []
  for (const property of n.properties) {
    if (property.type === 'SpreadElement') {
      // `...D1_DEFAULTS` cannot be read here; `...(c ? {} : { name })` can.
      const inner = nameValues(property.argument)
      if (inner !== undefined) found.push(...inner)
    } else if (!property.computed && property.key.type === 'Identifier' && property.key.name === 'name') {
      found.push(property.value)
    }
  }
  return found
}

/** `x.resourceName('role')` or `x.workerName`. */
const isStageName = (node: AnyNode): boolean => {
  const n = unwrap(node)
  if (n.type === 'MemberExpression') return propertyName(n) === 'workerName'
  if (n.type !== 'CallExpression') return false
  const callee = unwrap(n.callee)
  const [role] = n.arguments
  return (
    callee.type === 'MemberExpression' &&
    propertyName(callee) === 'resourceName' &&
    n.arguments.length === 1 &&
    role !== undefined &&
    isStringLiteral(role)
  )
}

export const resourceNameViaStage = defineRule({
  meta: {
    type: 'problem',
    docs: { description: 'Named Alchemy resources take their physical name from the stage.' },
    messages: {
      missing:
        "`{{callee}}` declares a named resource without `name:`, so Alchemy would generate the physical name. Pass `name: stage.resourceName('<role>')` (the Worker: `stage.workerName`) so the stage naming scheme and the prod names pinned in the deployment configuration apply (docs/agents/lint-quality.md).",
      literal:
        "`{{callee}}` takes its `name:` from somewhere other than the stage. Use `stage.resourceName('<role>')` (the Worker: `stage.workerName`): prod names are pinned in the deployment configuration, and renaming a prod resource loses its data (docs/agents/lint-quality.md).",
    },
    schema: [
      {
        type: 'object',
        properties: { named: { type: 'array', items: { type: 'string' } } },
        additionalProperties: false,
      },
    ],
  },
  create(context: Context) {
    const option: unknown = context.options[0]
    const named = isNamedOption(option) ? option.named : DEFAULT_NAMED
    return {
      CallExpression: (node: ESTree.CallExpression): void => {
        // `Cloudflare.Worker<T>()` is the factory step of the curried form; the outer call carries the props.
        if (node.parent?.type === 'CallExpression' && node.parent.callee === node) return
        const callee = constructorName(node)
        if (callee === undefined || !callee.startsWith('Cloudflare.')) return
        if (!named.some((n) => callee === `Cloudflare.${n}`)) return
        const props = node.arguments[1]
        if (props === undefined) {
          context.report({ messageId: 'missing', data: { callee }, node })
          return
        }
        const values = nameValues(props)
        if (values === undefined) return // props built elsewhere (a variable): not statically checkable here
        if (values.length === 0) {
          context.report({ messageId: 'missing', data: { callee }, node })
          return
        }
        for (const value of values) {
          if (!isStageName(value)) context.report({ messageId: 'literal', data: { callee }, node: value })
        }
      },
    }
  },
})

// ---------------------------------------------------------------------------------------------------------------------
// require-disable-description

const DIRECTIVE = /^\s*(?:oxlint|eslint)-disable(?:-next-line|-line)?(?:\s|$)/
/** `@effect-diagnostics[-next-line] <name>:off` (effect:check); one that raises a severity needs no reason. */
const EFFECT_OFF = /^\s*@effect-diagnostics(?:-next-line)?\s[^-]*:off\b/
const MIN_REASON = 10

export const requireDisableDescription = defineRule({
  meta: {
    type: 'problem',
    docs: { description: 'Disable directives say why: `-- reason`.' },
    messages: {
      reason:
        'This disable directive has no reason. Write `{{directive}} {{target}} -- <why the rule is wrong here>` (at least 10 characters), or fix the code instead (docs/agents/lint-quality.md).',
    },
    schema: [],
  },
  create(context: Context) {
    return {
      Program: (): void => {
        for (const comment of context.sourceCode.getAllComments()) {
          const text = comment.value
          if (!DIRECTIVE.test(text) && !EFFECT_OFF.test(text)) continue
          const separator = text.indexOf('--')
          const reason = separator === -1 ? '' : text.slice(separator + 2).trim()
          if (reason.length >= MIN_REASON) continue
          const directive = text.trim().split(/\s/)[0] ?? 'oxlint-disable'
          const target = directive.startsWith('@effect') ? '<diagnostic>:off' : '<rule>'
          context.report({ messageId: 'reason', data: { directive, target }, loc: comment.loc })
        }
      },
    }
  },
})

export default definePlugin({
  meta: { name: 'purrable' },
  rules: {
    'no-process-env': noProcessEnv,
    'resource-name-via-stage': resourceNameViaStage,
    'require-disable-description': requireDisableDescription,
  },
})
