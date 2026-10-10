import {
  type CreatePersona,
  NOTHING,
  type PersonaAvatar,
  type PersonaDefinition,
  type PersonaDetail,
  type PersonaRevisionView,
  PersonaSetup,
  type PersonaView,
  type UpdatePersona,
} from '@goblin/contracts'
import { and, asc, desc, eq, isNull, ne, sql } from 'drizzle-orm'
import type { SQLiteAsyncDatabase } from 'drizzle-orm/sqlite-core/async/db'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import { Conflict, InvalidInput, NotFound } from '../http/errors.ts'
import { appPersonaRevisions, appPersonas } from '../storage/personas.ts'

type Row = typeof appPersonas.$inferSelect
type RevisionRow = typeof appPersonaRevisions.$inferSelect

/** Who changed a Persona: the owner (UI) or the agent (its organize tools, on a direct request). */
export type PersonaActor = 'owner' | 'agent'

const decodeSetup = Schema.decodeUnknownOption(Schema.fromJsonString(PersonaSetup))

/** A Persona's stored setup (ADR 0040), or nothing added when the row cannot be read: a bad row never widens. */
export const personaSetupOf = (stored: string): PersonaSetup => Option.getOrElse(decodeSetup(stored), () => NOTHING)

/** A name as stored: runs of whitespace become one space, ends trimmed. */
const cleanName = (name: string): string => name.replaceAll(/\s+/gu, ' ').trim()

const definitionOf = (row: Row | RevisionRow): PersonaDefinition => ({
  name: row.name,
  avatar: { glyph: row.glyph, hue: row.hue },
  role: row.role,
  instructions: row.instructions,
  ...(row.model === null ? {} : { model: row.model }),
  setup: personaSetupOf(row.setup),
})

const view = (row: Row): PersonaView => ({
  ...definitionOf(row),
  id: row.id,
  revision: row.revision,
  ...(row.archivedAt === null ? {} : { archivedAt: row.archivedAt }),
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
})

const revisionView = (row: RevisionRow): PersonaRevisionView => ({
  ...definitionOf(row),
  revision: row.revision,
  actor: row.actor,
  createdAt: row.createdAt,
})

/** The values a revision stores for `definition`. */
const stored = (definition: PersonaDefinition) => ({
  name: definition.name,
  glyph: definition.avatar.glyph,
  hue: definition.avatar.hue,
  role: definition.role,
  instructions: definition.instructions,
  model: definition.model ?? null,
  exclusions: '[]',
  setup: JSON.stringify(definition.setup),
})

/**
 * The owner's Personas (ADR 0033): named, versioned agent definitions. Every create and update writes a new revision
 * and bumps `revision`; an update names the revision it edits (`expectedRevision`), so two edits never silently
 * overwrite each other. A model must be one the deployment offers. A setup is stored as given: it only chooses among
 * the owner's grants, which are checked when anything runs, so nothing here can grant one (ADR 0040). Archiving keeps
 * the history; an
 * archived Persona no longer answers and frees its name. All writes are synchronous in one SQLite step. The store keeps
 * no state; the Personas service tells the change bus what each write changed (`personas/service.ts`).
 */
export class PersonaRegistry<RunResult = unknown> {
  readonly #db: SQLiteAsyncDatabase<'sync', RunResult>
  readonly #models: readonly string[]

  /** `models`: the ids of the models this deployment offers (`modelOptions`). */
  constructor(db: SQLiteAsyncDatabase<'sync', RunResult>, models: readonly string[]) {
    this.#db = db
    this.#models = models
  }

