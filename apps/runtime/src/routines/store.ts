import { and, desc, eq } from 'drizzle-orm'
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite'
import { Conflict, InvalidInput, NotFound } from '../http/errors.ts'
import { RoutineDefinition, RoutineView } from '@purrable/contracts'
import * as Schema from 'effect/Schema'
import { canonicalArguments } from '../mcp/events/store.ts'
import { appRoutineOperations, appRoutines, appRoutineSettings } from '../storage/routines.ts'
import { nextFire, timezoneValid } from './time.ts'

type Db = DrizzleSqliteDODatabase
type Row = typeof appRoutines.$inferSelect
const json = (value: unknown) => JSON.stringify(value)
const decode = (value: string): RoutineDefinition => Schema.decodeUnknownSync(RoutineDefinition)(JSON.parse(value))

const OperationResult = Schema.Struct({ routine: RoutineView, operationId: Schema.String })
export type RoutineOperationResult = typeof OperationResult.Type

function validate(input: RoutineDefinition, at: number): RoutineDefinition {
  const definition = Schema.decodeUnknownSync(RoutineDefinition)(input)
  canonicalArguments(definition.trigger.kind === 'event' ? definition.trigger.arguments : {})
  if (definition.allowedTools.some((tool) => tool.serverId === '' || tool.name === ''))
    throw new InvalidInput({ reason: 'empty tool selector' })
  timezoneValid(definition.timezone)
  if (definition.budget.tokensPerDay < definition.budget.tokensPerRun)
    throw new InvalidInput({ reason: 'daily budget below per-run budget' })
  // nextFire validates cron syntax and explicit one-off offsets without persisting a malformed draft.
  if (definition.trigger.kind !== 'event') nextFire(definition, at - 1)
  return definition
}

export class RoutineStore {
  readonly #db: Db
  readonly #user: string
  constructor(db: Db, user: string) {
    this.#db = db
    this.#user = user
  }

