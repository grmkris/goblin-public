import * as Alchemy from 'alchemy'
import * as Cloudflare from 'alchemy/Cloudflare'
import * as Test from 'alchemy/Test/Vitest'
import * as Config from 'effect/Config'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import { cases as conversationCases } from './conversation-checks.ts'
import { agentCases } from './native-agent.ts'
import { cases as appsCases } from './native-apps.ts'
import type { NativeCase } from './native-case.ts'
import { permutedCases } from './native-chats.ts'
import { cases as composerCases } from './native-composer.ts'
import { cases as conversationOpsCases } from './native-conversation-ops.ts'
import { cases as decisionsCases } from './native-decisions.ts'
import { cases as delegationCases } from './native-delegation.ts'
import { cases as filesCases } from './native-files.ts'
import { cases as mcpCases } from './native-mcp.ts'
import { cases as memoryCases } from './native-memory.ts'
import { routineCases } from './native-routines.ts'
import { cases as scopeCases } from './native-scopes.ts'
import { cases as telemetryCases } from './native-telemetry.ts'
import { cases as topicCases } from './native-topics.ts'
import Stack from './stack.ts'
import { cases as subagentCases } from './subagent-checks.ts'

const phase = await Effect.runPromise(
  Config.String('GOBLIN_NATIVE_LIFECYCLE_PHASE').pipe(
    Config.withDefault('same-process'),
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.Literals(['same-process', 'write', 'read']))),
  ),
)
const primaryProfile = await Effect.runPromise(Config.String('GOBLIN_PRIMARY_PROFILE').pipe(Config.withDefault('root')))
const harness = Test.make({
  providers: Cloudflare.providers(),
  state: Alchemy.localState(),
  // Ordinary runs must not wake alarms from previous fixtures. Explicit two-process proof retains its stage.
  stage: phase === 'same-process' ? `test_native_runtime_${process.pid}` : 'test_native_runtime',
  dev: true,
})
const stack = harness.beforeAll(harness.deploy(Stack))

/** Every native case: each probes a fresh agent of the one harness worker (`worker.ts`, `GET /probe/<name>`). */
const CASES: readonly NativeCase[] = [
  ...composerCases,
  ...routineCases(phase),
  ...filesCases,
  ...appsCases,
  ...telemetryCases,
  ...mcpCases,
  ...agentCases(phase),
  ...conversationCases,
  ...scopeCases,
  ...memoryCases,
  ...topicCases,
  ...subagentCases,
  ...delegationCases,
  ...(primaryProfile === 'permuted' ? permutedCases : []),
  ...conversationOpsCases,
  ...decisionsCases,
]

for (const { title, secondProcess, run } of CASES)
  harness.test(
    `local workerd${secondProcess ? ' process two' : ''}: ${title}`,
    stack.pipe(Effect.flatMap(({ url }) => Effect.promise(() => run(url.replace(/\/+$/u, ''))))),
  )
