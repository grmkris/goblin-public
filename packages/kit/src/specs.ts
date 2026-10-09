import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'

/**
 * What a ```chart or ```map block says, as JSON. Blocks come from model output, so each spec is bounded and checked;
 * one that does not parse is shown as the code it is.
 */

const MAX_SPEC = 200_000

const Label = Schema.String.check(Schema.isMaxLength(120))
const Key = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64))
const Cell = Schema.Union([Schema.String.check(Schema.isMaxLength(200)), Schema.Finite, Schema.Null])

/** A line, bar, area or pie chart: `x` names each row's category, each series a numeric column (at most five). */
export const ChartSpec = Schema.Struct({
  type: Schema.Literals(['line', 'bar', 'area', 'pie']),
  title: Schema.optional(Label),
  x: Key,
  series: Schema.Array(Schema.Struct({ key: Key, label: Schema.optional(Label) })).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(5),
  ),
  data: Schema.Array(Schema.Record(Schema.String, Cell)).check(Schema.isMinLength(1), Schema.isMaxLength(500)),
  stacked: Schema.optional(Schema.Boolean),
  unit: Schema.optional(Schema.String.check(Schema.isMaxLength(16))),
})
export type ChartSpec = typeof ChartSpec.Type

const Latitude = Schema.Finite.check(Schema.isBetween({ minimum: -90, maximum: 90 }))
const Longitude = Schema.Finite.check(Schema.isBetween({ minimum: -180, maximum: 180 }))
const Point = Schema.Tuple([Latitude, Longitude])

/** A map: markers and lines in latitude/longitude, or just a place to show; it fits whatever it holds. */
export const MapSpec = Schema.Struct({
  title: Schema.optional(Label),
  center: Schema.optional(Point),
  zoom: Schema.optional(Schema.Finite.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 18 }))),
  markers: Schema.optional(
    Schema.Array(Schema.Struct({ lat: Latitude, lng: Longitude, label: Schema.optional(Label) })).check(
      Schema.isMaxLength(200),
    ),
  ),
  lines: Schema.optional(
    Schema.Array(
      Schema.Struct({
        points: Schema.Array(Point).check(Schema.isMinLength(2), Schema.isMaxLength(1000)),
        label: Schema.optional(Label),
      }),
    ).check(Schema.isMaxLength(20)),
  ),
}).check(
  Schema.makeFilter((spec) =>
    spec.center !== undefined || (spec.markers?.length ?? 0) > 0 || (spec.lines?.length ?? 0) > 0
      ? undefined
      : 'a map shows a center, a marker or a line',
  ),
)
export type MapSpec = typeof MapSpec.Type

function parser<A>(schema: Schema.Decoder<A>): (text: string) => A | undefined {
  const decode = Schema.decodeUnknownOption(schema)
  return (text) => {
    if (text.length > MAX_SPEC) return undefined
    let value: unknown
    try {
      value = JSON.parse(text)
    } catch {
      // expected: a block that is not JSON is not a spec, and shows as code
      return undefined
    }
    return Option.getOrUndefined(decode(value))
  }
}

/** A ```chart block's spec, or nothing when it is not one. */
export const chartSpec = parser(ChartSpec)

/** A ```map block's spec, or nothing when it is not one. */
export const mapSpec = parser(MapSpec)

/** Every point a map shows, for fitting it into view. */
export function mapPoints(spec: MapSpec): ReadonlyArray<readonly [number, number]> {
  return [
    ...(spec.center === undefined ? [] : [spec.center]),
    ...(spec.markers ?? []).map((marker) => [marker.lat, marker.lng] as const),
    ...(spec.lines ?? []).flatMap((line) => line.points),
  ]
}
