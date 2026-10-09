import type { SubmissionRecord } from '@earendil-works/pi-durable'
import { describe, expect, it } from '@effect/vitest'
import { type FlowEvent, RunAttribute, type RunEvent } from '@goblin/contracts/telemetry'
import * as Effect from 'effect/Effect'
import * as TestClock from 'effect/testing/TestClock'
import { conversationId, entryId, submissionId } from '../src/pi/context.ts'
import { flowRunEvent } from '../src/telemetry/events.ts'
import { inspectionFixture } from './inspection-fixture.ts'

const DAY_MS = 24 * 60 * 60 * 1000
const NOW = 10 * DAY_MS

/** Runs `test` against a fresh fixture at `NOW`, closing its database after. */
const withInspection = <A, E>(
  test: (fixture: ReturnType<typeof inspectionFixture>) => Effect.Effect<A, E>,
  settled: Readonly<Record<string, SubmissionRecord>> = {},
) => {
  const fixture = inspectionFixture(settled)
  return TestClock.setTime(NOW).pipe(
    Effect.andThen(Effect.suspend(() => test(fixture))),
    Effect.ensuring(Effect.sync(fixture.close)),
  )
}

const step = (flow: FlowEvent['flow'], chat: string, status: FlowEvent['status'] = 'ok'): FlowEvent => ({
  flow,
  via: 'app',
  actor: 'owner',
  chat,
  operationId: `op-${flow}-${chat}`,
  status,
  ms: 5,
})

const ids = (page: { readonly flows: readonly FlowEvent[] }) => page.flows.map((flow) => flow.operationId)

describe('inspection of flows', () => {
  it.effect('reads the last day of flow steps, newest first, with when each was recorded', () =>
    withInspection(({ ledger, inspection }) =>
      Effect.gen(function* () {
        ledger.ended(flowRunEvent(step('send', '1'), 'flow:old', NOW - 2 * DAY_MS))
        ledger.ended(flowRunEvent(step('reply', '12'), 'flow:1', NOW - 300))
        ledger.ended(flowRunEvent(step('move', '12', 'refused'), 'flow:2', NOW - 200))
        expect(yield* inspection.flows({})).toEqual({
          since: NOW - DAY_MS,
          flows: [
            { ...step('move', '12', 'refused'), at: NOW - 200 },
            { ...step('reply', '12'), at: NOW - 300 },
          ],
        })
        const page = yield* inspection.run({ kind: 'flows', since: 0, limit: 1 })
        expect(page).toMatchObject({ flows: [{ flow: 'move' }] })
      }),
    ),
  )

  it.effect("filters by a chat's exact id and by flow", () =>
    withInspection(({ ledger, inspection }) =>
      Effect.gen(function* () {
        ledger.ended(flowRunEvent(step('reply', '12'), 'flow:1', NOW - 300))
        ledger.ended(flowRunEvent(step('reply', '123'), 'flow:2', NOW - 200))
        ledger.ended(flowRunEvent(step('move', '12'), 'flow:3', NOW - 100))
        expect(ids(yield* inspection.flows({ chat: '12' }))).toEqual(['op-move-12', 'op-reply-12'])
        expect(ids(yield* inspection.flows({ flow: 'reply' }))).toEqual(['op-reply-123', 'op-reply-12'])
        expect(ids(yield* inspection.flows({ chat: '12', flow: 'reply' }))).toEqual(['op-reply-12'])
        expect(ids(yield* inspection.flows({ chat: '7' }))).toEqual([])
      }),
    ),
  )
})

const turn: RunEvent = {
  id: 'turn:s1',
  kind: 'turn.submitted',
  status: 'ok',
  conversationId: '40',
  operationId: 'owner:op-1',
  startedAt: NOW - 1_000,
  endedAt: NOW - 500,
  attributes: {},
}
const answer: RunEvent = {
  id: 'model:t1:1:0',
  kind: 'model.attempt',
  status: 'ok',
  conversationId: '40',
  operationId: 'owner:op-1',
  taskId: 't1',
  startedAt: NOW - 900,
  endedAt: NOW - 600,
  attributes: { [RunAttribute.entry]: 31 },
}
const settled: SubmissionRecord = {
  id: submissionId(1),
  conversationId: conversationId('40'),
  requestId: 'owner:op-1',
  type: 'input',
  status: 'done',
  entry: entryId(30),
  answer: entryId(31),
}

