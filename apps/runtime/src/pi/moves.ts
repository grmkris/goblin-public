import {
  type AgentChange,
  type ConversationId,
  type EntryId,
  type EntryRecord,
  type Harness,
  configure,
  defineDocFamily,
} from '@earendil-works/pi-durable'
import { DelegateResultData } from '@goblin/contracts'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import { Conflict, NotFound } from '../http/errors.ts'
import { BACKGROUND, entryId } from './context.ts'
import { MemoryBuilder } from './memory.ts'
import { SUBAGENT_RELAY, Subagents, relayTarget } from './subagent-relay.ts'

/**
 * The Thread a move forked, by the move's operation id: the fork reads it first, so a restarted move finds the Thread
 * it already made instead of forking again (ADR 0034).
 */
const MoveWitness = defineDocFamily<{ fork: number | null }, null>({
  kind: 'app.move-witness',
  version: 1,
  scope: 'session',
  family: true,
  initial: () => ({ fork: null }),
})

/** The entries of a turn that belong to it, as the chat omits them: what the owner and the model said in it. */
const TURN_KINDS: ReadonlySet<string> = new Set(['pi.user', 'pi.assistant', 'pi.tool-result'])

const delegateOf = Schema.decodeUnknownOption(DelegateResultData)

/** Whether an entry is the turn's: its own words, or the result of a Delegate it started (one newer than its message). */
const ofTurn = (entry: EntryRecord, message: number): boolean =>
  TURN_KINDS.has(entry.kind) ||
  (entry.kind === 'app.delegate_result' &&
    Option.match(delegateOf(entry.data), { onNone: () => false, onSome: (data) => Number(data.delegate) > message }))

/**
 * The Thread of a settled move (ADR 0034), one Pi commit on the chat's session: a fork at the last entry of the moved
 * turn, made a thread (`agent`), with the helpers that turn started on its roster. Table reads come first: the fork is
 * a table write. Returns the Thread, the same one again when the commit already happened.
 */
export async function forkThread(
  pi: Harness,
  input: {
    readonly operation: string
    readonly source: ConversationId
    readonly message: EntryId
    readonly end: EntryId
    readonly agent: AgentChange
  },
): Promise<ConversationId> {
  const source = await pi.conversation(input.source, BACKGROUND)
  if (source === undefined) throw new NotFound({ what: 'conversation' })
  return source.commit(async (tx) => {
    const witness = await tx.doc(MoveWitness, input.operation, null)
    if (witness.fork !== null)
      // SAFETY: the witness holds the Thread's Pi id, which this commit stored below.
      return witness.fork as ConversationId
    const message = await tx.entry(input.message)
    if (message?.kind !== 'pi.user' || message.conversationId !== input.source)
      throw new Conflict({ reason: 'moved_message' })
    const roster = await tx.doc(Subagents, input.source)
    const fork = await tx.forkConversation(input.source, input.end, { ownership: { kind: 'ownerless' } })
    await configure(tx, fork.id, input.agent)
    const helpers = await tx.doc(Subagents, fork.id)
    for (const [name, agent] of Object.entries(roster.agents))
      if (agent.conversationId > input.message)
        helpers.agents[name] = {
          conversationId: agent.conversationId,
          reported: [...agent.reported],
          ...(agent.quotes === undefined ? {} : { quotes: [...agent.quotes] }),
          ...(agent.synthesize === undefined ? {} : { synthesize: agent.synthesize }),
        }
    witness.fork = fork.id
    return fork.id
  }, BACKGROUND)
}

/**
 * Stops the memory builder working in the chat's session, so nothing logs the moved turn while the memory forgets it;
 * the chat's next answer starts a new one.
 */
export async function stopBuilder(pi: Harness, session: ConversationId): Promise<void> {
  const task = (await pi.snapshot(MemoryBuilder, session, BACKGROUND))?.task
  if (task !== null && task !== undefined) await pi.abortTask(task, BACKGROUND)
}

/**
 * The chat's own entries of the moved turn, from the owner's message to `end`, that the chat omits: its words and the
 * results its Delegates posted. Entries an earlier move omitted already (a later turn moved first) are not the turn's;
 * passive notes beside it (a share-back, a Persona's answer) stay the chat's.
 */
export async function turnEntries(
  pi: Harness,
  input: { readonly source: ConversationId; readonly message: number; readonly end: number },
): Promise<readonly EntryId[]> {
  const conversation = await pi.conversation(input.source, BACKGROUND)
  if (conversation === undefined) throw new NotFound({ what: 'conversation' })
  const range = { minEntryId: entryId(input.message), maxEntryId: entryId(input.end) }
  const entries: EntryRecord[] = []
  let cursor: Parameters<typeof conversation.entries>[2]
  do {
    const page = await conversation.entries(range, 100, cursor, BACKGROUND)
    entries.push(...page.items)
    cursor = page.next
  } while (cursor !== undefined)
  const omitted = new Set(
    entries.flatMap((entry) => (entry.edits ?? []).flatMap((edit) => (edit.action === 'omit' ? [edit.target] : []))),
  )
  return entries
    .filter((entry) => entry.conversationId === input.source && ofTurn(entry, input.message) && !omitted.has(entry.id))
    .map((entry) => entry.id)
    .toSorted((a, b) => a - b)
}

/** The live relays in the chat's session carrying messages to helpers the moved turn started. */
export async function turnRelays(pi: Harness, source: ConversationId, message: number): Promise<readonly number[]> {
  const { tasks } = await pi.inspect(BACKGROUND)
  return tasks.flatMap(({ record }) => {
    const target = record.kind === SUBAGENT_RELAY && record.conversationId === source ? relayTarget(record) : undefined
    return target !== undefined && target > message ? [Number(record.id)] : []
  })
}