  settings() {
    return (
      this.#db.select().from(appRoutineSettings).where(eq(appRoutineSettings.id, 1)).get() ?? {
        id: 1,
        timezone: 'UTC',
        maxActive: 20,
        maxRunning: 2,
      }
    )
  }

  #view(row: Row): RoutineView {
    return {
      id: row.id,
      revision: row.revision,
      state: row.state,
      definition: decode(row.definitionJson),
      confirmedAt: row.confirmedAt,
      nextFireAt: row.nextFireAt,
      lastFireAt: row.lastFireAt,
      missedCount: row.missedCount,
      suppressedCount: row.suppressedCount,
      health: row.health,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }
  }
  list(includeArchived = false): RoutineView[] {
    const rows = this.#db.select().from(appRoutines).orderBy(desc(appRoutines.updatedAt)).all()
    return rows.filter((row) => includeArchived || row.state !== 'archived').map((row) => this.#view(row))
  }
  get(routineId: string): Row {
    const row = this.#db.select().from(appRoutines).where(eq(appRoutines.id, routineId)).get()
    if (row === undefined || row.proposerUserId !== this.#user) throw new NotFound({ what: 'routine' })
    return row
  }
  #operation(operationId: string, request: unknown): RoutineOperationResult | undefined {
    const row = this.#db
      .select()
      .from(appRoutineOperations)
      .where(eq(appRoutineOperations.operationId, operationId))
      .get()
    if (row === undefined) return undefined
    if (row.requestJson !== json(request)) throw new Conflict({ reason: 'operation id reused with different request' })
    return Schema.decodeUnknownSync(OperationResult)(JSON.parse(row.responseJson))
  }
  #saveOperation(operationId: string, request: unknown, response: unknown, at: number): void {
    this.#db
      .insert(appRoutineOperations)
      .values({ operationId, requestJson: json(request), responseJson: json(response), createdAt: at })
      .onConflictDoNothing()
      .run()
  }
  propose(definition: RoutineDefinition, operationId: string, routineId: string, at: number): RoutineOperationResult {
    return this.#db.transaction(() => {
      const existing = this.#operation(operationId, { kind: 'propose', definition })
      if (existing !== undefined) return existing
      const valid = validate(definition, at)
      if (this.list().filter((routine) => routine.state !== 'archived').length >= 100)
        throw new Conflict({ reason: 'routine draft limit' })
      const routine: Row = {
        id: routineId,
        revision: 1,
        state: 'proposed',
        definitionJson: json(valid),
        proposerUserId: this.#user,
        confirmedByUserId: null,
        confirmedAt: null,
        scheduleId: null,
        nextFireAt: nextFire(valid, at),
        lastFireAt: null,
        missedCount: 0,
        pendingTrigger: null,
        suppressedCount: 0,
        health: null,
        createdAt: at,
        updatedAt: at,
      }
      this.#db.insert(appRoutines).values(routine).run()
      const response = { routine: this.#view(routine), operationId }
      this.#saveOperation(operationId, { kind: 'propose', definition }, response, at)
      return response
    })
  }
  edit(
    routineId: string,
    revision: number,
    definition: RoutineDefinition,
    operationId: string,
    at: number,
  ): RoutineOperationResult {
    return this.#db.transaction(() => {
      const existing = this.#operation(operationId, { kind: 'edit', routineId, revision, definition })
      if (existing !== undefined) return existing
      const current = this.get(routineId)
      if (current.revision !== revision) throw new Conflict({ reason: 'stale routine revision' })
      const valid = validate(definition, at)
      this.#db
        .update(appRoutines)
        .set({
          revision: revision + 1,
          state: 'proposed',
          definitionJson: json(valid),
          confirmedByUserId: null,
          confirmedAt: null,
          scheduleId: null,
          nextFireAt: nextFire(valid, at),
          health: null,
          updatedAt: at,
        })
        .where(and(eq(appRoutines.id, routineId), eq(appRoutines.revision, revision)))
        .run()
      const row = this.get(routineId)
      const response = { routine: this.#view(row), operationId }
      this.#saveOperation(operationId, { kind: 'edit', routineId, revision, definition }, response, at)
      return response
    })
  }
  confirm(routineId: string, revision: number, operationId: string, at: number): RoutineOperationResult {
    return this.#db.transaction(() => {
      const existing = this.#operation(operationId, { kind: 'confirm', routineId, revision })
      if (existing !== undefined) return existing
      const current = this.get(routineId)
      if (current.revision !== revision) throw new Conflict({ reason: 'stale routine revision' })
      if (current.state !== 'proposed' && current.state !== 'paused')
        throw new Conflict({ reason: 'routine is not confirmable' })
      const active = this.list().filter((routine) => routine.state === 'active' || routine.state === 'activating')
      if (active.length >= this.settings().maxActive) throw new Conflict({ reason: 'active routine limit' })
      const definition = decode(current.definitionJson)
      const next = nextFire(definition, at)
      this.#db
        .update(appRoutines)
        .set({
          state: 'activating',
          confirmedByUserId: this.#user,
          confirmedAt: at,
          nextFireAt: next,
          health: 'execution_pending',
          updatedAt: at,
        })
        .where(eq(appRoutines.id, routineId))
        .run()
      const response = { routine: this.#view(this.get(routineId)), operationId }
      this.#saveOperation(operationId, { kind: 'confirm', routineId, revision }, response, at)
      return response
    })
  }
  markActive(routineId: string, revision: number, scheduleId: string | null, at: number): RoutineView {
    const row = this.get(routineId)
    if (row.revision !== revision || row.state !== 'activating') return this.#view(row)
    this.#db
      .update(appRoutines)
      .set({ state: 'active', scheduleId, updatedAt: at })
      .where(eq(appRoutines.id, routineId))
      .run()
    return this.#view(this.get(routineId))
  }
  pause(routineId: string, revision: number, operationId: string, at: number): RoutineOperationResult {
    return this.#db.transaction(() => {
      const existing = this.#operation(operationId, { kind: 'pause', routineId, revision })
      if (existing !== undefined) return existing
      const current = this.get(routineId)
      if (current.revision !== revision) throw new Conflict({ reason: 'stale routine revision' })
      this.#db
        .update(appRoutines)
        .set({ state: 'paused', scheduleId: null, nextFireAt: null, updatedAt: at })
        .where(eq(appRoutines.id, routineId))
        .run()
      const response = { routine: this.#view(this.get(routineId)), operationId }
      this.#saveOperation(operationId, { kind: 'pause', routineId, revision }, response, at)
      return response
    })
  }
  archive(routineId: string, revision: number, operationId: string, at: number): RoutineOperationResult {
    return this.#db.transaction(() => {
      const existing = this.#operation(operationId, { kind: 'archive', routineId, revision })
      if (existing !== undefined) return existing
      const current = this.get(routineId)
      if (current.revision !== revision) throw new Conflict({ reason: 'stale routine revision' })
      this.#db
        .update(appRoutines)
        .set({ state: 'archived', scheduleId: null, nextFireAt: null, updatedAt: at })
        .where(eq(appRoutines.id, routineId))
        .run()
      const response = { routine: this.#view(this.get(routineId)), operationId }
      this.#saveOperation(operationId, { kind: 'archive', routineId, revision }, response, at)
      return response
    })
  }

  settingsUpdate(timezone: string, maxActive: number, maxRunning: number): void {
    timezoneValid(timezone)
    if (maxActive < 1 || maxActive > 20 || maxRunning < 1 || maxRunning > 2)
      throw new InvalidInput({ reason: 'routine caps' })
    this.#db
      .update(appRoutineSettings)
      .set({ timezone, maxActive, maxRunning })
      .where(eq(appRoutineSettings.id, 1))
      .run()
  }
}
