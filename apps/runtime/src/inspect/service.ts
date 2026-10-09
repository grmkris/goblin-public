import type { SubmissionRecord } from '@earendil-works/pi-durable'
import type {
  InspectConversations,
  InspectDetails,
  InspectDetailsArguments,
  InspectDetailsInput,
  InspectEntries,
  InspectFlows,
  InspectFlowsInput,
  InspectInput,
  InspectKind,
  InspectProblems,
  InspectQuery,
  InspectResult,
  InspectTurns,
  TurnTimeline,
} from '@goblin/contracts/inspect'
import type { RunEvent } from '@goblin/contracts/telemetry'
import * as Clock from 'effect/Clock'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { Conversations } from '../chats/service.ts'
import { type AppError, InvalidInput, NotFound, toAppError } from '../http/errors.ts'
import { BACKGROUND, conversationId } from '../pi/context.ts'
import { AgentInput } from '../runtime/input.ts'
import { Db } from '../runtime/db.ts'
import { RunLedger } from '../telemetry/ledger.ts'
import { coverageGaps, operationGaps } from './coverage.ts'
import { flowRecord, inspectEntry, relatedOf, settlementOf, summarize } from './inspector.ts'

/** What a query of `kind` takes besides its kind. */
type Input<K extends InspectKind> = (typeof InspectInput)[K]['Type']

/** What any inspection query answers: the result of its kind. */
type InspectAnswer = { readonly [K in InspectKind]: (typeof InspectResult)[K]['Type'] }[InspectKind]

/** What `turns`, `problems` and `flows` look back over by default. */
const DAY_MS = 24 * 60 * 60 * 1000
/** Newer than any entry: the newest page of a conversation. */
const NEWEST = 2 ** 31
const TURNS = 20
const PROBLEMS = 50
const FLOWS = 50

/**
 * Read-only inspection of this agent (ADR 0024): Pi for content and settlement, the run ledger for how each turn and
 * each conversation flow ran. No read changes the agent or calls a model; a turn, conversation or operation that is not
 * there is `NotFound`, and a details query that names neither an operation nor a chat entry is `InvalidInput`.
 */
export class Inspection extends Context.Service<
  Inspection,
  {
    /** Any query, as the agent's `/inspect` route (and so /mcp's `inspect_*` tools) asks it. */
    readonly run: (query: InspectQuery) => Effect.Effect<InspectAnswer, AppError>
    /** Every conversation the agent keeps (main, threads, subagents, clients), with titles and activity. */
    readonly conversations: Effect.Effect<InspectConversations, AppError>
    /** A page of a conversation's entries, oldest first, ending before `before` (the newest page without it). */
    readonly conversation: (input: Input<'conversation'>) => Effect.Effect<InspectEntries, AppError>
    /** Turns since `since` (the last day by default), newest first, optionally of one conversation. */
    readonly turns: (input: Input<'turns'>) => Effect.Effect<InspectTurns, AppError>
    /** One turn end to end: its summary, Pi's settlement, every run event and what the timeline cannot show. */
    readonly turn: (operationId: string) => Effect.Effect<TurnTimeline, AppError>
    /** Events needing attention since `since`, newest first; `all` includes expected waits and recovered attempts. */
    readonly problems: (input: Input<'problems'>) => Effect.Effect<InspectProblems, AppError>
    /** Conversation flow steps since `since`, newest first, optionally of one chat or one flow. */
    readonly flows: (input: InspectFlowsInput) => Effect.Effect<InspectFlows, AppError>
    /**
     * The details behind a message: the timeline of its operation (with its turn when it ran one) and the operations
     * related to it. A chat entry names the operation whose model answer or tool result it is.
     */
    readonly details: (input: InspectDetailsInput) => Effect.Effect<InspectDetails, AppError>
  }
>()('goblin/inspect/Inspection') {
  /** Over the run ledger in the agent's SQLite, its registered chats and Pi's own settlements. */
  static readonly layer: Layer.Layer<Inspection, never, Db | Conversations | AgentInput> = Layer.effect(
    Inspection,
    Effect.gen(function* () {
      const db = yield* Db
      const chats = yield* Conversations
      const { harness } = yield* AgentInput
      return makeInspection({
        ledger: new RunLedger(db),
        chats,
        settlement: (session, operationId) =>
          Effect.tryPromise({
            try: async () =>
              (await harness.pi()).commit(
                (tx) => tx.submissionByRequest(conversationId(session), operationId),
                BACKGROUND,
              ),
            catch: toAppError,
          }),
      })
    }),
  )
}

/** What inspection reads: the run ledger, the registered chats and Pi's settlement of one submission. */
export interface InspectionSources {
  readonly ledger: Pick<
    RunLedger,
    | 'forOperation'
    | 'forOperations'
    | 'turns'
    | 'problems'
    | 'flows'
    | 'operationOfEntry'
    | 'childFlows'
    | 'operationsStarting'
  >
  readonly chats: Pick<(typeof Conversations)['Service'], 'list' | 'require' | 'history'>
  /** The submission `operationId` names in Pi session `session`, if Pi has it. */
  readonly settlement: (session: string, operationId: string) => Effect.Effect<SubmissionRecord | undefined, AppError>
}

/** A ledger read; stored data that no longer decodes is our fault, reported and answered as `Internal`. */
const read = <A>(ledgerRead: () => A): Effect.Effect<A, AppError> => Effect.try({ try: ledgerRead, catch: toAppError })

/** `since` as given, or a day before now. */
const sinceOr = (since: number | undefined): Effect.Effect<number> =>
  since === undefined ? Effect.map(Clock.currentTimeMillis, (now) => now - DAY_MS) : Effect.succeed(since)

