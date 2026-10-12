// A conversation's Pi entries as transcript messages: the model's own messages, the entries the shell draws itself
// (thread heads, Persona answers and asks, Topic seeds, Delegate results, "+" notes), passive notes marked by their
// kind (a routine's report, a decided call's kept outcome), and none for what a marker or a later edit leaves out.
// Committed entries never change, so each is projected once.
import {
  DelegateResultData,
  NoticeData,
  PersonaAnswerData,
  PersonaAskData,
  ThreadHeadData,
  TopicSeedData,
} from '@goblin/contracts'
import { Option, Schema } from 'effect'
import { type ChatMessage, entryMessage, stamped } from './chat-messages.ts'
import { identifier, isNumber, isString, record, records } from './values.ts'

/**
 * Entries that start the model's context (goblin's memory view, Pi's compaction summary and reset): they are written
 * for the model, so the transcript leaves them out.
 */
const MARKERS = new Set(['app.memory', 'pi.compaction', 'pi.reset'])

/**
 * Main's note that the owner started a thread with "+" (`app.thread_started`): the model reads its text, the
 * transcript shows a row for the thread it names instead.
 */
function threadStarted(entry: Record<string, unknown>): ChatMessage[] {
  const thread = record(entry.data)?.thread
  if (!isString(thread)) return []
  const note = records(entry.model)[0] ?? {}
  return [{ id: `${identifier(entry.id)}:0`, role: 'thread-started', thread, ...stamped(note) }]
}

const decodeHead = Schema.decodeUnknownOption(ThreadHeadData)
const decodeAnswer = Schema.decodeUnknownOption(PersonaAnswerData)
const decodeSeed = Schema.decodeUnknownOption(TopicSeedData)
const decodeResult = Schema.decodeUnknownOption(DelegateResultData)
const decodeAsk = Schema.decodeUnknownOption(PersonaAskData)
const decodeNotice = Schema.decodeUnknownOption(NoticeData)

/** The one message a decoded entry makes, or none when its data did not decode. */
const one = <A>(decoded: Option.Option<A>, message: (data: A) => ChatMessage): ChatMessage[] =>
  Option.match(decoded, { onNone: () => [], onSome: (data) => [message(data)] })

/** The data of an entry the shell draws itself, as its kind: its contract's shape, or nothing when it is not that. */
function drawnEntry(entry: Record<string, unknown>): ChatMessage[] | undefined {
  const id = `${identifier(entry.id)}:0`
  const at = stamped(records(entry.model)[0] ?? {})
  switch (entry.kind) {
    case 'app.thread_head':
      return one(decodeHead(entry.data), (head) => ({ id, role: 'thread-head', head, ...at }))
    case 'app.persona':
      return one(decodeAnswer(entry.data), (answer) => ({ id, role: 'persona', answer, ...at }))
    case 'app.topic_seed':
      return one(decodeSeed(entry.data), (seed) => ({ id, role: 'topic-seed', seed, ...at }))
    case 'app.delegate_result':
      return one(decodeResult(entry.data), (result) => ({ id, role: 'delegate-result', result, ...at }))
    case 'app.notice':
      return one(decodeNotice(entry.data), (notice) => ({ id, role: 'notice', notice, ...at }))
    default:
      return undefined
  }
}

/** The "[to @A, @B]" line the model reads before the owner's words to Personas; the transcript shows chips instead. */
const ASKED = /^\[to [^\]\n]*\]\s*/u

/** The owner's message to Personas (`app.persona_ask`): their words, with whom they asked and in what order. */
function personaAsk(entry: Record<string, unknown>): ChatMessage[] {
  return Option.match(decodeAsk(entry.data), {
    onNone: () => [],
    onSome: (ask) =>
      records(entry.model).flatMap((message, index) =>
        entryMessage(message, `${identifier(entry.id)}:${index}`).map((item) =>
          item.role === 'user' ? { ...item, text: item.text.replace(ASKED, ''), ask } : item,
        ),
      ),
  })
}

/**
 * What a passive note's kind adds to its message: a routine's report is the Routine's, and a decided call's outcome
 * kept for the next turn (`app.mcp_outcome`) says so, since no turn went on from it.
 */
function marked(kind: unknown, item: ChatMessage): ChatMessage {
  if (item.role !== 'user') return item
  if (kind === 'app.routine') return { ...item, author: 'Routine' }
  if (kind === 'app.mcp_outcome') return { ...item, kept: true }
  return item
}

/** Committed entries never change, so each one is projected once and reused while it stays in the transcript. */
const projected = new WeakMap<Record<string, unknown>, readonly ChatMessage[]>()
function messagesOf(entry: Record<string, unknown>): readonly ChatMessage[] {
  const cached = projected.get(entry)
  if (cached !== undefined) return cached
  if (MARKERS.has(identifier(entry.kind))) return []
  // Passive shared and routine notes name their registered source thread.
  const shared = entry.kind === 'app.shared' || entry.kind === 'app.routine' ? record(entry.data)?.thread : undefined
  const thread = isString(shared) ? shared : undefined
  let messages = drawnEntry(entry)
  if (messages === undefined && entry.kind === 'app.thread_started') messages = threadStarted(entry)
  if (messages === undefined && entry.kind === 'app.persona_ask') messages = personaAsk(entry)
  messages ??= records(entry.model).flatMap((message, index) =>
    entryMessage(message, `${identifier(entry.id)}:${index}`, thread).map((item) => marked(entry.kind, item)),
  )
  projected.set(entry, messages)
  return messages
}

/**
 * The entries a later entry's edits omit from the chat's context (a turn moved to a thread leaves only its head here):
 * the transcript leaves them out too.
 */
export function omittedEntries(entries: readonly Record<string, unknown>[]): ReadonlySet<number> {
  const omitted = new Set<number>()
  for (const entry of entries)
    for (const edit of records(entry.edits))
      if (edit.action === 'omit' && isNumber(edit.target)) omitted.add(edit.target)
  return omitted
}

/**
 * The messages of entries in transcript order: a snapshot's, or a page of history before it, without the entries
 * `omitted` names (by default those these entries' own edits omit).
 */
export function entryMessages(
  entries: readonly Record<string, unknown>[],
  omitted: ReadonlySet<number> = omittedEntries(entries),
): ChatMessage[] {
  return entries.flatMap((entry) => (isNumber(entry.id) && omitted.has(entry.id) ? [] : messagesOf(entry)))
}
