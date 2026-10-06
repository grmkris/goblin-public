/**
 * Documentation checks run by `bun run agents:check`: relative links in the living docs resolve, and every
 * `bun run <script>` they mention is a root script.
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { Schema } from 'effect'
import { markdownLinks } from './agents.ts'

const Manifest = Schema.Struct({ scripts: Schema.optional(Schema.Record(Schema.String, Schema.String)) })

const AGENT_FACING = /^(?:AGENTS|CLAUDE|GLOSSARY)\.md$|^docs\/(?:agents|adr)\//u

const isLivingDoc = (file: string): boolean =>
  file.endsWith('.md') &&
  !file.startsWith('.agents/') &&
  (file.startsWith('docs/') || !file.includes('/') || /^(?:scripts|tools)\/README\.md$/u.test(file))

/** Root commands a document names with `bun run`; unknown ones are reported. */
export const unknownCommands = (text: string, commands: ReadonlySet<string>): string[] =>
  [...text.matchAll(/bun run ([a-z][a-z\d:.-]*)/gu)]
    .map((match) => match[1] ?? '')
    .filter((command) => !commands.has(command))

export const checkDocs = (root: string, files: readonly string[]): string[] => {
  const manifest = Schema.decodeUnknownSync(Manifest)(JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')))
  const commands = new Set(Object.keys(manifest.scripts ?? {}))
  const failures: string[] = []
  for (const file of files.filter(isLivingDoc)) {
    const text = readFileSync(path.join(root, file), 'utf8')
    for (const command of unknownCommands(text, commands))
      failures.push(`${file} documents \`bun run ${command}\`, which is not a root script.`)
    // agents.ts checkLinks already covers the agent-facing files.
    if (AGENT_FACING.test(file)) continue
    for (const link of markdownLinks(text)) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), link))
      if (!existsSync(path.join(root, target)))
        failures.push(`${file} links ${link}, which does not exist (${target}).`)
    }
  }
  return failures
}
