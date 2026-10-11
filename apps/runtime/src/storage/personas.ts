import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { NOTHING_JSON } from './migrations/setup.ts'

/**
 * Personas (ADR 0033): the current definition of each, global to the owner. A name is unique among active Personas,
 * ignoring case (a partial index in the migration). `revision` counts changes; every revision's definition is kept in
 * `app_persona_revisions`. `operation_id` makes a create idempotent.
 */
export const appPersonas = sqliteTable('app_personas', {
  id: integer('id').primaryKey({ autoIncrement: true }).notNull(),
  name: text('name').notNull(),
  glyph: text('glyph').notNull(),
  hue: integer('hue').notNull(),
  role: text('role').notNull(),
  instructions: text('instructions').notNull(),
  model: text('model'),
  /** The `PersonaSetup` JSON: what the Persona adds to its Topic's setup (ADR 0040). */
  setup: text('setup').notNull().default(NOTHING_JSON),
  revision: integer('revision').notNull(),
  operationId: text('operation_id').unique(),
  archivedAt: integer('archived_at'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
})

/** One stored revision of a Persona: its definition as it was, who changed it and when. */
export const appPersonaRevisions = sqliteTable(
  'app_persona_revisions',
  {
    personaId: integer('persona_id').notNull(),
    revision: integer('revision').notNull(),
    name: text('name').notNull(),
    glyph: text('glyph').notNull(),
    hue: integer('hue').notNull(),
    role: text('role').notNull(),
    instructions: text('instructions').notNull(),
    model: text('model'),
    setup: text('setup').notNull().default(NOTHING_JSON),
    actor: text('actor', { enum: ['owner', 'agent'] }).notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.personaId, table.revision] })],
)

/** One tagged Persona answering one owner message in one chat (the operation id of the owner's send). */
export const appPersonaInvocations = sqliteTable(
  'app_persona_invocations',
  {
    operationId: text('operation_id').notNull(),
    personaId: integer('persona_id').notNull(),
    revision: integer('revision').notNull(),
    chatId: text('chat_id').notNull(),
    ord: integer('ord').notNull(),
    state: text('state', { enum: ['pending', 'running', 'answered', 'failed', 'stopped'] }).notNull(),
    answerEntry: integer('answer_entry'),
    createdAt: integer('created_at').notNull(),
    settledAt: integer('settled_at'),
  },
  (table) => [
    primaryKey({ columns: [table.operationId, table.personaId] }),
    index('app_persona_invocation_chat').on(table.chatId, table.state),
  ],
)

/** What organizing records; the same literals as the contract's `OrganizeReceipt.kind`. */
export const ORGANIZE_KINDS = [
  'topic.create',
  'topic.rename',
  'topic.archive',
  'topic.restore',
  'topic.setup',
  'persona.create',
  'persona.update',
] as const

/**
 * What organizing changed (ADR 0033), with Undo: who did it, to what, and the target before and after as JSON.
 * `after_revision` is the target's revision right after the change: Undo applies only while it still is.
 * `operation_id` makes a recorded change idempotent for a tool call that runs twice.
 */
export const appOrganizeReceipts = sqliteTable('app_organize_receipts', {
  id: text('id').primaryKey().notNull(),
  operationId: text('operation_id').unique(),
  kind: text('kind', { enum: ORGANIZE_KINDS }).notNull(),
  target: text('target').notNull(),
  summary: text('summary').notNull(),
  actor: text('actor', { enum: ['owner', 'agent'] }).notNull(),
  chatId: text('chat_id'),
  before: text('before').notNull(),
  after: text('after').notNull(),
  afterRevision: integer('after_revision').notNull(),
  createdAt: integer('created_at').notNull(),
  undoneAt: integer('undone_at'),
})

/**
 * The chats a Persona answers in, with the setup it answers with there (ADR 0040): its hidden fork, frozen when the
 * owner tagged it, or the run conversation of a routine that hands it the work (ADR 0041), at the pinned revision. The
 * chat, which Persona at which revision, and the `PersonaSetup` JSON its Topic's setup is joined with there.
 */
export const appPersonaChats = sqliteTable('app_persona_chats', {
  chatId: text('chat_id').primaryKey().notNull(),
  personaId: integer('persona_id').notNull(),
  revision: integer('revision').notNull(),
  setup: text('setup').notNull(),
  createdAt: integer('created_at').notNull(),
})
