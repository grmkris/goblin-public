import type { Extension } from '@earendil-works/pi-durable'
import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import { CredentialCipher } from '../mcp/cipher.ts'
import { askingExtension } from '../pi/ask-user.ts'
import { personaExtension } from '../pi/persona.ts'
import { routineBudgetExtension } from '../pi/routine-budget.ts'
import { routineRunExtension } from '../pi/routine-run.ts'
import type { RunProgram } from '../runtime/bridge.ts'
import { RoutineRuns } from './service.ts'

/**
 * The routines' Pi kit, made before Pi opens: the run task, `ask_user` and the routine budget gate, and the start of a
 * run's Pi work. Its Pi callbacks run their programs through the bridge `agent.ts` gives it.
 */
export function routineExtensions(run: RunProgram, resident: Extension, key: string) {
  const asking = askingExtension(async (session, callId, questions) => {
    const cipher = await CredentialCipher.fromBase64(key)
    await run(
      Effect.gen(function* () {
        const store = yield* RoutineRuns
        const at = yield* Clock.currentTimeMillis
        yield* store.ask(session, callId, questions, cipher, at)
      }),
    )
  })
  const budget = routineBudgetExtension(run)
  const task = routineRunExtension(run, [personaExtension, resident, asking, budget], key)
  return { start: task.start, extra: [task.extension, asking, budget] }
}
