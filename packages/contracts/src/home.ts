import * as Schema from 'effect/Schema'
import { AppId, NonEmptyString, OperationId } from './ids.ts'

/** Home has ordered, fixed-size tiles; columns are a property of the screen. */
export const TileSize = Schema.Literals(['small', 'medium', 'large', 'wide'])
export type TileSize = typeof TileSize.Type
const Id = NonEmptyString(100)
const Base = { id: Id, size: TileSize }
const Note = {
  title: Schema.String.check(Schema.isMaxLength(60)),
  markdown: Schema.String.check(Schema.makeFilter((value) => new TextEncoder().encode(value).length <= 4096)),
}
const variants = <F extends Schema.Struct.Fields>(fields: F) =>
  Schema.Union([
    Schema.Struct({
      ...fields,
      kind: Schema.Literal('app'),
      appId: AppId,
    }),
    Schema.Struct({ ...fields, kind: Schema.Literal('conversations') }),
    Schema.Struct({ ...fields, kind: Schema.Literal('note'), ...Note }),
  ])

export const HomeTileInput = variants(Base)
export type HomeTileInput = typeof HomeTileInput.Type
export const HomeTile = variants({ ...Base, placedBy: Schema.Literals(['owner', 'agent']) })
export type HomeTile = typeof HomeTile.Type
export const HomeLayout = Schema.Struct({
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  tiles: Schema.Array(HomeTile).check(
    Schema.isMaxLength(24),
    Schema.makeFilter((tiles) => tiles.filter((tile) => tile.kind === 'app').length <= 8),
    Schema.makeFilter((tiles) => new Set(tiles.map((tile) => tile.id)).size === tiles.length),
    Schema.makeFilter((tiles) => {
      const apps = tiles.flatMap((tile) => (tile.kind === 'app' ? [tile.appId] : []))
      return new Set(apps).size === apps.length
    }),
  ),
})
export type HomeLayout = typeof HomeLayout.Type
export const EMPTY_HOME: HomeLayout = { revision: 0, tiles: [] }
const Index = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(24))
export const HomeOperation = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('add'), tile: HomeTileInput, index: Schema.optional(Index) }),
  Schema.Struct({ kind: Schema.Literal('move'), id: Id, index: Index }),
  Schema.Struct({ kind: Schema.Literal('resize'), id: Id, size: TileSize }),
  Schema.Struct({ kind: Schema.Literal('update'), id: Id, ...Note }),
  Schema.Struct({ kind: Schema.Literal('remove'), id: Id }),
])
export type HomeOperation = typeof HomeOperation.Type
export const HomeEdit = Schema.Struct({
  operationId: OperationId,
  expectedRevision: HomeLayout.fields.revision,
  ops: Schema.Array(HomeOperation).check(Schema.isMaxLength(72)),
  /** Owner-only Undo of a stored edit. It refuses if another edit has landed since that receipt. */
  undoOf: Schema.optional(OperationId),
})
export type HomeEdit = typeof HomeEdit.Type
export const HomeEditResult = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal('applied'),
    operationId: Schema.String,
    layout: HomeLayout,
    tileIds: Schema.Array(Id),
    message: Schema.String,
  }),
  Schema.Struct({ kind: Schema.Literal('stale'), layout: HomeLayout }),
  Schema.Struct({ kind: Schema.Literal('owner-required'), layout: HomeLayout, tileIds: Schema.Array(Id) }),
])
export type HomeEditResult = typeof HomeEditResult.Type
/**
 * An owner's edit made against an older layout, as the owner API answers it: refused with the layout as it is now, so
 * the client can redo the edit there. Its body is the `stale` result, `{ kind: 'stale', layout }`.
 */
export class HomeStale extends Schema.Error<HomeStale>('HomeStale')(HomeEditResult.members[1].fields) {}
export const HomeRead = Schema.Struct({
  layout: HomeLayout,
  apps: Schema.Array(Schema.Struct({ name: Schema.String, id: Schema.NullOr(Schema.String), hasView: Schema.Boolean })),
})
export type HomeRead = typeof HomeRead.Type