/** A details query's reader input: an operation, or a chat with one of its entries. Anything else is invalid. */
const detailsInput = ({
  operation,
  chat,
  entry,
}: InspectDetailsArguments): Effect.Effect<InspectDetailsInput, AppError> => {
  if (operation !== undefined) return Effect.succeed({ operation })
  if (chat !== undefined && entry !== undefined) return Effect.succeed({ chat, entry })
  return Effect.fail(new InvalidInput({ reason: 'details take an operation, or a chat and an entry' }))
}

type Reads = (typeof Inspection)['Service']

/** A turn's timeline: its summary, Pi's settlement of it, its events and what they cannot show. */
const timelineWith = (settlement: InspectionSources['settlement']) =>
  Effect.fn('Inspection.timeline')(function* (turn: RunEvent, events: readonly RunEvent[]) {
    const operationId = turn.operationId ?? turn.id
    const record = turn.conversationId === undefined ? undefined : yield* settlement(turn.conversationId, operationId)
    const submission = settlementOf(record)
    const gaps = coverageGaps(turn, events, submission)
    return {
      turn: summarize(turn, events),
      ...(submission === undefined ? {} : { submission }),
      events,
      coverage: { complete: gaps.length === 0, gaps },
    }
  })

/**
 * The details behind a message: the operation it names, or the one whose answer or tool result the entry is, with its
 * timeline (a turn's, or only its steps when it ran none) and the operations related to it.
 */
const detailsWith = ({ ledger, chats, settlement }: InspectionSources): Reads['details'] => {
  const timeline = timelineWith(settlement)
  const operationOfEntry = Effect.fn('Inspection.operationOfEntry')(function* (chat: string, entry: number) {
    const session = yield* chats.require(chat)
    const operation = yield* read(() => ledger.operationOfEntry(session, entry))
    if (operation === undefined) return yield* new NotFound({ what: 'entry operation' })
    return operation
  })
  return Effect.fn('Inspection.details')(function* (input: InspectDetailsInput) {
    const operationId = 'operation' in input ? input.operation : yield* operationOfEntry(input.chat, input.entry)
    const events = yield* read(() => ledger.forOperation(operationId))
    const related = yield* read(() => relatedOf(ledger, operationId, events))
    const submitted = events.find((event) => event.kind === 'turn.submitted')
    if (submitted !== undefined) return { ...(yield* timeline(submitted, events)), related }
    if (events.length === 0 && related.length === 0) return yield* new NotFound({ what: 'operation' })
    const gaps = operationGaps(events)
    return { events, coverage: { complete: gaps.length === 0, gaps }, related }
  })
}

/** Any query, answered by the read of its kind. */
const dispatch =
  (reads: Omit<Reads, 'run'>): Reads['run'] =>
  (query) => {
    switch (query.kind) {
      case 'conversations':
        return reads.conversations
      case 'conversation':
        return reads.conversation(query)
      case 'turns':
        return reads.turns(query)
      case 'turn':
        return reads.turn(query.operationId)
      case 'problems':
        return reads.problems(query)
      case 'flows':
        return reads.flows(query)
      case 'details':
        return Effect.flatMap(detailsInput(query), reads.details)
    }
  }

/** The inspection reads over `sources`; the native layer's, and a test's over fakes. */
export function makeInspection(sources: InspectionSources): Reads {
  const { ledger, chats, settlement } = sources
  const timeline = timelineWith(settlement)
  const reads: Omit<Reads, 'run'> = {
    conversations: Effect.map(chats.list, (list) => ({ conversations: list })).pipe(
      Effect.withSpan('Inspection.conversations'),
    ),
    conversation: Effect.fn('Inspection.conversation')(function* (input: Input<'conversation'>) {
      const page = yield* chats.history(input.conversation, input.before ?? NEWEST)
      const first = page.entries[0]
      return {
        conversation: input.conversation,
        entries: page.entries.map(inspectEntry),
        ...(page.more && first !== undefined ? { before: Number(first.id) } : {}),
      }
    }),
    turns: Effect.fn('Inspection.turns')(function* (input: Input<'turns'>) {
      const session = input.conversation === undefined ? undefined : yield* chats.require(input.conversation)
      const since = yield* sinceOr(input.since)
      return yield* read(() => {
        const found = ledger.turns(since, input.limit ?? TURNS, session)
        const events = ledger.forOperations(found.flatMap((turn) => turn.operationId ?? []))
        const own = (turn: RunEvent) => events.filter((event) => event.operationId === turn.operationId)
        return { turns: found.map((turn) => summarize(turn, own(turn))) }
      })
    }),
    turn: Effect.fn('Inspection.turn')(function* (operationId: string) {
      const events = yield* read(() => ledger.forOperation(operationId))
      const submitted = events.find((event) => event.kind === 'turn.submitted')
      if (submitted === undefined) return yield* new NotFound({ what: 'turn' })
      return yield* timeline(submitted, events)
    }),
    problems: Effect.fn('Inspection.problems')(function* (input: Input<'problems'>) {
      const since = yield* sinceOr(input.since)
      return { since, problems: yield* read(() => ledger.problems(since, input.limit ?? PROBLEMS, input.all === true)) }
    }),
    flows: Effect.fn('Inspection.flows')(function* (input: InspectFlowsInput) {
      const since = yield* sinceOr(input.since)
      const steps = yield* read(() => ledger.flows(since, input.limit ?? FLOWS, input))
      return { since, flows: steps.flatMap((event) => flowRecord(event) ?? []) }
    }),
    details: detailsWith(sources),
  }
  return Inspection.of({ run: dispatch(reads), ...reads })
}