  #row(id: number): Row {
    const row = this.#db.select().from(appPersonas).where(eq(appPersonas.id, id)).get()
    if (row === undefined) throw new NotFound({ what: 'persona' })
    return row
  }

  /** Every Persona, archived ones included, in creation order. */
  list(): readonly PersonaView[] {
    return this.#db.select().from(appPersonas).orderBy(asc(appPersonas.id)).all().map(view)
  }

  /** The Personas that can answer now. */
  active(): readonly PersonaView[] {
    return this.list().filter((persona) => persona.archivedAt === undefined)
  }

  get(id: number): PersonaView {
    return view(this.#row(id))
  }

  /** The active Persona named `name` (ignoring case), if any. */
  byName(name: string): PersonaView | undefined {
    const row = this.#db
      .select()
      .from(appPersonas)
      .where(and(sql`${appPersonas.name} = ${cleanName(name)} COLLATE NOCASE`, isNull(appPersonas.archivedAt)))
      .get()
    return row === undefined ? undefined : view(row)
  }

  /** A Persona with its revisions, newest first. */
  detail(id: number): PersonaDetail {
    const row = this.#row(id)
    const revisions = this.#db
      .select()
      .from(appPersonaRevisions)
      .where(eq(appPersonaRevisions.personaId, id))
      .orderBy(desc(appPersonaRevisions.revision))
      .all()
    return { persona: view(row), revisions: revisions.map(revisionView) }
  }

  /** One stored revision, as an invocation froze it. */
  revision(id: number, revision: number): PersonaRevisionView {
    const row = this.#db
      .select()
      .from(appPersonaRevisions)
      .where(and(eq(appPersonaRevisions.personaId, id), eq(appPersonaRevisions.revision, revision)))
      .get()
    if (row === undefined) throw new NotFound({ what: 'persona revision' })
    return revisionView(row)
  }

  /** Whether this deployment offers `model` now (a Persona's preference for a model no longer offered is ignored). */
  offers(model: string | undefined): boolean {
    return model !== undefined && this.#models.includes(model)
  }

  #assertName(name: string, except?: number): void {
    const clash = this.#db
      .select({ id: appPersonas.id })
      .from(appPersonas)
      .where(
        and(
          sql`${appPersonas.name} = ${name} COLLATE NOCASE`,
          isNull(appPersonas.archivedAt),
          ...(except === undefined ? [] : [ne(appPersonas.id, except)]),
        ),
      )
      .get()
    if (clash !== undefined) throw new Conflict({ reason: 'persona_name_taken' })
  }

  #assertModel(model: string | undefined): void {
    if (model !== undefined && !this.#models.includes(model)) throw new InvalidInput({ reason: 'persona_model' })
  }

  /** The definition `definition` normalizes to, checked: a clean name and an offered model. */
  #normalize(definition: PersonaDefinition): PersonaDefinition {
    const name = cleanName(definition.name)
    if (name === '') throw new InvalidInput({ reason: 'persona_name' })
    this.#assertModel(definition.model)
    return { ...definition, name }
  }

  /**
   * A new Persona at revision 1, or the one `operationId` already made (whatever it is now). A name another active
   * Persona has is a `Conflict`.
   */
  create(input: CreatePersona, actor: PersonaActor, now: number): { persona: PersonaView; created: boolean } {
    const existing = this.#db.select().from(appPersonas).where(eq(appPersonas.operationId, input.operationId)).get()
    if (existing !== undefined) return { persona: view(existing), created: false }
    const { operationId, ...fields } = input
    const definition = this.#normalize({ ...fields, setup: fields.setup ?? NOTHING })
    const row = this.#db.transaction(() => {
      this.#assertName(definition.name)
      const [inserted] = this.#db
        .insert(appPersonas)
        .values({ ...stored(definition), revision: 1, operationId, createdAt: now, updatedAt: now })
        .returning()
        .all()
      if (inserted === undefined) throw new Conflict({ reason: 'persona_not_created' })
      this.#db
        .insert(appPersonaRevisions)
        .values({ personaId: inserted.id, revision: 1, ...stored(definition), actor, createdAt: now })
        .run()
      return inserted
    })
    return { persona: view(row), created: true }
  }

  /** The definition `change` makes of `current`: a field not given stays, `model: null` clears the preference. */
  #changed(current: PersonaDefinition, change: UpdatePersona): PersonaDefinition {
    const model = change.model === undefined ? current.model : (change.model ?? undefined)
    return this.#normalize({
      name: change.name ?? current.name,
      avatar: change.avatar ?? current.avatar,
      role: change.role ?? current.role,
      instructions: change.instructions ?? current.instructions,
      ...(model === undefined ? {} : { model }),
      setup: change.setup ?? current.setup,
    })
  }

  /**
   * A new revision with `change` applied, if `expectedRevision` is the current one (else `Conflict` `revision`).
   * Nothing changed is no write. Archiving or restoring is a revision too; a restore onto a name another active Persona
   * took is a `Conflict`.
   */
  update(id: number, change: UpdatePersona, actor: PersonaActor, now: number): PersonaView {
    const row = this.#row(id)
    if (row.revision !== change.expectedRevision) throw new Conflict({ reason: 'revision' })
    const next = this.#changed(definitionOf(row), change)
    const archivedAt = change.archived === undefined ? row.archivedAt : change.archived ? (row.archivedAt ?? now) : null
    const values = stored(next)
    if (archivedAt === row.archivedAt && sameValues(values, row)) return view(row)
    const updated = this.#db.transaction(() => {
      if (archivedAt === null) this.#assertName(next.name, id)
      const [changed] = this.#db
        .update(appPersonas)
        .set({ ...values, archivedAt, revision: row.revision + 1, updatedAt: now })
        .where(and(eq(appPersonas.id, id), eq(appPersonas.revision, row.revision)))
        .returning()
        .all()
      if (changed === undefined) throw new Conflict({ reason: 'revision' })
      this.#db
        .insert(appPersonaRevisions)
        .values({ personaId: id, revision: changed.revision, ...values, actor, createdAt: now })
        .run()
      return changed
    })
    return view(updated)
  }
}

/** Whether a row already holds exactly `values`. */
const sameValues = (values: ReturnType<typeof stored>, row: Row): boolean =>
  values.name === row.name &&
  values.glyph === row.glyph &&
  values.hue === row.hue &&
  values.role === row.role &&
  values.instructions === row.instructions &&
  values.model === row.model &&
  values.setup === row.setup

/** A glyph and hue for a Persona made without an avatar: its first letter on a hue from its name. */
export function defaultAvatar(name: string): PersonaAvatar {
  const glyph = String.fromCodePoint(name.trim().codePointAt(0) ?? 80).toUpperCase()
  let hash = 0
  for (const char of name) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) % 360
  return { glyph, hue: hash }
}
