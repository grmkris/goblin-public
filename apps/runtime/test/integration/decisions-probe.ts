import { PRIMARY_CHAT } from '@goblin/contracts'
import { drizzle } from 'drizzle-orm/durable-sqlite'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as ManagedRuntime from 'effect/ManagedRuntime'
import { Budget } from '../../src/budget.ts'
import { chatSession } from '../../src/chats/directory.ts'
import { ownerYield } from '../../src/decisions/candidates.ts'
import { Clef, workersClef } from '../../src/decisions/client.ts'
import { makeDecisions } from '../../src/decisions/live.ts'
import { Decisions } from '../../src/decisions/service.ts'
import { listProposals, storedProposal } from '../../src/decisions/store.ts'
import { BudgetExhausted } from '../../src/http/errors.ts'
import { ResidentLive } from '../../src/layers/core.ts'
import { FlowEvents } from '../../src/observability/flows.ts'
import { KeyedLock } from '../../src/observability/lock.ts'
import { SingleFlight } from '../../src/observability/single-flight.ts'
import { PiSessions } from '../../src/pi/sessions.ts'
import { piTranscripts } from '../../src/retrieval/index.ts'
import { Changes, makeChanges } from '../../src/runtime/changes.ts'
import { Db } from '../../src/runtime/db.ts'
import { AgentInput } from '../../src/runtime/input.ts'
import { appDecisionLabels } from '../../src/storage/decision-schema.ts'
import { type Inside, type Probes, inAgent } from './probe.ts'
import { ownerResult, ownerSend } from './probe-reads.ts'

/** Clef as the probe plays it: sure of a highlight, counting its calls; `stale` moves main on while it judges. */
type ClefScript = { calls: number; stale: boolean; exhausted: boolean; charged: number }

/**
 * The real decisions over the object's own SQLite and Pi, with the probe's Clef and budget: what the agent builds with
 * a bound `AI`, which the native stack does not bind (no paid call leaves it).
 */
function decisionsOver(inside: Inside, script: ClefScript, clef?: Clef['Service']) {
  const db = drizzle(inside.storage)
  const played = Clef.of({
    available: true,
    evaluate: (data) =>
      Effect.sync(() => {
        script.calls += 1
        if (script.stale)
          inside.storage.sql.exec("UPDATE app_conversations SET epoch = epoch + 1 WHERE session_id = '1'")
        return {
          usage: { input_tokens: 1000, output_tokens: 0 },
          answers: Object.fromEntries(
            Object.entries(data.questions).map(([id, question]) => [
              id,
              {
                probabilities: Object.fromEntries(
                  question.options.map((option) => [option, option === 'highlight' ? 0.85 : 0.05]),
                ),
              },
            ]),
          ),
        }
      }),
  })
  const dbLayer = Layer.succeed(Db, db)
  const services = Layer.mergeAll(
    dbLayer,
    Layer.succeed(Changes, makeChanges()),
    Layer.succeed(Clef, clef ?? played),
    SingleFlight.layer,
    KeyedLock.layer,
    FlowEvents.noop,
    ResidentLive.pipe(Layer.provide(dbLayer)),
    Layer.mock(Budget)({
      require: () =>
        Effect.suspend(() =>
          script.exhausted ? Effect.fail(new BudgetExhausted({ limit: 0, resetsAt: 0 })) : Effect.void,
        ),
      record: (use) => Effect.sync(() => void (script.charged += use.input)),
    }),
    // SAFETY: PiSessions reads only the agent's harness from its input.
    PiSessions.layer.pipe(Layer.provide(Layer.succeed(AgentInput, { harness: inside.harness } as never))),
  )
  const transcripts = piTranscripts(inside.harness)
  return ManagedRuntime.make(
    Layer.effect(Decisions, makeDecisions({ transcripts, report: () => undefined })).pipe(Layer.provideMerge(services)),
  )
}

/**
 * Typed decisions in a live object (ADR 0031): after a real owner turn, a Delegate report is judged once per relay,
 * labelled through the owner API (the first label wins), a result the chat moved past is discarded, a spent budget
 * makes no call, and no Clef makes nothing. The owner's exchange is judged on its evidence, and main still answers.
 */
async function decisionsProbe(inside: Inside) {
  const { api, agent } = inside
  await ownerSend(api, PRIMARY_CHAT, 'Compare trip options', 'decisions-focus')
  await agent.settle(PRIMARY_CHAT, 'decisions-focus')
  const script: ClefScript = { calls: 0, stale: false, exhausted: false, charged: 0 }
  const runtime = decisionsOver(inside, script)
  const session = chatSession(drizzle(inside.storage), PRIMARY_CHAT)
  const report = (relayId: string, text = 'The comparison adds useful evidence about the trip.') =>
    runtime.runPromise(Decisions.use((decisions) => decisions.afterReport({ session, relayId, text, complete: true })))
  const label = (id: string, as: 'confirm' | 'dismiss') =>
    ownerResult(api, (owner) => owner.decisions.label({ params: { id }, payload: { label: as } }))
  try {
    await report('native-relay')
    await report('native-relay')
    const once = script.calls === 1
    const confirmed = await label('dp_report_native-relay', 'confirm')
    const replay = await label('dp_report_native-relay', 'confirm')
    const opposite = await label('dp_report_native-relay', 'dismiss')
    await report('native-dismiss')
    const dismissed = await label('dp_report_native-dismiss', 'dismiss')
    script.stale = true
    await report('native-stale')
    script.stale = false
    script.exhausted = true
    const beforeBudget = script.calls
    await report('native-budget')
    const noBudgetCall = script.calls === beforeBudget
    script.exhausted = false
    const unbound = decisionsOver(inside, script, workersClef(undefined))
    const beforeUnbound = script.calls
    await unbound.runPromise(
      Decisions.use((decisions) =>
        decisions.afterReport({
          session,
          relayId: 'native-unbound',
          text: 'The flight is cancelled tonight.',
          complete: true,
        }),
      ),
    )
    await unbound.dispose()
    const db = drizzle(inside.storage)
    const [work] = await runtime.runPromise(
      Effect.gen(function* () {
        const deps = {
          index: { db, source: piTranscripts(inside.harness) },
          pi: yield* PiSessions,
          lock: yield* KeyedLock,
        }
        return yield* ownerYield(deps, session)
      }),
    )
    await ownerSend(api, PRIMARY_CHAT, 'Chat still works', 'decisions-chat-proof')
    const answer = await agent.settle(PRIMARY_CHAT, 'decisions-chat-proof')
    return {
      once,
      confirmed,
      replay,
      opposite,
      dismissed,
      staleDiscarded: storedProposal(db, 'dp_report_native-stale') === undefined,
      noBudgetCall,
      unboundIdle: script.calls === beforeUnbound && storedProposal(db, 'dp_report_native-unbound') === undefined,
      charged: script.charged,
      ownerCandidate: work?.case.task === 'separate-work',
      evidenceFence: work?.fence.evidence?.startsWith('sha256:') === true,
      labels: db.select().from(appDecisionLabels).all(),
      retained: listProposals(db),
      chatAnswer: answer.text ?? '',
    }
  } finally {
    await runtime.dispose()
  }
}

export const probes: Probes = { decisions: inAgent(decisionsProbe) }
