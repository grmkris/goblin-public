import { and, desc, eq, sql } from 'drizzle-orm'
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite'
import { Conflict, InvalidInput, NotFound } from '../http/errors.ts'
import { PERSONAL_TOPIC, RoutineDefinition, RoutineView, hasTool } from '@goblin/contracts'
import * as Schema from 'effect/Schema'
import { canonicalArguments } from '../mcp/events/store.ts'
import { appRoutineOperations, appRoutines, appRoutineSettings } from '../storage/routines.ts'
import { appTopics } from '../storage/topics.ts'
import { topicSetupOf } from '../topics/setup.ts'
import { nextFire, timezoneValid } from './time.ts'

type Db = DrizzleSqliteDODatabase
/** A routine as stored: its definition still as JSON, and the scheduling fields only the runtime reads. */
export type RoutineRow = typeof appRoutines.$inferSelect
const json = (value: unknown) => JSON.stringify(value)

/** The definition a routine or one of its runs was stored with, as the owner confirmed it. */
export const definitionOf = (stored: { readonly definitionJson: string }): RoutineDefinition =>
  Schema.decodeUnknownSync(RoutineDefinition)(JSON.parse(stored.definitionJson))

const OperationResult = Schema.Struct({ routine: RoutineView, operationId: Schema.String })
export type RoutineOperationResult = typeof OperationResult.Type

