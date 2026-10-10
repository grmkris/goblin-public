import type { DecisionLabel, DecisionProposal } from '@goblin/contracts'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import { Budget } from '../budget.ts'
import { chatOfSession } from '../chats/directory.ts'
import { epochSeconds } from '../clock.ts'
import { Conflict, NotFound, attempt, attemptSync } from '../http/errors.ts'
import { Resident } from '../mcp/service.ts'
import { FlowEvents, failedFlow, withFlow } from '../observability/flows.ts'
import { KeyedLock } from '../observability/lock.ts'
import { reportAndRecover } from '../observability/report.ts'
import { SingleFlight } from '../observability/single-flight.ts'
import { PiSessions } from '../pi/sessions.ts'
import { type TranscriptSource, latestInput, recordUse } from '../retrieval/index.ts'
import { Changes } from '../runtime/changes.ts'
import { Db } from '../runtime/db.ts'
import type { AuxCall } from '../telemetry/report.ts'
import { type CandidateDeps, type DelegateReport, delegateReport, ownerYield, stillCurrent } from './candidates.ts'
import { Clef } from './client.ts'
import { chosenText } from './context.ts'
import { type CriticDeps, type Judgment, judge } from './critic.ts'
import { Decisions } from './service.ts'
import {
  addProposal,
  chosenContextProposal,
  decideProposal,
  listProposals,
  staleProposal,
  storedProposal,
} from './store.ts'

/**
 * What decisions are made over besides the agent's services: Pi's transcripts as the index reads them, and each Clef
 * call's `model.aux` record.
 */
export type DecisionsOwn = {
  readonly transcripts: TranscriptSource
  readonly report: (call: AuxCall) => void
}

/** What every part of the service works with: the candidates' sources, the flows, and the change bus's notice. */
type Parts = {
  readonly deps: CandidateDeps
  readonly flows: FlowEvents['Service']
  readonly changed: (id: string) => Effect.Effect<void>
}

/** How long earlier work the owner chose to use stays in a chat's requests. */
const CHOSEN_SECONDS = 24 * 60 * 60

/** The state a proposal settles in under `label`. */
const settledAs = (label: DecisionLabel['label']) => (label === 'confirm' ? 'confirmed' : 'dismissed')

/** How the owner's label settled a proposal: as it is now, and whether an earlier label had settled it so already. */
type Labelled = { readonly proposal: DecisionProposal; readonly replayed: boolean }

const PROPOSED = { flow: 'decision_propose', via: 'system', actor: 'agent' } as const

/**
 * Judges `item` unless it is a runtime fact or was judged already, at most once at a time (a judgment in flight is not
 * joined again), and keeps what the critic proposes, once, telling the feed.
 */
const considering = ({ deps, flows, changed }: Parts, critic: CriticDeps, flights: SingleFlight['Service']) => {
  const { db } = deps.index
  const keep = (proposal: DecisionProposal, item: Judgment) =>
    Effect.gen(function* () {
      const written = yield* attemptSync(() => addProposal(db, proposal, item.fence))
      if (!written.changed) return
      yield* changed(written.proposal.id)
      yield* flows.record({ ...PROPOSED, chat: proposal.chatId, status: 'ok' })
    })
  return (item: Judgment) =>
    Effect.gen(function* () {
      if (!item.ordinary || (yield* attemptSync(() => storedProposal(db, item.id))) !== undefined) return
      const judged = Effect.flatMap(judge(critic, item), (proposal) =>
        proposal === undefined ? Effect.void : keep(proposal, item),
      ).pipe(Effect.tapError((error) => flows.record({ ...PROPOSED, chat: item.chatId, ...failedFlow(error) })))
      yield* flights.skip(`decision:${item.id}`, judged)
    })
}

