/**
 * Patched dependencies (root package.json `patchedDependencies`) and the proof that each patch is installed. bun skips
 * a patch without failing when its `name@version` key stops matching the installed version (oven-sh/bun#40110), and a
 * warm cache can skip one on CI (oven-sh/bun#33520); nothing else would notice, because the app would simply run the
 * unpatched code. So every patch is built to put a marker line at the top of the file it replaces, carrying the hash of
 * the source diff it was built from, and `bun run check:patches` looks for exactly that line in the installed file.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { Schema } from 'effect'

export interface PatchSpec {
  /** The `patchedDependencies` key: `name@version`. */
  readonly key: string
  /** The patched module, as a workspace that depends on it imports it. */
  readonly entry: string
  /** That workspace's source directory, which `entry` resolves from. */
  readonly from: string
  /** The source diff the patch is built from (scripts/patch-shadcn-react.ts); its hash is in the marker. */
  readonly source: string
}

export const PATCHES: readonly PatchSpec[] = [
  {
    key: '@shadcn/react@0.3.1',
    entry: '@shadcn/react/message-scroller',
    from: 'packages/ui/src',
    source: 'patches/shadcn-react/message-scroller.diff',
  },
]

/** The marker line the patched file starts with (after its "use client" directive). */
export const markerOf = (spec: PatchSpec, source: Uint8Array): string => {
  const at = spec.key.lastIndexOf('@')
  const hash = createHash('sha256').update(source).digest('hex').slice(0, 12)
  return `// ${spec.key.slice(0, at)} ${spec.key.slice(at + 1)} + goblin ${path.dirname(spec.source)} ${hash}`
}

export interface Installed {
  readonly version: string
  readonly head: string
}

/** What is wrong with one installed patch: the version it was made for, then the marker in its first lines. */
export function checkPatch(spec: PatchSpec, installed: Installed | undefined, source: Uint8Array): string[] {
  if (installed === undefined) return [`${spec.key}: ${spec.entry} does not resolve from ${spec.from}`]
  const version = spec.key.slice(spec.key.lastIndexOf('@') + 1)
  if (installed.version !== version)
    return [`${spec.key}: ${installed.version} is installed, so bun skips the patch; regenerate it for that version`]
  const marker = markerOf(spec, source)
  if (!installed.head.split('\n').slice(0, 3).includes(marker))
    return [`${spec.key}: the installed ${spec.entry} lacks "${marker}"; run bun install, or regenerate the patch`]
  return []
}

const Manifest = Schema.Struct({ patchedDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)) })
const PackageJson = Schema.Struct({ name: Schema.String, version: Schema.String })

/** The installed package's version and the first bytes of the patched module, if it resolves. */
function installedOf(root: string, spec: PatchSpec): Installed | undefined {
  let file: string
  try {
    file = Bun.resolveSync(spec.entry, path.join(root, spec.from))
  } catch {
    // expected: an entry that does not resolve is reported by checkPatch as "does not resolve"
    return undefined
  }
  const name = spec.key.slice(0, spec.key.lastIndexOf('@'))
  for (let dir = path.dirname(file); dir !== path.dirname(dir); dir = path.dirname(dir)) {
    const manifest = path.join(dir, 'package.json')
    if (!existsSync(manifest)) continue
    const pkg = Schema.decodeUnknownSync(PackageJson)(JSON.parse(readFileSync(manifest, 'utf8')))
    if (pkg.name === name) return { version: pkg.version, head: readFileSync(file, 'utf8').slice(0, 512) }
  }
  return undefined
}

/** Every patched dependency has a spec here and is installed with its patch. */
export function checkPatches(root: string): string[] {
  const keys = Object.keys(
    Schema.decodeUnknownSync(Manifest)(JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')))
      .patchedDependencies ?? {},
  )
  const unchecked = keys
    .filter((key) => !PATCHES.some((spec) => spec.key === key))
    .map((key) => `${key}: patched in package.json but has no PatchSpec in tools/patches.ts`)
  const unpatched = PATCHES.filter((spec) => !keys.includes(spec.key)).map(
    (spec) => `${spec.key}: tools/patches.ts checks it but package.json does not patch it`,
  )
  const installed = PATCHES.filter((spec) => keys.includes(spec.key)).flatMap((spec) =>
    checkPatch(spec, installedOf(root, spec), readFileSync(path.join(root, spec.source))),
  )
  return [...unchecked, ...unpatched, ...installed]
}
