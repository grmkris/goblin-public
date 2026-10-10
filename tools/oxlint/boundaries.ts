/**
 * The `boundaries` oxlint plugin: enforces `tools/graph.ts` per file, so a crossed boundary shows up in the editor and in
 * `bun run check:files`, not only at the end of a session. It is an AST rule rather than a text scan so that type-only
 * imports count too.
 *
 * - `no-cross-boundary-import`: a `@goblin/*` import must be a declared edge of the importing workspace (a browser file
 *   takes a cloud workspace's built files only as assets, `?url` or `?raw`, never its code), and a
 *   runtime-bound module (`bun`, `bun:*`, `@effect/platform-bun`, `cloudflare:*`, `node:*`) must suit the runtime of the
 *   importing file (its workspace's runtime, or the zone's: `scripts/` is tooling, `test/` is test, root files are
 *   tooling, and a node's own `zones` override both). An entry a node `forbids` stays closed even where its workspace is
 *   a declared edge.
 * - `no-closed-import`: a module a node declares `closed` (or its closed exports) is imported only by the files it
 *   lists, so the ways into the runtime's Effect stay where they are meant to be.
 * - `no-runtime-global`: the `Bun` global, under the same runtime rule.
 */
import { definePlugin, defineRule } from '@oxlint/plugins'
import type { Context, ESTree } from '@oxlint/plugins'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { nodes, runtimeAllows, runtimeModules, zones } from '../graph.ts'
import type { Node, Runtime } from '../graph.ts'
import { isFreeReference, isStringLiteral } from './scope.ts'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const byLongestDir = nodes.toSorted((a, b) => b.dir.length - a.dir.length)

export interface Placement {
  readonly node: Node
  readonly runtime: Runtime
  /** Repo-relative path, for messages. */
  readonly file: string
}

/** The workspace that owns a file and the runtime that file runs in; undefined outside every workspace. */
export const placementOf = (filename: string): Placement | undefined => {
  const file = path.relative(repoRoot, filename).split(path.sep).join('/')
  const node = byLongestDir.find((n) => file.startsWith(`${n.dir}/`))
  if (node === undefined) return undefined
  const inner = file.slice(node.dir.length + 1)
  const own = Object.keys(node.zones ?? {})
    .filter((prefix) => inner === prefix || inner.startsWith(`${prefix}/`))
    .toSorted((a, b) => b.length - a.length)[0]
  if (own !== undefined && node.zones !== undefined) return { node, runtime: node.zones[own] ?? node.runtime, file }
  const slash = inner.indexOf('/')
  // A file at the workspace root is a config or a stack file (vite.config.ts, alchemy.run.ts): tooling.
  const runtime = slash === -1 ? 'tooling' : (zones[inner.slice(0, slash)] ?? node.runtime)
  return { node, runtime, file }
}

type Family = keyof typeof runtimeModules
// SAFETY: runtimeModules is a literal object, so Object.keys yields exactly its keys.
const families = Object.keys(runtimeModules) as Family[]

const familyOf = (specifier: string): Family | undefined =>
  families.find((family) =>
    runtimeModules[family].some((entry) =>
      entry.endsWith(':') ? specifier.startsWith(entry) : specifier === entry || specifier.startsWith(`${entry}/`),
    ),
  )

const fixFor: Record<Family, string> = {
  bun: 'Bun APIs belong to tooling (scripts/, stack and config files). Use an Effect platform service or the Web API, or move this code into a daemon or a script.',
  cloudflare:
    'Only Worker runtime zones may import cloudflare:*. Pass bindings into shared packages rather than importing runtime internals.',
  node: 'Browser bundles cannot load node:* modules. Use a Web API, or move this code out of the browser bundle.',
}

const workspaceOf = (specifier: string): string | undefined =>
  specifier.startsWith('@goblin/') ? specifier.split('/').slice(0, 2).join('/') : undefined

