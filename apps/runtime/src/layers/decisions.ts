import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { Clef, workersClef } from '../decisions/client.ts'
import { makeDecisions } from '../decisions/live.ts'
import { Decisions } from '../decisions/service.ts'
import { piTranscripts } from '../retrieval/index.ts'
import { AgentInput } from '../runtime/input.ts'
import { auxReporter } from '../telemetry/report.ts'

/**
 * Clef through the Worker's `AI` binding (ADR 0031). Only the dev stage binds it (`apps/web/alchemy.run.ts`); a stage
 * without it (prod, the native test stacks) has an unavailable Clef, and decisions judge nothing there.
 */
const ClefLive: Layer.Layer<Clef, never, AgentInput> = Layer.effect(
  Clef,
  AgentInput.useSync(({ env }) => workersClef(env.AI)),
)

/**
 * Typed decisions (ADR 0031) over Clef, the agent's database and Pi's transcripts, each Clef call recorded as a
 * `model.aux` event of purpose `decision` and charged to the daily budget as `clef`.
 */
export const DecisionsLive = Layer.effect(
  Decisions,
  Effect.gen(function* () {
    const { harness, telemetry } = yield* AgentInput
    return yield* makeDecisions({ transcripts: piTranscripts(harness), report: auxReporter(telemetry, 'decision') })
  }),
).pipe(Layer.provide(ClefLive))
