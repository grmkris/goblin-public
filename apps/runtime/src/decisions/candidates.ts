import { and, eq, isNull, ne } from 'drizzle-orm'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import { chatOfSession, chatRow } from '../chats/directory.ts'
import { attempt, attemptSync } from '../http/errors.ts'
import type { KeyedLock } from '../observability/lock.ts'
import { type PiSessions, fromPi } from '../pi/sessions.ts'
import { recentMessages } from '../pi/transcript.ts'
import { sha256Hex } from '../runtime/digest.ts'
import { appConversations } from '../storage/schema.ts'
import { type IndexDeps, contextCandidates, contextCase } from './context.ts'
import type { Judgment } from './critic.ts'
import type { WorkState } from './schema.ts'
import type { DecisionFence } from './store.ts'

/** How long a suggested thread's title may be. */
const TITLE = 60

/**
 * The owner's message as a suggested thread's title: one line, at most 60 characters, a longer one cut after a whole
 * word with an ellipsis.
 */
export function threadTitle(text: string): string {
  const flat = text.replaceAll(/\s+/gu, ' ').trim()
  if (flat === '') return 'New thread'
  if (flat.length <= TITLE) return flat
  const space = flat.slice(0, TITLE).lastIndexOf(' ')
  // One very long word has no break to cut at, so it is cut inside.
  return `${flat.slice(0, space > TITLE / 2 ? space : TITLE - 1).trimEnd()}…`
}

/** A Delegate's final report in a chat's session, keyed by its relay. */
export type DelegateReport = {
  readonly session: string
  readonly relayId: string
  readonly text: string
  /** The relay closes as done and did not fail: only then is the report an ordinary result. */
  readonly complete: boolean
}

/** What the candidates are read from: the agent's database and transcript index, Pi, and the per-key lock. */
export type CandidateDeps = {
  readonly index: IndexDeps
  readonly pi: PiSessions['Service']
  readonly lock: KeyedLock['Service']
}

/** A Delegate result that is a question, an approval or a failure: a runtime fact, never ranked for attention. */
const RUNTIME_FACT = /\?|approval|permission|ask_user|^It failed:|^It ended without/iu

/** The chat's row while it is an open owner chat: registered, not closed, not a Delegate's, not a routine run's. */
const ownerRow = ({ index }: CandidateDeps, chat: string) =>
  attemptSync(() => {
    const row = chatRow(index.db, chat)
    return row === undefined || row.closedAt !== null || row.kind === 'subagent' || row.routineRunId !== null
      ? undefined
      : row
  })

/** The owner chat's Pi session and epoch now: what a proposal about it is fenced on. */
const fenceOf = (deps: CandidateDeps, chat: string) =>
  Effect.map(ownerRow(deps, chat), (row): DecisionFence | undefined =>
    row?.piSession === undefined || row.piSession === null ? undefined : { session: row.piSession, epoch: row.epoch },
  )

/** The newest messages of `session`, from its whole history. */
const messagesOf = (deps: CandidateDeps, session: string) =>
  Effect.gen(function* () {
    const conversation = yield* fromPi(deps.pi.conversation(session))
    if (Option.isNone(conversation)) return []
    return yield* attempt(() => recentMessages(conversation.value, 8))
  })

/**
 * The owner's exchange in `chat` as the separate-work question sees it: the chat, the owner's other open threads, and
 * its newest messages from the owner and goblin. None unless the newest user message is the owner's own.
 */
const workOf = (deps: CandidateDeps, chat: string, session: string) =>
  Effect.gen(function* () {
    const messages = yield* messagesOf(deps, session)
    const lastOwner = messages.findLast((message) => message.role === 'user')
    if (lastOwner === undefined || lastOwner.author !== undefined) return undefined
    const row = yield* ownerRow(deps, chat)
    if (row === undefined) return undefined
    const threads = yield* attemptSync(() =>
      deps.index.db
        .select()
        .from(appConversations)
        .where(
          and(
            eq(appConversations.kind, 'thread'),
            isNull(appConversations.closedAt),
            isNull(appConversations.routineRunId),
            ne(appConversations.chatId, chat),
          ),
        )
        .limit(20)
        .all(),
    )
    // The key order is part of the evidence digest that fences a proposal: keep it.
    const work: WorkState = {
      currentTopic: 'Current work',
      currentThread: row.title ?? 'Main',
      topics: [],
      threads: threads.map((thread) => ({ id: thread.chatId, name: thread.title ?? 'Untitled thread' })),
      exchange: messages
        .filter((message) => message.role === 'assistant' || message.author === undefined)
        .map((message) => ({
          role: message.role === 'assistant' ? ('assistant' as const) : ('owner' as const),
          text: message.text.slice(0, 1500),
        })),
    }
    return work
  })

