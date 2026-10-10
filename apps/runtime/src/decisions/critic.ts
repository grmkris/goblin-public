import type { DecisionAction, DecisionProposal } from '@goblin/contracts'
import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import type { Budget } from '../budget.ts'
import type { TokenUse } from '../budget-credits.ts'
import type { AppError } from '../http/errors.ts'
import type { Resident } from '../mcp/service.ts'
import type { AuxCall } from '../telemetry/report.ts'
import { type Clef, type ClefError, clefFailed } from './client.ts'
import { chosen } from './questions.ts'
import { rules } from './rules.ts'
import type { Answers, DecisionCase } from './schema.ts'
import type { DecisionFence } from './store.ts'
import { decodeAnswers, packet, usageOf } from './wire.ts'

/** One thing the critic judges: the case it asks about, the action it would propose, and where and when it holds. */
export type Judgment = {
  /** The proposal's id, stable for what is judged (a relay, an exchange), so it is judged once. */
  readonly id: string
  readonly chatId: string
  readonly subject: string
  readonly case: DecisionCase
  readonly payload: DecisionAction
  readonly fence: DecisionFence
  /** Runtime questions, failures and approvals never enter attention ranking. */
  readonly ordinary: boolean
  /** Whether what was judged is still the chat's state, read again before a proposal is kept. */
  readonly current: Effect.Effect<boolean, AppError>
}

/** What the critic calls and charges: Clef, the daily budget, resident authority, and each call's aux record. */
export type CriticDeps = {
  readonly clef: Clef['Service']
  readonly budget: Budget['Service']
  readonly resident: Resident['Service']
  readonly report: (call: AuxCall) => void
}

/** What a judgment proposes: how sure it is, and the action (a context proposal keeps only its relevant sources). */
type Selected = { readonly probability: number; readonly payload: DecisionAction }

/** The frozen v4 thresholds (bench/reports/decisions-decisions-20261009-v4.md), Clef's for every judgment. */
const THRESHOLD = { attention: 0.5107, organization: 0.7503, context: 0.594 } as const

/** A question's answers, under its case-scoped name (a model's) or its own (the rules'). */
const answer = (item: Judgment, answers: Answers, question: string) =>
  answers[`${item.case.id}.${question}`] ?? answers[question]

/** How sure `distribution` is of `target`, when it chose it at `threshold` or above. */
const sure = (distribution: Readonly<Record<string, number>> | undefined, target: string, threshold: number) => {
  const probability = distribution?.[target] ?? 0
  return distribution !== undefined && chosen(distribution) === target && probability >= threshold
    ? probability
    : undefined
}

/** The candidates judged relevant at the frozen threshold, in their order; none when none is. */
function contextSelection(item: Judgment, answers: Answers): Selected | undefined {
  if (item.case.task !== 'context-relevance' || item.payload.type !== 'context') return undefined
  const kept = item.case.state.candidates.map((candidate) =>
    sure(answer(item, answers, candidate.id), 'yes', THRESHOLD.context),
  )
  const [first, ...rest] = item.payload.sources.filter((_source, index) => kept[index] !== undefined)
  if (first === undefined) return undefined
  return {
    probability: Math.max(...kept.flatMap((probability) => (probability === undefined ? [] : [probability]))),
    payload: { ...item.payload, sources: [first, ...rest] },
  }
}

/** What `answers` select for `item`: a highlight, a thread suggestion or relevant earlier work, or nothing. */
export const selection = (item: Judgment, answers: Answers): Selected | undefined => {
  if (item.case.task === 'context-relevance') return contextSelection(item, answers)
  const probability =
    item.case.task === 'attention-triage'
      ? sure(answer(item, answers, 'attention'), 'highlight', THRESHOLD.attention)
      : sure(answer(item, answers, 'organization'), 'suggest-thread', THRESHOLD.organization)
  return probability === undefined ? undefined : { probability, payload: item.payload }
}

/** What a dispatched call is charged when its usage is unknown: Clef's whole bounded context. */
const FULL_RESERVATION: TokenUse = { input: 65_536, output: 0, cacheRead: 0, cacheWrite: 0 }

const seconds = (millis: number) => Math.floor(millis / 1000)

/** One Clef call's `model.aux` record (ADR 0024): its timing, outcome and token counts, never what it judged. */
const reported = (deps: CriticDeps, startedAt: number, usage: TokenUse, failed: boolean) =>
  Effect.sync(() =>
    deps.report({
      startedAt,
      message: { provider: 'cloudflare', model: 'cloudflare/clef', stopReason: failed ? 'error' : 'stop', usage },
    }),
  )

/**
 * Clef's answers for `item`, every dispatched call charged as `clef`: its reported usage, or its whole reservation
 * when the answer does not say (or the call failed after dispatch). No binding makes no call and no charge.
 */
const modelAnswers = (deps: CriticDeps, item: Judgment, startedAt: number): Effect.Effect<Answers, ClefError> =>
  Effect.gen(function* () {
    const data = packet([item.case])
    const charge = (use: TokenUse) => deps.budget.record(use, seconds(startedAt), 'clef')
    const raw = yield* deps.clef
      .evaluate(data)
      .pipe(
        Effect.tapError((error) =>
          error.reason === 'unavailable'
            ? Effect.void
            : Effect.andThen(charge(FULL_RESERVATION), reported(deps, startedAt, FULL_RESERVATION, true)),
        ),
      )
    const use = yield* Effect.option(Effect.try({ try: () => usageOf(raw), catch: () => clefFailed('format') }))
    const known = Option.getOrUndefined(use)
    const tokens = known === undefined ? FULL_RESERVATION : { ...known, cacheRead: 0, cacheWrite: 0 }
    yield* charge(tokens)
    const answers = yield* Effect.try({
      try: () => decodeAnswers(raw, data.questions),
      catch: () => clefFailed('format'),
    }).pipe(Effect.tapError(() => reported(deps, startedAt, tokens, true)))
    yield* reported(deps, startedAt, tokens, false)
    return answers
  })

/**
 * The critic (ADR 0031): with resident authority and budget left, the state-only rules first, Clef only for a case
 * they leave undecided, then, for what is selected, a fresh look that the judged state is still current and authority
 * still holds. The proposal to keep, or none: `none` and `uncertain` are answers too.
 */
export const judge = (
  deps: CriticDeps,
  item: Judgment,
): Effect.Effect<DecisionProposal | undefined, AppError | ClefError> =>
  Effect.gen(function* () {
    const startedAt = yield* Clock.currentTimeMillis
    yield* deps.resident.require()
    yield* deps.budget.require(seconds(startedAt))
    const local = rules(item.case)
    const result = local.decided
      ? { answers: local.answers, provider: 'rules' as const }
      : { answers: yield* modelAnswers(deps, item, startedAt), provider: 'cloudflare/clef' as const }
    const selected = selection(item, result.answers)
    if (selected === undefined || item.case.task === 'brief-update') return undefined
    if (!(yield* item.current)) return undefined
    const endedAt = yield* Clock.currentTimeMillis
    yield* deps.resident.require()
    return {
      id: item.id,
      chatId: item.chatId,
      subject: item.subject,
      payload: selected.payload,
      kind: item.case.task,
      provider: result.provider,
      probability: selected.probability,
      state: 'open',
      createdAt: seconds(endedAt),
    }
  })
