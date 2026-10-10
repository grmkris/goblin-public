// The MCP Skills extension (`io.modelcontextprotocol/skills`, SEP-2640) as goblin reads it: `skills/list` and
// `skills/get` results, decoded strictly. The official TypeScript SDK has no Skills support yet (PR #2818), so these
// schemas follow the published specification, not the SDK. Every field is the serving server's claim.
import * as Schema from 'effect/Schema'

export const SKILLS_EXTENSION = 'io.modelcontextprotocol/skills'

/** The spec's per-skill bound that hosts must support: 512 files, 16 MiB. */
export const MAX_SKILL_FILES = 512
export const MAX_SKILL_BYTES = 16 * 1024 * 1024

const Uri = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2048))

/** One file of a skill's manifest: its URI, `sha256:<hex>` digest and byte size. */
export const ManifestFile = Schema.Struct({
  uri: Uri,
  digest: Schema.String.check(Schema.isPattern(/^sha256:[0-9a-f]{64}$/u)),
  size: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
})
export type ManifestFile = typeof ManifestFile.Type

/** A skill entry: its `SKILL.md` URI, the frontmatter unchanged, and the complete manifest (or `"dynamic"`). */
export const SkillEntry = Schema.Struct({
  uri: Uri,
  frontmatter: Schema.Record(Schema.String, Schema.Unknown),
  resources: Schema.Union([Schema.Array(ManifestFile), Schema.Literal('dynamic')]),
})
export type SkillEntry = typeof SkillEntry.Type

const Cache = {
  ttlMs: Schema.optional(Schema.Number),
  cacheScope: Schema.optional(Schema.String),
}

export const SkillsListResult = Schema.Struct({
  skills: Schema.Array(SkillEntry),
  nextCursor: Schema.optional(Schema.String),
  ...Cache,
})
export type SkillsListResult = typeof SkillsListResult.Type

/** For `client.request(..., schema)`: the SDK validates custom-method results with any Standard Schema. */
export const skillsListStandard = Schema.toStandardSchemaV1(SkillsListResult)