describe('inspection of details', () => {
  it.effect("gives a turn's timeline with Pi's settlement, by its operation or by its answer's entry", () =>
    withInspection(
      ({ ledger, inspection }) =>
        Effect.gen(function* () {
          ledger.ended(turn)
          ledger.ended(answer)
          const byOperation = yield* inspection.details({ operation: 'owner:op-1' })
          expect(byOperation).toMatchObject({
            turn: { operationId: 'owner:op-1', modelAttempts: 1 },
            submission: { status: 'done', entry: 30, answer: 31 },
            events: [turn, answer],
            coverage: { complete: true, gaps: [] },
            related: [],
          })
          expect(yield* inspection.details({ chat: '12', entry: 31 })).toEqual(byOperation)
        }),
      { '40/owner:op-1': settled },
    ),
  )

  it.effect('links an operation to its parent and to what it caused, by the flow graph and by derived ids', () =>
    withInspection(({ ledger, inspection }) =>
      Effect.gen(function* () {
        ledger.ended(turn)
        // The thread the send started names it as parent; the Persona's answer derives its id from it.
        const start: FlowEvent = {
          flow: 'start',
          via: 'app',
          actor: 'owner',
          chat: '12',
          operationId: 'owner:op-2',
          parentOperation: 'owner:op-1',
          status: 'ok',
        }
        ledger.ended(flowRunEvent(start, 'flow:1', NOW - 400))
        ledger.ended({ ...turn, id: 'turn:s2', operationId: 'persona:owner:op-1:3' })
        ledger.ended({ ...turn, id: 'turn:s3', operationId: 'owner:op-2:first' })

        const { related } = yield* inspection.details({ operation: 'owner:op-1' })
        expect(related).toEqual([
          { operation: 'owner:op-2', kind: 'start', chat: '12', state: 'ok' },
          { operation: 'persona:owner:op-1:3', kind: 'persona_answer' },
        ])
        // A step with no turn has its own timeline, without a turn, and is linked both ways.
        const thread = yield* inspection.details({ operation: 'owner:op-2' })
        expect(thread).toMatchObject({ coverage: { complete: true }, events: [{ kind: 'flow' }] })
        expect(thread.turn).toBeUndefined()
        expect(thread.related.map((link) => [link.operation, link.kind])).toEqual([
          ['owner:op-1', 'operation'],
          ['owner:op-2:first', 'send'],
        ])
        expect((yield* inspection.details({ operation: 'owner:op-2:first' })).related).toMatchObject([
          { operation: 'owner:op-2', kind: 'start' },
        ])
      }),
    ),
  )

  it.effect('refuses a query naming neither an operation nor a chat entry, and finds nothing unknown', () =>
    withInspection(({ inspection }) =>
      Effect.gen(function* () {
        expect(yield* Effect.flip(inspection.run({ kind: 'details', chat: '12' }))).toMatchObject({
          _tag: 'InvalidInput',
        })
        expect(yield* Effect.flip(inspection.details({ operation: 'missing' }))).toMatchObject({
          _tag: 'NotFound',
          what: 'operation',
        })
        expect(yield* Effect.flip(inspection.details({ chat: '12', entry: 4 }))).toMatchObject({
          _tag: 'NotFound',
          what: 'entry operation',
        })
        expect(yield* Effect.flip(inspection.details({ chat: '7', entry: 4 }))).toMatchObject({
          _tag: 'NotFound',
          what: 'conversation',
        })
        expect(yield* Effect.flip(inspection.turn('missing'))).toMatchObject({ _tag: 'NotFound', what: 'turn' })
      }),
    ),
  )
})
