/**
 * `bun run lint:report`: every finding of the lint gates, counted per rule and per workspace (tools/graph.ts).
 *
 *   bun run lint:report                          Markdown tables for the whole repository
 *   bun run lint:report --json                   the same as JSON
 *   bun run lint:report --files a.ts b.ts         only findings in these files
 *   bun run lint:report --config /tmp/x.ts       measure a candidate oxlint config before enabling it
 *   bun run lint:report --only oxlint            one gate only (`oxlint`, `effect` or `knip`); the default is all
 *
 * Use it before and after a change: a change must not add findings. The whole-repository lint is type-aware, and
 * effect:check type-checks every project once more; both run through `heavy` when it is installed. The Effect
 * findings are what effect:check gates: errors, warnings and directives that change nothing.
 * The collectors are in tools/findings.ts, shared with `bun run lint:gate`. When a tool did not run, or an Effect
 * project left files unchecked, the report is printed and the command exits 1.
 */
import path from 'node:path'
import { collect, OXLINT_CONFIG, SOURCES } from './findings.ts'
import { aggregate, renderJson, renderMarkdown, workspaceOf } from './report.ts'
import type { Source } from './report.ts'
import { repoRoot } from './run.ts'

const isSource = (value: string): value is Source => SOURCES.some((source) => source === value)

interface Options {
  readonly config: string
  readonly sources: readonly Source[]
  readonly json: boolean
  readonly workspaces: readonly string[]
  readonly files: readonly string[]
}

const usage =
  'usage: bun run lint:report [--json] [--only oxlint|effect|knip] [--config <file>] [--workspace <dir>]... [--files <path>...]'

const parseArgs = (argv: readonly string[]): Options => {
  let json = false
  let config = OXLINT_CONFIG
  let sources = SOURCES
  const workspaces: string[] = []
  const files: string[] = []
  let collecting: 'files' | undefined
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? ''
    if (arg === '--json') json = true
    else if (arg === '--config') config = path.resolve(argv[++i] ?? '')
    else if (arg === '--only') sources = [onlySource(argv[++i] ?? '')]
    else if (arg === '--workspace') workspaces.push((argv[++i] ?? '').replace(/\/$/u, ''))
    else if (arg === '--files') collecting = 'files'
    else if (collecting === 'files' && !arg.startsWith('--')) files.push(arg)
    else throw new Error(`unknown argument ${arg}\n${usage}`)
  }
  const relative = files.map((file) => path.relative(repoRoot, path.resolve(file)).split(path.sep).join('/'))
  return { config, sources, json, workspaces, files: relative }
}

const onlySource = (value: string): Source => {
  if (isSource(value)) return value
  throw new Error(`--only takes ${SOURCES.join(' or ')}, not ${value}\n${usage}`)
}

const options = parseArgs(Bun.argv.slice(2))
const collected = await collect(options.sources, options.config)
const findings = collected.findings.filter(
  (finding) =>
    (options.workspaces.length === 0 || options.workspaces.includes(workspaceOf(finding.file))) &&
    (options.files.length === 0 || options.files.includes(finding.file)),
)
const report = aggregate(findings, options.sources)
process.stdout.write(options.json ? renderJson(report) : renderMarkdown(report))
for (const failure of collected.failures) console.error(failure)
if (collected.failures.length > 0) process.exitCode = 1
