/**
 * Vendored agent skills live in `.agents/skills`, pinned in `.agents/skills/sources.json` (v2). repoagents
 * owns that file and verifies it (`bunx repoagents check`, part of `agents:check`); this module only
 * reads the skill names, so oxfmt.config.ts and oxlint.config.ts skip the vendored copies.
 */
import { Schema } from 'effect'
import { existsSync, readFileSync } from 'node:fs'

export const sourcesFile = new URL('../.agents/skills/sources.json', import.meta.url)

/** The part of sources.json this repo reads: which skills are vendored. */
export const SourcesNames = Schema.Struct({ skills: Schema.Record(Schema.String, Schema.Unknown) })

/** Names of the vendored skills (keys of sources.json `skills`). */
export const vendoredSkillNames = (): string[] =>
  existsSync(sourcesFile)
    ? Object.keys(Schema.decodeUnknownSync(SourcesNames)(JSON.parse(readFileSync(sourcesFile, 'utf8'))).skills)
    : []

/** What oxfmt and oxlint must not touch: vendored skills in upstream style, harness link and state directories. */
export const agentIgnorePatterns = (): string[] => [
  ...vendoredSkillNames().map((name) => `.agents/skills/${name}/**`),
  // written by repoagents in its own JSON style
  '.agents/skills/sources.json',
  '.claude/skills/**',
  '.codex/**',
  '.grok/**',
  // generated from .mcp.json
  '.cursor/mcp.json',
]