function validate(input: RoutineDefinition, at: number): RoutineDefinition {
  const definition = Schema.decodeUnknownSync(RoutineDefinition)(input)
  canonicalArguments(definition.trigger.kind === 'event' ? definition.trigger.arguments : {})
  if (definition.allowedTools.some((tool) => tool.connectionId === '' || tool.name === ''))
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

  /** The allowed tools of `definition` that the setup of Topic `topic` does not hold now (ADR 0040). */
  #outside(topic: number, definition: RoutineDefinition) {
    const row = this.#db.select({ setup: appTopics.setup }).from(appTopics).where(eq(appTopics.id, topic)).get()
    const setup = row === undefined ? undefined : topicSetupOf(row.setup)
    return definition.allowedTools
      .filter((tool) => setup === undefined || !hasTool(setup, tool.connectionId, tool.name))
      .map(({ connectionId, name }) => ({ connectionId, name }))
  }

  #view(row: RoutineRow): RoutineView {
    const definition = definitionOf(row)
    return {
      id: row.id,
      revision: row.revision,
      state: row.state,
      definition,
      confirmedAt: row.confirmedAt,
      nextFireAt: row.nextFireAt,
      lastFireAt: row.lastFireAt,
      missedCount: row.missedCount,
      suppressedCount: row.suppressedCount,
      health: row.health,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      topic: row.topicId,
      outsideSetup: this.#outside(row.topicId, definition),
    }
  }
  list(includeArchived = false): RoutineView[] {
    const rows = this.#db.select().from(appRoutines).orderBy(desc(appRoutines.updatedAt)).all()
    return rows.filter((row) => includeArchived || row.state !== 'archived').map((row) => this.#view(row))
  }
  get(routineId: string): RoutineRow {
    const row = this.#db.select().from(appRoutines).where(eq(appRoutines.id, routineId)).get()
    if (row === undefined || row.proposerUserId !== this.#user) throw new NotFound({ what: 'routine' })
    return row
  }
  view(routineId: string): RoutineView {
    return this.#view(this.get(routineId))
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
  /** The Topic that owns routine `id` (ADR 0032); Personal for one this agent does not have. */
  topicOf(id: string): number {
    return (
      this.#db.select({ topic: appRoutines.topicId }).from(appRoutines).where(eq(appRoutines.id, id)).get()?.topic ?? 1
    )
  }

  propose(
    definition: RoutineDefinition,
    operationId: string,
    routineId: string,
    at: number,
    topic = PERSONAL_TOPIC,
  ): RoutineOperationResult {
    return this.#db.transaction(() => {
      const existing = this.#operation(operationId, { kind: 'propose', definition })
      if (existing !== undefined) return existing
      const valid = validate(definition, at)
      if (this.list().filter((routine) => routine.state !== 'archived').length >= 100)
        throw new Conflict({ reason: 'routine draft limit' })
      const routine: RoutineRow = {
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
        topicId: topic,
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
          pendingTrigger: null,
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
      const definition = definitionOf(current)
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
    if (row.revision !== revision || (row.state !== 'activating' && row.state !== 'active')) return this.#view(row)
    this.#db
      .update(appRoutines)
      .set({ state: 'active', scheduleId, health: null, updatedAt: at })
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
        .set({
          state: 'paused',
          // A retired Events consumer revision must never be revived by Resume.
          revision: definitionOf(current).trigger.kind === 'event' ? revision + 1 : revision,
          scheduleId: null,
          nextFireAt: null,
          pendingTrigger: null,
          updatedAt: at,
        })
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
        .set({ state: 'archived', scheduleId: null, nextFireAt: null, pendingTrigger: null, updatedAt: at })
        .where(eq(appRoutines.id, routineId))
        .run()
      const response = { routine: this.#view(this.get(routineId)), operationId }
      this.#saveOperation(operationId, { kind: 'archive', routineId, revision }, response, at)
      return response
    })
  }

  settingsUpdate(timezone: string, maxActive: number, maxRunning: number): void {
    timezoneValid(timezone)
    if (
      !Number.isInteger(maxActive) ||
      !Number.isInteger(maxRunning) ||
      maxActive < 1 ||
      maxActive > 20 ||
      maxRunning < 1 ||
      maxRunning > 2
    )
      throw new InvalidInput({ reason: 'routine caps' })
    this.#db
      .update(appRoutineSettings)
      .set({ timezone, maxActive, maxRunning })
      .where(eq(appRoutineSettings.id, 1))
      .run()
  }

  scheduling(): RoutineRow[] {
    return this.#db.select().from(appRoutines).all()
  }
  eventHealth(id: string, revision: number, health: string | null, at: number): void {
    this.#db
      .update(appRoutines)
      .set({ health, updatedAt: at })
      .where(and(eq(appRoutines.id, id), eq(appRoutines.revision, revision)))
      .run()
  }
  advance(
    input: { id: string; revision: number; expectedAt: number; nextAt: number | null; missed: number },
    at: number,
  ): void {
    const { id, revision, expectedAt, nextAt, missed } = input
    this.#db
      .update(appRoutines)
      .set({
        nextFireAt: nextAt,
        scheduleId: null,
        missedCount: sql`${appRoutines.missedCount} + ${missed}`,
        state: nextAt === null && this.get(id).pendingTrigger === null ? 'completed' : 'active',
        updatedAt: at,
      })
      .where(
        and(
          eq(appRoutines.id, id),
          eq(appRoutines.revision, revision),
          eq(appRoutines.nextFireAt, expectedAt),
          eq(appRoutines.state, 'active'),
        ),
      )
      .run()
  }
  pending(id: string, revision: number, sealed: string, at: number): void {
    this.#db
      .update(appRoutines)
      .set({ pendingTrigger: sealed, suppressedCount: sql`${appRoutines.suppressedCount} + 1`, updatedAt: at })
      .where(and(eq(appRoutines.id, id), eq(appRoutines.revision, revision), eq(appRoutines.state, 'active')))
      .run()
  }
  queue(
    input: { id: string; revision: number; expectedAt: number; nextAt: number | null; missed: number },
    sealed: string,
    at: number,
  ): void {
    this.#db.transaction(() => {
      this.pending(input.id, input.revision, sealed, at)
      this.advance(input, at)
    })
  }
  clearPending(id: string, sealed: string, at: number): void {
    const row = this.get(id)
    this.#db
      .update(appRoutines)
      .set({
        pendingTrigger: null,
        state:
          row.state === 'active' && row.nextFireAt === null && definitionOf(row).trigger.kind !== 'event'
            ? 'completed'
            : row.state,
        updatedAt: at,
      })
      .where(and(eq(appRoutines.id, id), eq(appRoutines.pendingTrigger, sealed)))
      .run()
  }
}
