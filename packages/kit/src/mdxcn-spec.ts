import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'

const Label = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120))
const Note = Schema.String.check(Schema.isMaxLength(240))
const CheckFields = { label: Label, done: Schema.optional(Schema.Boolean), note: Schema.optional(Note) }
const CheckLeaf = Schema.Struct(CheckFields)
const CheckBranch = Schema.Struct({
  ...CheckFields,
  items: Schema.optional(Schema.Array(CheckLeaf).check(Schema.isMaxLength(20))),
})
const CheckItem = Schema.Struct({
  ...CheckFields,
  items: Schema.optional(Schema.Array(CheckBranch).check(Schema.isMaxLength(20))),
})

/** At most three levels and 64 checks in all; there is no unbounded recursive decoder. */
export const CheckSpec = Schema.Struct({
  kind: Schema.Literal('check'),
  title: Label,
  items: Schema.Array(CheckItem).check(Schema.isMinLength(1), Schema.isMaxLength(20)),
}).check(
  Schema.makeFilter((spec) => {
    const count = spec.items.reduce(
      (total, item) => total + 1 + (item.items ?? []).reduce((sum, child) => sum + 1 + (child.items?.length ?? 0), 0),
      0,
    )
    return count <= 64 ? undefined : 'at most 64 checks in all'
  }),
)
export type CheckSpec = typeof CheckSpec.Type

export const TimelineSpec = Schema.Struct({
  kind: Schema.Literal('timeline'),
  title: Label,
  events: Schema.Array(
    Schema.Struct({
      date: Label,
      label: Label,
      state: Schema.optional(Schema.Literals(['done', 'now', 'next'])),
      note: Schema.optional(Note),
    }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(32)),
})
export type TimelineSpec = typeof TimelineSpec.Type

export const CompareSpec = Schema.Struct({
  kind: Schema.Literal('compare'),
  title: Label,
  columns: Schema.Array(Label).check(Schema.isMinLength(2), Schema.isMaxLength(4)),
  rows: Schema.Array(
    Schema.Struct({
      label: Label,
      values: Schema.Array(Schema.Union([Note, Schema.Boolean, Schema.Finite])).check(Schema.isMaxLength(4)),
    }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(24)),
}).check(
  Schema.makeFilter((spec) =>
    new Set(spec.columns).size === spec.columns.length &&
    spec.rows.every((row) => row.values.length === spec.columns.length)
      ? undefined
      : 'distinct columns and one value per column',
  ),
)
export type CompareSpec = typeof CompareSpec.Type

export const StatSpec = Schema.Struct({
  kind: Schema.Literal('stat'),
  title: Label,
  items: Schema.Array(
    Schema.Struct({
      label: Label,
      value: Schema.Union([Schema.String.check(Schema.isMaxLength(64)), Schema.Finite]),
      hint: Schema.optional(Note),
      accent: Schema.optional(Schema.Boolean),
    }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(8)),
})
export type StatSpec = typeof StatSpec.Type

export const SparkSpec = Schema.Struct({
  kind: Schema.Literal('spark'),
  title: Label,
  data: Schema.Array(Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1e12 }))).check(
    Schema.isMinLength(2),
    Schema.isMaxLength(64),
  ),
  caption: Schema.optional(Note),
})
export type SparkSpec = typeof SparkSpec.Type

/** The curated mdxcn data grammar. Model output supplies text and numbers, never HTML, JSX or instructions. */
export const MdxcnSpec = Schema.Union([TimelineSpec, CheckSpec, CompareSpec, StatSpec, SparkSpec])
export type MdxcnSpec = typeof MdxcnSpec.Type

const decode = Schema.decodeUnknownOption(MdxcnSpec, { onExcessProperty: 'error' })

/** A bounded JSON figure, or nothing so its original fence remains readable code. */
export function mdxcnSpec(source: string): MdxcnSpec | undefined {
  if (source.length > 32_768) return undefined
  try {
    return Option.getOrUndefined(decode(JSON.parse(source)))
  } catch {
    return undefined
  }
}
