/**
 * The pure half of `bun run effect:check`: which tsconfigs each workspace checks, and the tsconfig reading the checks
 * need. tools/effect-check.ts runs `effect-tsgo diagnostics` on them; tools/report.ts turns its output into findings.
 * Node APIs only: Vitest runs under Node.
 */
import { Schema } from 'effect'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { parseSync } from 'oxc-parser'
import { nodes } from './graph.ts'
import { UNUSED_DIRECTIVE } from './report.ts'
import type { EffectOutput } from './report.ts'
import { repoRoot } from './run.ts'

/** The plugin name `@effect/tsgo` reads its options under, in `compilerOptions.plugins`. */
export const PLUGIN = '@effect/language-service'

/** The effect-tsgo binary, a dependency of this workspace. */
export const effectTsgo = path.join(import.meta.dirname, 'node_modules/.bin/effect-tsgo')

/** The command that prints one project's diagnostics as JSON (`decodeEffect` in report.ts reads it). */
export const effectTsgoArgs = (tsconfig: string): string[] => [
  effectTsgo,
  'diagnostics',
  '--project',
  path.resolve(repoRoot, tsconfig),
  '--format',
  'json',
]

/** Workspaces without `effect:check`: vendored code the gates do not cover. */
export const OUT_OF_SCOPE = new Set<string>()

/** Tsconfigs a `typecheck` script checks: each `tsc -p <file>`, or `tsconfig.json` for a bare `tsc`. */
export const typecheckProjects = (script: string): string[] =>
  script
    .split('&&')
    .map((command) => command.trim().split(/\s+/u))
    .filter((words) => words[0] === 'tsc')
    .map((words) => {
      const flag = words.indexOf('-p')
      return flag === -1 ? 'tsconfig.json' : (words[flag + 1] ?? 'tsconfig.json')
    })

/** Tsconfigs an `effect:check` script checks: the arguments of `effect-check.ts`. */
export const effectCheckProjects = (script: string): string[] => {
  const command = script.split('&&').find((part) => part.includes('effect-check.ts')) ?? ''
  const words = command.trim().split(/\s+/u)
  return words.slice(words.findIndex((word) => word.endsWith('effect-check.ts')) + 1)
}

export interface Project {
  /** Workspace directory, repository-relative; `.` for the root tsconfig. */
  readonly dir: string
  readonly tsconfig: string
}

const Manifest = Schema.Struct({ scripts: Schema.optional(Schema.Record(Schema.String, Schema.String)) })
const decodeManifest = Schema.decodeUnknownSync(Manifest)

const scriptsOf = (dir: string): Readonly<Record<string, string>> =>
  decodeManifest(JSON.parse(readFileSync(path.join(repoRoot, dir, 'package.json'), 'utf8'))).scripts ?? {}

/** Every workspace's `typecheck` and `effect:check` scripts (absent ones as undefined). */
export const workspaceScripts = (): Array<{
  readonly dir: string
  readonly typecheck: string | undefined
  readonly effectCheck: string | undefined
}> =>
  nodes.map((node) => {
    const scripts = scriptsOf(node.dir)
    return { dir: node.dir, typecheck: scripts['typecheck'], effectCheck: scripts['effect:check'] }
  })

/** Every project `bun run effect:check` checks: the root tsconfig, then each workspace's `effect:check` tsconfigs. */
export const effectProjects = (): Project[] => {
  const projects: Project[] = [{ dir: '.', tsconfig: 'tsconfig.json' }]
  for (const { dir, typecheck, effectCheck } of workspaceScripts()) {
    if (typecheck === undefined || effectCheck === undefined) {
      throw new Error(`${dir}: both typecheck and effect:check scripts are required`)
    }
    const typed = typecheckProjects(typecheck)
    const checked = effectCheckProjects(effectCheck)
    if (typed.length === 0 || checked.length === 0 || JSON.stringify(typed) !== JSON.stringify(checked)) {
      throw new Error(`${dir}: typecheck and effect:check must name the same supported projects`)
    }
    projects.push(...checked.map((tsconfig) => ({ dir, tsconfig })))
  }
  return projects
}

