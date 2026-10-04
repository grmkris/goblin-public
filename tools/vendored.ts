/**
 * Vendored agent skills: the schema of `.agents/skills/sources.json` and the paths the formatter and the linter skip.
 * oxfmt.config.ts and oxlint.config.ts read the skip list from here, so adding a vendored skill to sources.json is
 * enough; `bun run agents:check` verifies the entries themselves.
 */
import { Schema } from 'effect'
import { readFileSync } from 'node:fs'

export const SkillSource = Schema.Struct({
  /** `owner/name` on GitHub, or `local:<path>` for a skill taken from a local installation. */
  repository: Schema.String,
  commit: Schema.optional(Schema.String),
  /** The skill folder inside the source. */
  path: Schema.String,
  /** SHA-256 of the source's SKILL.md. */
  sourceSha256: Schema.String,
  /** Licence files inside our skill folder. */
  licenses: Schema.Array(Schema.String),
  /** Our SKILL.md is byte-identical to the source's, so its hash must equal sourceSha256. */
  unchanged: Schema.Boolean,
  copiedFileHashes: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  reviewedAt: Schema.optional(Schema.String),
  adaptation: Schema.String,
})

export const Sources = Schema.Struct({
  version: Schema.Literal(1),
  reviewedAt: Schema.String,
  skills: Schema.Record(Schema.String, SkillSource),
})

export const sourcesFile = new URL('../.agents/skills/sources.json', import.meta.url)

export const readSources = (): typeof Sources.Type =>
  Schema.decodeUnknownSync(Sources)(JSON.parse(readFileSync(sourcesFile, 'utf8')))

/** What oxfmt and oxlint must not touch: vendored skills in upstream style, harness link and state directories. */
export const agentIgnorePatterns = (): string[] => [
  ...Object.keys(readSources().skills).map((name) => `.agents/skills/${name}/**`),
  '.claude/skills/**',
  '.codex/**',
  '.grok/**',
]