/** An asset import: the file's URL or text goes into the bundle, never its code. */
const isAsset = (specifier: string): boolean => /\?(?:url|raw)$/u.test(specifier)

type Sourced =
  | ESTree.ImportDeclaration
  | ESTree.ExportAllDeclaration
  | ESTree.ExportNamedDeclaration
  | ESTree.ImportExpression

export const noCrossBoundaryImport = defineRule({
  meta: {
    type: 'problem',
    docs: { description: 'Imports must follow tools/graph.ts: declared workspace edges and runtime-bound modules.' },
    messages: {
      workspace:
        '`{{specifier}}` is not a declared dependency of {{dir}} ({{role}}) Declared workspace imports: {{allowed}}. Import from one of those, or add {{target}} to {{dir}}/package.json and to the `mayImport` of {{dir}} in tools/graph.ts (`bun run graph` checks that they agree).',
      runtime: '`{{specifier}}` is a {{family}} module, but {{file}} runs as `{{runtime}}` (tools/graph.ts). {{fix}}',
      forbidden: '{{dir}} must not import `{{entry}}`: {{reason}} (`forbids` in tools/graph.ts).',
    },
    schema: [],
  },
  create(context: Context) {
    const placement = placementOf(context.physicalFilename)
    if (placement === undefined) return {}

    const forbidden = Object.entries(placement.node.forbids ?? {})
    const check = (specifier: string, node: Sourced): void => {
      const closed = forbidden.find(([entry]) => specifier === entry || specifier.startsWith(`${entry}/`))
      if (closed !== undefined) {
        const [entry, reason] = closed
        context.report({ messageId: 'forbidden', data: { dir: placement.node.dir, entry, reason }, node })
        return
      }
      const target = workspaceOf(specifier)
      if (target !== undefined) {
        // The web workspace may import the runtime only from its Worker adapter. Browser routes/components must
        // remain browser-only even though the package edge is needed by `src/worker.ts`; a built asset is no code.
        const cloudCode =
          placement.runtime === 'browser' &&
          nodes.find((item) => item.name === target)?.runtime === 'cloud' &&
          !isAsset(specifier)
        if (target === placement.node.name || (placement.node.mayImport.includes(target) && !cloudCode)) return
        const allowed = placement.node.mayImport.length === 0 ? 'none' : placement.node.mayImport.join(', ')
        context.report({
          messageId: 'workspace',
          data: { specifier, dir: placement.node.dir, role: placement.node.role, allowed, target },
          node,
        })
        return
      }
      const family = familyOf(specifier)
      if (family === undefined || runtimeAllows[placement.runtime].includes(family)) return
      context.report({
        messageId: 'runtime',
        data: { specifier, family, file: placement.file, runtime: placement.runtime, fix: fixFor[family] },
        node,
      })
    }

    const fromSource = (node: Exclude<Sourced, ESTree.ImportExpression>): void => {
      if (node.source !== null && node.source !== undefined) check(node.source.value, node)
    }

    return {
      ImportDeclaration: fromSource,
      ExportAllDeclaration: fromSource,
      ExportNamedDeclaration: fromSource,
      // A dynamic import names a module only when its specifier is a string literal.
      ImportExpression: (node: ESTree.ImportExpression): void => {
        if (isStringLiteral(node.source)) check(node.source.value, node)
      },
    }
  },
})

/** The repo-relative file a relative specifier names, from the importing file; undefined for a package specifier. */
const resolvedFrom = (filename: string, specifier: string): string | undefined => {
  if (!specifier.startsWith('.')) return undefined
  const target = path.resolve(path.dirname(filename), specifier)
  return path.relative(repoRoot, target).split(path.sep).join('/')
}

/** Is `file` (relative to its workspace) one of `importers`, a listed file or under a listed directory? */
const listed = (importers: readonly string[], file: string): boolean =>
  importers.some((entry) => (entry.endsWith('/') ? file.startsWith(entry) : file === entry))

