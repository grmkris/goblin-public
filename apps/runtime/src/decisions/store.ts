import { DecisionAction, type DecisionLabel, type DecisionProposal } from '@goblin/contracts'
import { and, desc, eq, gte, inArray } from 'drizzle-orm'
import type { SQLiteAsyncDatabase } from 'drizzle-orm/sqlite-core/async/db'
import * as Schema from 'effect/Schema'
import { appDecisionLabels, appDecisionProposals } from '../storage/decision-schema.ts'

// The typed decisions' proposals and the owner's labels (ADR 0031), as functions of the agent's database. Each write is
// one statement or one short transaction; the service tells the change bus what changed. Times are epoch seconds.

/** The proposals' database: the agent's SQLite, or a test's. */
type DecisionDb = SQLiteAsyncDatabase<'sync', unknown>

/**
 * What a proposal was judged under, kept beside it and never shown: the chat's Pi session and epoch then, and for an
 * owner exchange the digest of the evidence judged (`sha256:<hex>`), so a newer exchange makes it stale.
 */
export const DecisionFence = Schema.Struct({
  session: Schema.String,
  epoch: Schema.Number,
  evidence: Schema.optional(Schema.String),
})
export type DecisionFence = typeof DecisionFence.Type

const StoredPayload = Schema.fromJsonString(Schema.Struct({ action: DecisionAction, fence: DecisionFence }))
const decodePayload = Schema.decodeUnknownSync(StoredPayload)
const encodePayload = Schema.encodeSync(StoredPayload)

type Row = typeof appDecisionProposals.$inferSelect

/** A proposal as stored: the proposal, and the fence it was judged under. */
export type StoredDecision = { readonly proposal: DecisionProposal; readonly fence: DecisionFence }

/** A write's outcome: the proposal as it is now, and whether this write changed it. */
export type Written = { readonly proposal: DecisionProposal; readonly changed: boolean }

const stored = (row: Row): StoredDecision => {
  const { action, fence } = decodePayload(row.payload)
  const { payload: _payload, decidedAt, ...fields } = row
  return { fence, proposal: { ...fields, payload: action, ...(decidedAt === null ? {} : { decidedAt }) } }
}

/** How many proposals the workspace snapshot carries: the newest open and confirmed ones. */
const LISTED = 100

/** Proposal `id` with its fence, if there is one. */
export const storedProposal = (db: DecisionDb, id: string): StoredDecision | undefined => {
  const row = db.select().from(appDecisionProposals).where(eq(appDecisionProposals.id, id)).get()
  return row === undefined ? undefined : stored(row)
}

/** The newest open and confirmed proposals, oldest first: older ones age out, so new ones always show. */
export const listProposals = (db: DecisionDb): readonly DecisionProposal[] =>
  db
    .select()
    .from(appDecisionProposals)
    .where(inArray(appDecisionProposals.state, ['open', 'confirmed']))
    .orderBy(desc(appDecisionProposals.createdAt), desc(appDecisionProposals.id))
    .limit(LISTED)
    .all()
    .map((row) => stored(row).proposal)
    .toReversed()

/** The chat's newest context proposal confirmed at or after `since`: the earlier work the owner chose to use there. */
export const chosenContextProposal = (db: DecisionDb, chat: string, since: number): DecisionProposal | undefined => {
  const row = db
    .select()
    .from(appDecisionProposals)
    .where(
      and(
        eq(appDecisionProposals.chatId, chat),
        eq(appDecisionProposals.state, 'confirmed'),
        eq(appDecisionProposals.kind, 'context-relevance'),
        gte(appDecisionProposals.decidedAt, since),
      ),
    )
    .orderBy(desc(appDecisionProposals.decidedAt), desc(appDecisionProposals.id))
    .get()
  return row === undefined ? undefined : stored(row).proposal
}

/** Adds `proposal` judged under `fence`, once: a proposal with its id already there stays as it is. */
export const addProposal = (db: DecisionDb, proposal: DecisionProposal, fence: DecisionFence): Written => {
  const inserted = db
    .insert(appDecisionProposals)
    .values({ ...proposal, payload: encodePayload({ action: proposal.payload, fence }) })
    .onConflictDoNothing()
    .returning()
    .get()
  if (inserted !== undefined) return { proposal: stored(inserted).proposal, changed: true }
  return { proposal: storedProposal(db, proposal.id)?.proposal ?? proposal, changed: false }
}

/**
 * The owner's `label` of open proposal `id` at `now`, with its first label row, in one transaction: a settled
 * proposal stays as it is, and keeps its first label. None when there is no proposal `id`.
 */
export const decideProposal = (
  db: DecisionDb,
  id: string,
  label: DecisionLabel['label'],
  now: number,
): Written | undefined => {
  const decided = db.transaction((tx) => {
    const row = tx
      .update(appDecisionProposals)
      .set({ state: label === 'confirm' ? 'confirmed' : 'dismissed', decidedAt: now })
      .where(and(eq(appDecisionProposals.id, id), eq(appDecisionProposals.state, 'open')))
      .returning()
      .get()
    if (row === undefined) return undefined
    tx.insert(appDecisionLabels)
      .values({
        proposalId: id,
        label,
        judgedAt: now,
        kind: row.kind,
        provider: row.provider,
        probability: row.probability,
      })
      .onConflictDoNothing()
      .run()
    return stored(row).proposal
  })
  if (decided !== undefined) return { proposal: decided, changed: true }
  const current = storedProposal(db, id)?.proposal
  return current === undefined ? undefined : { proposal: current, changed: false }
}

/** Open proposal `id` made stale by a newer exchange at `now`; a settled one stays as it is. None when there is none. */
export const staleProposal = (db: DecisionDb, id: string, now: number): Written | undefined => {
  const row = db
    .update(appDecisionProposals)
    .set({ state: 'stale', decidedAt: now })
    .where(and(eq(appDecisionProposals.id, id), eq(appDecisionProposals.state, 'open')))
    .returning()
    .get()
  if (row !== undefined) return { proposal: stored(row).proposal, changed: true }
  const current = storedProposal(db, id)?.proposal
  return current === undefined ? undefined : { proposal: current, changed: false }
}
