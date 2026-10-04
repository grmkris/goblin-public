/** Verify local evidence documentation without turning a recorded gap into a support claim. */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { Schema } from 'effect'
import { checkLinks, listFiles } from './agents.ts'
import { repoRoot } from './run.ts'

const Manifest = Schema.Struct({
  scripts: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  dependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  devDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
})
const manifest = (file: string) => Schema.decodeUnknownSync(Manifest)(JSON.parse(readFileSync(file, 'utf8')))
const required = [
  'docs/architecture.md',
  'docs/development.md',
  'docs/agents/docs-verification.md',
  'docs/stack-compatibility.md',
  'docs/mcp-compatibility.md',
  'docs/implementation.md',
  'GLOSSARY.md',
]
const pins = [
  ['package.json', 'alchemy'],
  ['apps/runtime/package.json', 'agents'],
  ['apps/runtime/package.json', '@earendil-works/pi-durable'],
  ['apps/runtime/package.json', '@earendil-works/pi-ai'],
  ['apps/runtime/package.json', 'effect'],
  ['apps/runtime/package.json', 'drizzle-orm'],
  ['apps/runtime/package.json', 'better-auth'],
  ['apps/runtime/package.json', '@modelcontextprotocol/client'],
  ['apps/web/package.json', '@ag-ui/core'],
  ['apps/web/package.json', '@modelcontextprotocol/ext-apps'],
  ['apps/web/package.json', '@tanstack/react-start'],
] as const

export function verifyEvidenceText(text: string, commands: ReadonlySet<string>): string[] {
  const failures: string[] = []
  for (const match of text.matchAll(/bun run ([a-z][a-z\d:.-]*)/gu)) {
    if (!commands.has(match[1] ?? '')) failures.push(`unknown documented root command: ${match[1]}`)
  }
  return failures
}
export function verifyMcpTable(text: string): string[] {
  const lines = text.split('\n')
  const start = lines.findIndex((line) => line.startsWith('| Feature |'))
  const rest = lines.slice(start)
  const end = rest.findIndex((line) => !line.startsWith('|'))
  const rows = start === -1 ? [] : rest.slice(0, end === -1 ? undefined : end)
  const header = rows[0] ?? ''
  const requiredHeaders = [
    'Feature',
    'Spec revision',
    'SDK',
    'Server identity',
    'Negotiated',
    'Implementation',
    'evidence',
    'Auth',
    'Gap',
  ]
  const failures = requiredHeaders
    .filter((label) => !header.toLowerCase().includes(label.toLowerCase()))
    .map((label) => `MCP table missing column: ${label}`)
  for (const feature of [
    'Streamable HTTP',
    'tools/list',
    'resources',
    'prompts',
    'cancellation',
    'reconnect',
    'MCP Apps',
    'MyPlan real endpoint',
    'MyBrowser real endpoint',
  ]) {
    if (!rows.some((row) => row.includes(feature))) failures.push(`MCP table missing feature: ${feature}`)
  }
  const columns = header.split('|').length
  for (const row of rows.slice(2)) {
    if (row.split('|').length !== columns) failures.push('MCP table has an incomplete feature row')
  }
  return failures
}
export function checkCompatibility(root: string): string[] {
  const failures = required
    .filter((file) => !existsSync(path.join(root, file)))
    .map((file) => `missing documentation: ${file}`)
  if (failures.length > 0) return failures
  const files = listFiles(root).filter(
    (file) =>
      (file.startsWith('docs/') || ['README.md', 'GLOSSARY.md', 'AGENTS.md'].includes(file)) && file.endsWith('.md'),
  )
  failures.push(...checkLinks(root, files))
  const commands = new Set(Object.keys(manifest(path.join(root, 'package.json')).scripts ?? {}))
  for (const file of files)
    failures.push(
      ...verifyEvidenceText(readFileSync(path.join(root, file), 'utf8'), commands).map(
        (failure) => `${file}: ${failure}`,
      ),
    )
  const stack = readFileSync(path.join(root, 'docs/stack-compatibility.md'), 'utf8')
  for (const [file, dependency] of pins) {
    const entry = manifest(path.join(root, file))
    const version = entry.dependencies?.[dependency] ?? entry.devDependencies?.[dependency]
    if (version === undefined || !stack.includes(`\`${dependency}\` | \`${version}\``))
      failures.push(`stack evidence must record exact pin: ${dependency} ${version ?? 'missing'}`)
  }
  failures.push(...verifyMcpTable(readFileSync(path.join(root, 'docs/mcp-compatibility.md'), 'utf8')))
  return failures
}
if (import.meta.main) {
  const failures = checkCompatibility(repoRoot)
  for (const failure of failures) console.error(failure)
  console.info(`compatibility:check: ${failures.length} failures`)
  process.exitCode = failures.length === 0 ? 0 : 1
}