/** The digest a proposal about an exchange is fenced on: `sha256:` and the hex digest of the exchange as judged. */
const evidenceOf = (work: WorkState) =>
  Effect.map(
    attempt(() => sha256Hex(JSON.stringify(work))),
    (hex) => `sha256:${hex}`,
  )

/**
 * Whether the chat is still where `fence` saw it: the same open owner chat on the same session and epoch, and, for an
 * exchange, the same evidence, read again after the evidence (a move between the two makes it stale too).
 */
export const stillCurrent = (deps: CandidateDeps, chat: string, fence: DecisionFence) =>
  Effect.gen(function* () {
    const same = (now: DecisionFence | undefined) => now?.session === fence.session && now.epoch === fence.epoch
    if (!same(yield* fenceOf(deps, chat))) return false
    if (fence.evidence === undefined) return true
    const work = yield* workOf(deps, chat, fence.session)
    if (work === undefined || (yield* evidenceOf(work)) !== fence.evidence) return false
    return same(yield* fenceOf(deps, chat))
  })

/**
 * What the owner's answered exchange in `session` is judged for: whether it could be a thread, and which earlier work
 * in the owner's other chats could help with it. Both are fenced on the same exchange, so a newer one makes them stale.
 */
export const ownerYield = (deps: CandidateDeps, session: string) =>
  Effect.gen(function* () {
    const chat = yield* attemptSync(() => chatOfSession(deps.index.db, session))
    const fence = chat === undefined ? undefined : yield* fenceOf(deps, chat)
    if (chat === undefined || fence === undefined) return []
    const work = yield* workOf(deps, chat, session)
    if (work === undefined) return []
    const evidence = yield* evidenceOf(work)
    const frozen = { ...fence, evidence }
    const shared = {
      chatId: chat,
      subject: evidence,
      ordinary: true,
      fence: frozen,
      current: stillCurrent(deps, chat, frozen),
    }
    const digest = evidence.slice('sha256:'.length)
    const thread: Judgment = {
      ...shared,
      id: `dp_thread_${session}_${digest}`,
      case: { id: 'work', task: 'separate-work', state: work },
      payload: {
        type: 'thread-draft',
        title: threadTitle(work.exchange.findLast((message) => message.role === 'owner')?.text ?? ''),
      },
    }
    const found = yield* contextCandidates(deps.index, deps.lock, session, chat)
    if (found === undefined) return [thread]
    const context: Judgment = {
      ...shared,
      id: `dp_context_${session}_${digest}`,
      case: contextCase(found.input.text, found.sources),
      payload: { type: 'context', inputEntry: found.input.entry, sources: found.sources },
    }
    return [thread, context]
  })

/** What a Delegate's final report is judged for: whether it deserves the owner's attention. None outside owner chats. */
export const delegateReport = (deps: CandidateDeps, report: DelegateReport) =>
  Effect.gen(function* () {
    const chat = yield* attemptSync(() => chatOfSession(deps.index.db, report.session))
    const fence = chat === undefined ? undefined : yield* fenceOf(deps, chat)
    if (chat === undefined || fence === undefined) return undefined
    const messages = yield* messagesOf(deps, report.session)
    const focus =
      messages.findLast((message) => message.role === 'user' && message.author === undefined)?.text ?? 'Current work'
    const judgment: Judgment = {
      id: `dp_report_${report.relayId}`,
      chatId: chat,
      subject: report.relayId,
      fence,
      ordinary: report.complete && !RUNTIME_FACT.test(report.text),
      case: {
        id: 'report',
        task: 'attention-triage',
        state: { focus: focus.slice(0, 2000), result: report.text.slice(0, 8000), runtimeKind: 'delegate-result' },
      },
      payload: { type: 'highlight', relayId: report.relayId, text: report.text.slice(0, 8000) },
      current: stillCurrent(deps, chat, fence),
    }
    return judgment
  })