/** The names an import or re-export takes from its module; undefined when it takes all of them. */
const namesTaken = (node: Sourced): readonly string[] | undefined => {
  if (node.type === 'ImportDeclaration') {
    const names: string[] = []
    for (const specifier of node.specifiers) {
      if (specifier.type === 'ImportNamespaceSpecifier') return undefined
      if (specifier.type === 'ImportDefaultSpecifier') names.push('default')
      else names.push(specifier.imported.type === 'Identifier' ? specifier.imported.name : specifier.imported.value)
    }
    return names
  }
  if (node.type === 'ExportNamedDeclaration')
    return node.specifiers.map((specifier) =>
      specifier.local.type === 'Identifier' ? specifier.local.name : specifier.local.value,
    )
  return undefined
}

export const noClosedImport = defineRule({
  meta: {
    type: 'problem',
    docs: { description: 'A module a workspace closes in tools/graph.ts is imported only by the files it lists.' },
    messages: {
      closed:
        '{{file}} may not import {{what}}`{{module}}`: {{reason}}. Only these may: {{importers}} (`closed` in tools/graph.ts). Compose the program instead, or list this file there and say why in the commit.',
    },
    schema: [],
  },
  create(context: Context) {
    const importer = path.relative(repoRoot, context.physicalFilename).split(path.sep).join('/')
    const check = (specifier: string, node: Sourced): void => {
      const target = resolvedFrom(context.physicalFilename, specifier)
      const owner = target === undefined ? undefined : placementOf(path.join(repoRoot, target))?.node
      if (target === undefined || owner?.closed === undefined) return
      const module = target.slice(owner.dir.length + 1)
      const closed = owner.closed[module] ?? owner.closed[`${module}.ts`]
      if (closed === undefined) return
      if (importer.startsWith(`${owner.dir}/`) && listed(closed.importers, importer.slice(owner.dir.length + 1))) return
      const taken = namesTaken(node)
      const names = closed.names
      if (names !== undefined && taken !== undefined && !taken.some((name) => names.includes(name))) return
      context.report({
        messageId: 'closed',
        data: {
          file: importer,
          what: names === undefined ? 'the module ' : `${names.join(', ')} from `,
          module: `${owner.dir}/${module}`,
          reason: closed.reason,
          importers: closed.importers.join(', '),
        },
        node,
      })
    }
    const fromSource = (node: Exclude<Sourced, ESTree.ImportExpression>): void => {
      if (node.source !== null && node.source !== undefined) check(node.source.value, node)
    }
    return {
      ImportDeclaration: fromSource,
      ExportAllDeclaration: fromSource,
      ExportNamedDeclaration: fromSource,
      ImportExpression: (node: ESTree.ImportExpression): void => {
        if (isStringLiteral(node.source)) check(node.source.value, node)
      },
    }
  },
})

export const noRuntimeGlobal = defineRule({
  meta: {
    type: 'problem',
    docs: { description: 'The Bun global is for daemons and tooling only (tools/graph.ts).' },
    messages: {
      bun: '`Bun` is the Bun runtime global, but {{file}} runs as `{{runtime}}` (tools/graph.ts). {{fix}}',
    },
    schema: [],
  },
  create(context: Context) {
    const placement = placementOf(context.physicalFilename)
    if (placement === undefined || runtimeAllows[placement.runtime].includes('bun')) return {}
    return {
      Identifier: (node: ESTree.IdentifierReference): void => {
        if (node.name !== 'Bun' || !isFreeReference(context, node)) return
        context.report({
          messageId: 'bun',
          data: { file: placement.file, runtime: placement.runtime, fix: fixFor.bun },
          node,
        })
      },
    }
  },
})

export default definePlugin({
  meta: { name: 'boundaries' },
  rules: {
    'no-cross-boundary-import': noCrossBoundaryImport,
    'no-closed-import': noClosedImport,
    'no-runtime-global': noRuntimeGlobal,
  },
})