/** The owner's label of proposal `id`: the first one wins, and a proposal whose chat moved on goes stale. */
const settling = ({ deps, changed }: Parts) =>
  Effect.fn('Decisions.label')(function* (id: string, label: DecisionLabel['label']) {
    const { db } = deps.index
    const found = yield* attemptSync(() => storedProposal(db, id))
    if (found === undefined) return yield* new NotFound({ what: 'decision proposal' })
    const { proposal, fence } = found
    if (proposal.state !== 'open') {
      if (proposal.state === settledAs(label)) return { proposal, replayed: true } satisfies Labelled
      return yield* new Conflict({ reason: 'settled' })
    }
    if (!(yield* stillCurrent(deps, proposal.chatId, fence))) {
      const now = yield* epochSeconds
      if ((yield* attemptSync(() => staleProposal(db, id, now)))?.changed === true) yield* changed(id)
      return yield* new Conflict({ reason: 'stale' })
    }
    const now = yield* epochSeconds
    const decided = yield* attemptSync(() => decideProposal(db, id, label, now))
    if (decided === undefined) return yield* new NotFound({ what: 'decision proposal' })
    if (decided.changed) yield* changed(id)
    if (decided.proposal.state !== settledAs(label)) return yield* new Conflict({ reason: 'settled' })
    return { proposal: decided.proposal, replayed: !decided.changed } satisfies Labelled
  })

/** The earlier work the owner chose to use in the chat of a session, recorded once for each owner message it serves. */
const choosing = ({ deps }: Parts) =>
  Effect.fn('Decisions.chosenContext')(function* (session: string) {
    const { db, source } = deps.index
    const chat = yield* attemptSync(() => chatOfSession(db, session))
    if (chat === undefined) return Option.none()
    const now = yield* epochSeconds
    const chosen = yield* attemptSync(() => chosenContextProposal(db, chat, now - CHOSEN_SECONDS))
    if (chosen?.payload.type !== 'context') return Option.none()
    const { inputEntry, sources } = chosen.payload
    const input = yield* attempt(() => latestInput(source, session, now))
    if (input !== undefined && input.entry > inputEntry) {
      const use = { id: `decision:${chosen.id}:${input.entry}`, chat, session, inputEntry: input.entry }
      yield* attemptSync(() => recordUse(db, { ...use, mode: 'auto', sources, retrievedAt: now }))
    }
    return Option.some(chosenText(sources))
  })

/**
 * The `Decisions` service over the agent's database, Pi, Clef, the daily budget and resident authority (ADR 0031). A
 * judgment runs at most once at a time per proposal (`SingleFlight`), a catch-up of the transcript index under its
 * session's turn of the `KeyedLock`, and every proposal made, labelled or made stale is told to the change bus.
 * Nothing holds a transaction across a Pi read or a Clef call.
 */
export const makeDecisions = (own: DecisionsOwn) =>
  Effect.gen(function* () {
    const db = yield* Db
    const changes = yield* Changes
    const flows = yield* FlowEvents
    const clef = yield* Clef
    const parts: Parts = {
      deps: { index: { db, source: own.transcripts }, pi: yield* PiSessions, lock: yield* KeyedLock },
      flows,
      changed: (id) => changes.publish('decisions.changed', { ids: [id] }),
    }
    const critic = { clef, budget: yield* Budget, resident: yield* Resident, report: own.report }
    const consider = considering(parts, critic, yield* SingleFlight)
    const settle = settling(parts)
    const afterYield = Effect.fn('Decisions.afterYield')(function* (session: string) {
      if (!clef.available) return
      for (const item of yield* ownerYield(parts.deps, session)) yield* consider(item)
    })
    const afterReport = Effect.fn('Decisions.afterReport')(function* (report: DelegateReport) {
      if (!clef.available) return
      const item = yield* delegateReport(parts.deps, report)
      if (item !== undefined) yield* consider(item)
    })
    return Decisions.of({
      afterYield: (session) => afterYield(session).pipe(reportAndRecover('decisions.afterYield', undefined)),
      afterReport: (report) => afterReport(report).pipe(reportAndRecover('decisions.afterReport', undefined)),
      label: (id, label) =>
        settle(id, label).pipe(
          withFlow(
            { flow: label === 'confirm' ? 'decision_confirm' : 'decision_dismiss', via: 'app', actor: 'owner' },
            ({ proposal, replayed }) => ({
              chat: proposal.chatId,
              ...(replayed ? { status: 'replayed' as const } : {}),
            }),
          ),
          Effect.provideService(FlowEvents, flows),
          Effect.map(({ proposal }) => proposal),
        ),
      chosenContext: choosing(parts),
      list: attemptSync(() => listProposals(db)),
      view: Effect.fn('Decisions.view')(function* (id: string) {
        const found = yield* attemptSync(() => storedProposal(db, id))
        if (found === undefined) return yield* new NotFound({ what: 'decision proposal' })
        return found.proposal
      }),
    })
  })
