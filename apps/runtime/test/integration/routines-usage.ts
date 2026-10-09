import { UsageDoc } from '@earendil-works/pi-durable'
import type { PersonalAgent } from '../../src/agent.ts'
import { drizzle } from 'drizzle-orm/durable-sqlite'
import type { RoutineDefinition } from '@goblin/contracts'
import { RoutineRunStore } from '../../src/routines/runs.ts'
import { RoutineUsage } from '../../src/routines/usage.ts'
import { DEFAULT_RATES } from '../../src/budget-credits.ts'
import { BACKGROUND, conversationId } from '../../src/pi/context.ts'
import { unwrap } from '../../src/http/rpc.ts'
import type { SeenRequest } from './model.ts'
import { changeRoutine, proposeRoutine, runRoutineNow } from './routines-owner.ts'

async function waitFor(store: RoutineRunStore, id: string, state: string) {
  // Native Pi settles a blocked provider after its bounded retry schedule (up to ~16 s).
  // Observe that terminal state rather than racing it with the old five-second fixture deadline.
  for (let index = 0; index < 2500; index += 1) {
    if (store.get(id).state === state) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`Routine usage fixture did not reach ${state}`)
}
async function start(agent: PersonalAgent, prompt: string, operation: string) {
  const definition: RoutineDefinition = {
    title: `Native slow routine ${operation}`,
    prompt,
    timezone: 'UTC',
    trigger: { kind: 'once', at: new Date(Date.now() + 3_600_000).toISOString() },
    notifyTelegram: false,
    allowedTools: [],
    budget: { tokensPerRun: 1000, tokensPerDay: 2000, runtimeSeconds: 60 },
  }
  const draft = await proposeRoutine(agent, definition, `${operation}-propose`)
  await changeRoutine(agent, draft.id, { revision: 1, operationId: `${operation}-confirm` }, 'confirm')
  return runRoutineNow(agent, draft.id, 1, `${operation}-run`)
}

/** Actual native compaction spend, cumulative replay, UTC-day delta receipts and measured in-flight cap overshoot. */
export async function routineUsageProbe(
  storage: DurableObjectStorage,
  agent: PersonalAgent,
  seen: readonly SeenRequest[],
) {
  const db = drizzle(storage)
  const store = new RoutineRunStore(db, agent.name)
  const run = await start(
    agent,
    'call ask_user {"questions":[{"id":"usage","prompt":"Continue?","kind":"text"}]}',
    'usage',
  )
  await waitFor(store, run.id, 'waiting_owner')
  const session = store.get(run.id).sessionId
  if (!session) throw new Error('Usage fixture session missing')
  const pi = await agent.harness.pi()
  const child = await pi.conversation(conversationId(session), BACKGROUND)
  if (!child) throw new Error('Usage fixture Pi conversation missing')
  await child.submit(
    {
      type: 'write',
      requestId: 'usage-fixture-context',
      entry: {
        kind: 'app.fixture-usage',
        data: {},
        model: [{ role: 'user', content: 'Bounded fixture history. '.repeat(5000), timestamp: Date.now() }],
      },
    },
    BACKGROUND,
  )
  unwrap(await agent.submit(session, 'Continue with Native slow routine.', 'usage-answer'))
  const task = await child.compact(undefined, BACKGROUND)
  pi.resume()
  const compacted = await pi.waitForTask(task, BACKGROUND)
  await waitFor(store, run.id, 'completed')
  const used = store.used(run.id, Date.now()).run
  const projection = new RoutineUsage(db, store, DEFAULT_RATES, agent.harness)
  const snapshot = await pi.snapshot(UsageDoc, child.id, BACKGROUND)
  projection.project(session, snapshot, Date.now() + 86_400_000)
  projection.project(session, snapshot, Date.now() + 86_400_000)
  const afterReplay = store.used(run.id, Date.now()).run
  const capped = await start(agent, 'call mcp_list {}', 'overshoot')
  await waitFor(store, capped.id, 'running')
  store.recordUsage(capped.id, 'fixture-previous-usage', 995, 0, Date.now())
  await waitFor(store, capped.id, 'failed')
  const capRequests = seen.filter((request) =>
    request.messages.some((message) => message.text.includes('Confirmed routine: Native slow routine overshoot')),
  )
  const spent = store.used(capped.id, Date.now()).run
  return {
    compactionStatus: compacted.state.outcome.status,
    compactedTokens: used,
    afterReplay,
    nextDay: store.used(run.id, Date.now() + 86_400_000).day,
    capState: store.get(capped.id).state,
    overshoot: spent - 1000,
    capModelRequests: capRequests.length,
  }
}