/** JSON with comments and trailing commas, as tsconfig files allow, reduced to plain JSON. */
export const stripJsonc = (text: string): string => {
  let out = ''
  let i = 0
  while (i < text.length) {
    const char = text[i] ?? ''
    if (char === '"') {
      const end = endOfString(text, i)
      out += text.slice(i, end)
      i = end
    } else if (text.startsWith('//', i)) {
      i = text.indexOf('\n', i) === -1 ? text.length : text.indexOf('\n', i)
    } else if (text.startsWith('/*', i)) {
      i = text.indexOf('*/', i) === -1 ? text.length : text.indexOf('*/', i) + 2
    } else {
      out += char
      i++
    }
  }
  return out.replace(/,(\s*[}\]])/gu, '$1')
}

/** The index just past the string literal that starts at `start`. */
const endOfString = (text: string, start: number): number => {
  let i = start + 1
  while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1
  return i + 1
}

type PluginEntry = Readonly<Record<string, unknown>>
const Tsconfig = Schema.Struct({
  compilerOptions: Schema.optional(
    Schema.Struct({ plugins: Schema.optional(Schema.Array(Schema.Record(Schema.String, Schema.Unknown))) }),
  ),
})
const decodeTsconfig = Schema.decodeUnknownSync(Tsconfig)

/** The `@effect/language-service` entry of a tsconfig's own `compilerOptions.plugins` (not inherited), if any. */
export const pluginBlock = (tsconfig: string): PluginEntry | undefined =>
  decodeTsconfig(
    JSON.parse(stripJsonc(readFileSync(path.join(repoRoot, tsconfig), 'utf8'))),
  ).compilerOptions?.plugins?.find((plugin) => plugin['name'] === PLUGIN)

/**
 * The Effect diagnostics about global APIs (Date, fetch, timers, console, randomness, UUIDs, the environment, Node
 * builtins). A copied plugin block may turn these off for its whole runtime; every other diagnostic must match the base.
 */
export const GLOBAL_API_DIAGNOSTICS: ReadonlySet<string> = new Set([
  'globalFetch',
  'globalFetchInEffect',
  'globalDate',
  'globalDateInEffect',
  'globalConsole',
  'globalConsoleInEffect',
  'globalTimers',
  'globalTimersInEffect',
  'globalRandom',
  'globalRandomInEffect',
  'cryptoRandomUUID',
  'cryptoRandomUUIDInEffect',
  'processEnv',
  'processEnvInEffect',
  'nodeBuiltinImport',
])

const decodeSeverities = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.String))

/** A plugin block's `diagnosticSeverity` map. */
export const severities = (block: PluginEntry | undefined): Readonly<Record<string, string>> =>
  decodeSeverities(block?.['diagnosticSeverity'])

/**
 * effect-tsgo also reads directive-shaped text inside strings (a lint rule's test cases), and reports it as a directive
 * that changes nothing. Only a directive inside a real comment is kept. Ported from myapps (`grmkris/myapps`
 * `27416c98`, `tools/effect.ts`). A source that cannot be read or parsed throws: the gate fails instead of guessing.
 */
export const verifiedEffectOutput = (
  output: EffectOutput,
  readSource: (file: string) => string = (file) => readFileSync(file, 'utf8'),
): EffectOutput => {
  const spans = new Map<string, { source: string; comments: readonly { start: number; end: number }[] }>()
  return {
    ...output,
    diagnostics: output.diagnostics.filter((diagnostic) => {
      if (diagnostic.code !== UNUSED_DIRECTIVE) return true
      let parsed = spans.get(diagnostic.file)
      if (parsed === undefined) {
        const source = readSource(diagnostic.file)
        const result = parseSync(diagnostic.file, source)
        if (result.errors.length > 0)
          throw new Error(`Effect directive check cannot parse ${diagnostic.file}: ${result.errors[0]?.message}`)
        parsed = { source, comments: result.comments }
        spans.set(diagnostic.file, parsed)
      }
      const lines = parsed.source.split('\n')
      const offset =
        lines.slice(0, diagnostic.line - 1).reduce((sum, line) => sum + line.length + 1, 0) + diagnostic.column - 1
      return parsed.comments.some((comment) => comment.start <= offset && offset < comment.end)
    }),
  }
}
