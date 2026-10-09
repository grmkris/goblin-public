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
