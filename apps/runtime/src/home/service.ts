import {
  HomeEdit,
  HomeEditResult,
  HomeLayout,
  type HomeRead,
  type HomeTile,
  type HomeOperation,
} from '@goblin/contracts'
import { eq } from 'drizzle-orm'
import type { SQLiteAsyncDatabase } from 'drizzle-orm/sqlite-core/async/db'
import * as Schema from 'effect/Schema'
import type { AppRegistry } from '../apps/registry.ts'
import type { AgentApps } from '../agent-apps/engine.ts'
import { Conflict, Forbidden, InvalidInput, NotFound } from '../http/errors.ts'
import { appHomeOperations } from '../storage/schema.ts'
import { applyHomeOperations, ownerTargets, touchedTiles } from './operations.ts'
import { readHome, writeHome } from './store.ts'

type Actor = HomeTile['placedBy']
/** Owner-scoped application metadata. No network or Pi calls occur in a layout transaction. */
export class HomeService<RunResult = unknown> {
  readonly #listeners = new Set<(layout: HomeLayout) => void>()
  readonly #db: SQLiteAsyncDatabase<'sync', RunResult>
  constructor(
    db: SQLiteAsyncDatabase<'sync', RunResult>,
    readonly apps: AppRegistry,
    readonly engine: AgentApps,
  ) {
    this.#db = db
  }
  layout(): HomeLayout {
    return readHome(this.#db)
  }
  read(): HomeRead {
    return {
      layout: this.layout(),
      apps: this.engine.store.apps().map((app) => ({
        name: app.name,
        id: this.apps.agentId(app.name),
        hasView: this.engine.info(app.name)?.ui ?? false,
      })),
    }
  }
  onChange(listener: (layout: HomeLayout) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }
  /** App deletion already changed the layout in its transaction; announce the committed result. */
  appRemoved(): void {
    this.#announce(this.layout())
  }
  /** Replays and stale intent need no network pre-check. The transaction repeats both guards before writing. */
  needsAppVerification(input: HomeEdit, actor: Actor): boolean {
    const row = this.#db
      .select()
      .from(appHomeOperations)
      .where(eq(appHomeOperations.operationId, input.operationId))
      .get()
    if (row !== undefined && row.actor !== actor) throw new Conflict({ reason: 'operation belongs to another actor' })
    return row === undefined && this.layout().revision === input.expectedRevision && input.undoOf === undefined
  }
  edit(input: HomeEdit, actor: Actor): HomeEditResult {
    const valid = Schema.decodeUnknownSync(HomeEdit)(input)
    const result = this.#db.transaction((tx) => {
      const replay = tx
        .select()
        .from(appHomeOperations)
        .where(eq(appHomeOperations.operationId, valid.operationId))
        .get()
      if (replay !== undefined) {
        if (replay.actor !== actor) throw new Conflict({ reason: 'operation belongs to another actor' })
        return Schema.decodeUnknownSync(HomeEditResult)(JSON.parse(replay.result))
      }
      const before = readHome(tx)
      if (before.revision !== valid.expectedRevision) return { kind: 'stale' as const, layout: before }
      const owned = actor === 'agent' ? ownerTargets(before, valid.ops) : []
      if (owned.length > 0) return { kind: 'owner-required' as const, layout: before, tileIds: owned }
      const layout =
        valid.undoOf === undefined ? applyHomeOperations(before, valid.ops, actor) : this.#undo(valid, before, actor)
      this.#validateApps(layout, valid, actor)
      const receipt: HomeEditResult = {
        kind: 'applied',
        operationId: valid.operationId,
        layout,
        tileIds: touchedTiles(valid.ops),
        message: this.#message(valid, layout),
      }
      writeHome(tx, layout)
      tx.insert(appHomeOperations)
        .values({
          operationId: valid.operationId,
          actor,
          result: JSON.stringify(receipt),
          before: JSON.stringify(before),
        })
        .run()
      return receipt
    })
    if (result.kind === 'applied') this.#announce(this.layout())
    return result
  }
  #undo(input: HomeEdit, current: HomeLayout, actor: Actor): HomeLayout {
    if (actor !== 'owner') throw new Forbidden({ reason: 'only the owner can Undo a receipt' })
    const row = this.#db
      .select()
      .from(appHomeOperations)
      .where(eq(appHomeOperations.operationId, input.undoOf ?? ''))
      .get()
    if (row === undefined) throw new NotFound({ what: 'home receipt' })
    const result = Schema.decodeUnknownSync(HomeEditResult)(JSON.parse(row.result))
    if (result.kind !== 'applied' || result.layout.revision !== current.revision)
      throw new Conflict({ reason: 'Home changed after this edit; Undo cannot overwrite a later edit' })
    return { revision: current.revision + 1, tiles: Schema.decodeUnknownSync(HomeLayout)(JSON.parse(row.before)).tiles }
  }
  #validateAdd(op: HomeOperation, actor: Actor): void {
    if (op.kind !== 'add' || op.tile.kind !== 'app') return
    const placement = this.apps.placement(op.tile.appId)
    if (placement.source !== 'mcp') return
    if (actor !== 'owner') throw new InvalidInput({ reason: 'Only the owner pins MCP Apps on Home' })
    if (placement.closed) throw new InvalidInput({ reason: 'Open the MCP App before putting it on Home' })
  }
  #validateApps(layout: HomeLayout, input: HomeEdit, actor: Actor): void {
    for (const op of input.ops) this.#validateAdd(op, actor)
    const agentViews = new Set(
      this.read()
        .apps.filter((app) => app.hasView && app.id !== null)
        .map((app) => app.id),
    )
    for (const tile of layout.tiles) {
      if (tile.kind !== 'app') continue
      const placement = this.apps.placement(tile.appId)
      if (placement.source === 'agent' && !agentViews.has(tile.appId))
        throw new InvalidInput({ reason: 'Home needs an existing agent app with a view' })
    }
  }
  #message(input: HomeEdit, layout: HomeLayout): string {
    if (input.undoOf !== undefined) return 'Undid the Home edit'
    const additions = input.ops.filter((op) => op.kind === 'add')
    if (additions.length === 1) {
      const tile = layout.tiles.find((candidate) => candidate.id === additions[0]?.tile.id)
      const title =
        tile?.kind === 'app'
          ? this.apps.placement(tile.appId).title
          : tile?.kind === 'note'
            ? tile.title
            : 'Recent conversations'
      return `Placed ${title ?? 'a tile'} on Home`
    }
    return 'Updated Home'
  }
  #announce(layout: HomeLayout): void {
    for (const listener of this.#listeners) listener(layout)
  }
}
