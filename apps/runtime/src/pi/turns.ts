import { type Conversation, type EntryId, type Harness, LiveDoc } from '@earendil-works/pi-durable'
import { BACKGROUND, conversationId, entryId } from './context.ts'

/**
 * The transcript entries of the inputs the run in progress in `session` placed (its first message and any steers), in
 * order; empty while the session is idle.
 */
export async function runInputEntries(pi: Harness, session: string): Promise<readonly EntryId[]> {
  const run = (await pi.snapshot(LiveDoc, conversationId(session), BACKGROUND))?.run
  if (run === undefined) return []
  const inputs = new Set<number>(run.inputs)
  return (await pi.inspect(BACKGROUND)).submissions
    .flatMap((submission) => (inputs.has(submission.id) && submission.status === 'placed' ? [submission.entry] : []))
    .toSorted((a, b) => a - b)
}

/**
 * The newest entry of a conversation outside a running turn: its newest entry while idle, else the newest before the
 * first input of the run in progress, so nothing forked there starts inside a turn. Undefined when there is none.
 */
export async function settledEnd(pi: Harness, session: string, source: Conversation): Promise<EntryId | undefined> {
  const [first] = await runInputEntries(pi, session)
  const query = first === undefined ? {} : { maxEntryId: entryId(first - 1) }
  const [newest] = (await source.entries(query, 1, undefined, BACKGROUND)).items
  return newest?.id
}

/**
 * The first input of the newest turn a session ran itself and still shows: its newest own `pi.user` entry that does
 * not join a turn already under way and that no later entry omits (a turn moved to a Thread, ADR 0034). A steer is
 * placed after a tool round, so the model entry before it is a tool result (passive notes placed at the same boundary
 * come in between). Undefined when none is among its newest entries.
 */
export async function latestTurnStart(conversation: Conversation, session: string): Promise<EntryId | undefined> {
  const { items } = await conversation.entries({}, 200, undefined, BACKGROUND)
  const omitted = new Set(
    items.flatMap((entry) => (entry.edits ?? []).flatMap((edit) => (edit.action === 'omit' ? [edit.target] : []))),
  )
  const shown = items.filter((entry) => !omitted.has(entry.id))
  for (const [index, entry] of shown.entries()) {
    if (entry.kind !== 'pi.user' || String(entry.conversationId) !== session) continue
    const before = shown.slice(index + 1).find((older) => older.kind.startsWith('pi.'))
    if (before?.kind !== 'pi.tool-result') return entry.id
  }
  return undefined
}
