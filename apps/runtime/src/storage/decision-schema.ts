import { index, integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/**
 * Typed decision proposals (ADR 0031): what the agent proposes to the owner in a chat, the action as JSON with the
 * private fence it was judged under (`payload`), how sure it was and who judged it, until the owner labels it or a newer
 * exchange makes it stale.
 */
export const appDecisionProposals = sqliteTable(
  'app_decision_proposals',
  {
    id: text('id').primaryKey().notNull(),
    chatId: text('chat_id').notNull(),
    kind: text('kind', { enum: ['attention-triage', 'separate-work', 'context-relevance'] }).notNull(),
    subject: text('subject').notNull(),
    payload: text('payload').notNull(),
    state: text('state', { enum: ['open', 'confirmed', 'dismissed', 'stale'] }).notNull(),
    probability: real('probability').notNull(),
    provider: text('provider', { enum: ['rules', 'cloudflare/clef'] }).notNull(),
    createdAt: integer('created_at').notNull(),
    decidedAt: integer('decided_at'),
  },
  (table) => [index('app_decisions_chat_state').on(table.chatId, table.state)],
)

/** A proposal has exactly one terminal owner label. Repeated clicks retain the first label. */
export const appDecisionLabels = sqliteTable('app_decision_labels', {
  proposalId: text('proposal_id').primaryKey().notNull(),
  label: text('label', { enum: ['confirm', 'dismiss'] }).notNull(),
  judgedAt: integer('judged_at').notNull(),
  kind: text('kind').notNull(),
  provider: text('provider').notNull(),
  probability: real('probability').notNull(),
})
