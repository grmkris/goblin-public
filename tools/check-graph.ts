/**
 * `bun run graph`: the whole-repository properties of tools/graph.ts that a per-file lint rule cannot see.
 *
 * 1. Every workspace has a node, and every node is a workspace with the same package name.
 * 2. A node's `mayImport` equals the `@goblin/*` entries of its manifest (dependencies and devDependencies), so a new
 *    edge is always a two-file change a reviewer sees.
 * 3. A workspace that no app reaches declares a `seam` saying why it exists, and a reachable one does not.
 * 4. Every path a node's own `zones` names exists, so a moved file cannot leave a stale exception behind.
 */
import { Schema } from 'effect'
import { stat } from 'node:fs/promises'
import { nodes } from './graph.ts'

const Manifest = Schema.Struct({
  name: Schema.optional(Schema.String),
  dependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  devDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
})
const RootManifest = Schema.Struct({
  workspaces: Schema.Struct({ packages: Schema.Array(Schema.String) }),
})

const decodeManifest = Schema.decodeUnknownSync(Manifest)
const root = Schema.decodeUnknownSync(RootManifest)(await Bun.file('package.json').json())

const workspaceDirs: string[] = []
for (const pattern of root.workspaces.packages) {
  for await (const match of new Bun.Glob(`${pattern}/package.json`).scan({ onlyFiles: true })) {
    workspaceDirs.push(match.replace(/\/package\.json$/u, ''))
  }
}

const failures: string[] = []
const edit = 'Edit tools/graph.ts (and the manifest) and say why in the commit.'

const declared = new Set(nodes.map((node) => node.dir))
for (const dir of workspaceDirs) {
  if (!declared.has(dir)) {
    failures.push(`${dir} is a workspace without a node in tools/graph.ts. Add one: role, runtime, mayImport. ${edit}`)
  }
}

for (const node of nodes) {
  if (!workspaceDirs.includes(node.dir)) {
    failures.push(`tools/graph.ts declares ${node.dir}, which is not a workspace. Remove the node or add the package.`)
    continue
  }
  const manifest = decodeManifest(await Bun.file(`${node.dir}/package.json`).json())
  if (manifest.name !== node.name) {
    failures.push(
      `${node.dir}/package.json is named ${manifest.name ?? '(none)'}, but tools/graph.ts says ${node.name}.`,
    )
  }
  for (const zone of Object.keys(node.zones ?? {})) {
    const exists = await stat(`${node.dir}/${zone}`).then(
      () => true,
      () => false,
    )
    if (!exists)
      failures.push(
        `tools/graph.ts gives ${node.dir}/${zone} its own zone, but that path does not exist. Update or remove the entry.`,
      )
  }
  const deps = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })
  const workspaceDeps = deps.filter((dep) => dep.startsWith('@goblin/'))
  for (const edge of node.mayImport) {
    if (!workspaceDeps.includes(edge)) {
      failures.push(
        `${node.dir} may import ${edge} (tools/graph.ts), but ${node.dir}/package.json does not depend on it. ${edit}`,
      )
    }
  }
  for (const dep of workspaceDeps) {
    if (!node.mayImport.includes(dep)) {
      failures.push(
        `${node.dir}/package.json depends on ${dep}, but its mayImport in tools/graph.ts does not list it. ${edit}`,
      )
    }
  }
}

const byName = new Map(nodes.map((node) => [node.name, node]))
const reachable = new Set<string>()
const visit = (name: string): void => {
  const node = byName.get(name)
  if (node === undefined || reachable.has(node.dir)) return
  reachable.add(node.dir)
  for (const edge of node.mayImport) visit(edge)
}
for (const node of nodes) {
  if (node.dir.startsWith('apps/')) visit(node.name)
}

for (const node of nodes) {
  const isReachable = reachable.has(node.dir)
  if (!isReachable && node.seam === undefined) {
    failures.push(
      `${node.dir} is not reachable from any app and declares no seam. Wire it into an app, delete it, or declare seam: { consumer, reason } in tools/graph.ts.`,
    )
  }
  if (isReachable && node.seam !== undefined) {
    failures.push(
      `${node.dir} is reachable from an app but still declares a seam ("${node.seam.reason}"). Remove the seam.`,
    )
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(failure)
  process.exitCode = 1
} else {
  console.info(`Graph check passed (${nodes.length} workspaces, ${reachable.size} reachable from an app)`)
}
