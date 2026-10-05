import { Effect, FileSystem, Result, Schema } from 'effect'
import { join } from 'node:path'
import { Answer } from '../src/schema.ts'
import { ProbeResult, publicEvents, type ReplayEvent } from '../src/protocol.ts'
import type { Resolved, Trace } from '../src/results.ts'
import { validDelivery } from '../src/evaluate.ts'
import { exceededReservation } from '../src/budget.ts'
import { digest } from './identity.ts'
import type { relay } from './relay.ts'
import { post } from './native.ts'
import { fail, readJson, writeJson, json } from './store.ts'

type Provider = Effect.Success<ReturnType<typeof relay>>
const Receipt = Schema.Struct({ passed: Schema.Boolean })

const check = Effect.fn('bench.preflight.check')(function* (url: string, resolved: Resolved, provider: Provider) {
  const config = resolved.manifest.preflight
  if (config === undefined) return yield* fail('Preflight configuration missing')
  const scenario = resolved.scenarios?.find((item) => item.id === config.scenarioId)
  const variant = resolved.manifest.variants[0]
  if (scenario === undefined || variant?.writer === undefined)
    return yield* fail('Preflight requires a real writer corpus')
  const events = publicEvents(scenario.events.slice(0, config.cutoff))
  const actor = digest({ preflight: resolved.runId, source: resolved.sourceHash, config })
  provider.setScope(actor, 'preflight')
  const build = yield* post(url, 'build', actor, {
    identity: actor,
    manifest: resolved.manifest,
    policy: 'optchat',
    writer: variant.writer,
    events,
  })
  const operation = `${resolved.runId}.preflight`
  provider.setScope(operation, 'preflight')
  const native = yield* Schema.decodeUnknownEffect(ProbeResult)(
    yield* post(url, 'probe', actor, {
      id: operation,
      reader: variant.reader,
      cutoff: config.cutoff,
      recallGuide: resolved.manifest.recallGuide,
      search: true,
      question: `Before answering, call archive_search with query ${JSON.stringify(config.query)} to find the owner's original request. Use archive_read if the excerpt is incomplete. Describe that request with claim key owner-request and cite the source event ID.`,
    }),
  )
  const parsed = yield* Effect.try({
    try: (): unknown => JSON.parse(native.text),
    catch: () => fail('Native preflight did not return strict answer JSON'),
  })
  const answer = yield* Schema.decodeUnknownEffect(Answer)(parsed, { onExcessProperty: 'error' })
  const traces = [...provider.traces(actor), ...provider.traces(operation)]
  const checks = validatePreflight({
    native,
    answer,
    traces,
    actor,
    operation,
    events,
    sourceId: config.sourceId,
    writerId: variant.writer,
    readerId: variant.reader,
    readerMaxOutputTokens: resolved.manifest.transport?.readerMaxOutputTokens,
    thinking: resolved.manifest.transport?.thinking ?? 'provider-default',
  })
  return { ...checks, actor, operation, build, native, answer, limits: config }
})

/** Separate durable evidence and phase ceiling; a failed preflight is preserved and never automatically rerun. */
export const preflight = Effect.fn('bench.preflight')(function* (
  dir: string,
  url: string,
  resolved: Resolved,
  provider: Provider,
) {
  if (resolved.manifest.preflight === undefined) return
  const fs = yield* FileSystem.FileSystem
  const path = join(dir, 'preflight.json')
  if (yield* fs.exists(path)) {
    if (!(yield* readJson(path, Receipt)).passed)
      return yield* fail('Recorded native preflight failed; bulk run remains aborted')
    return
  }
  const result = yield* check(url, resolved, provider).pipe(Effect.result)
  if (Result.isFailure(result)) {
    yield* writeJson(path, { passed: false, error: json(result.failure) })
    return yield* fail('Native preflight failed; bulk run aborted. Inspect preflight evidence and API attempts.')
  }
  yield* writeJson(path, result.success)
  if (!result.success.passed)
    return yield* fail('Native preflight gates failed; bulk run aborted. Inspect preflight.json.')
})

export function validatePreflight({
  native,
  answer,
  traces,
  actor,
  operation,
  events,
  sourceId,
  writerId,
  readerId,
  readerMaxOutputTokens,
  thinking,
}: {
  native: ProbeResult
  answer: Answer
  traces: readonly Trace[]
  actor: string
  operation: string
  events: readonly ReplayEvent[]
  sourceId: string
  writerId: string
  readerId: string
  readerMaxOutputTokens: number | undefined
  thinking: 'provider-default' | 'disabled'
}) {
  const writer = traces.filter((trace) => trace.scope === actor && trace.model === writerId && trace.status === 200)
  const reader = traces.filter((trace) => trace.scope === operation && trace.model === readerId && trace.status === 200)
  const source = native.deliveries.filter(
    (item) =>
      item.id === sourceId && (item.origin === 'search' || item.origin === 'read') && validDelivery(item, events),
  )
  const cited = source.some((item) => answer.evidenceIds.includes(item.id))
  const payloads: Record<string, unknown>[] = traces.map((trace) => JSON.parse(trace.request))
  const correctPayloads = payloads.every((payload) => {
    const option = payload['thinking']
    const configuredThinking =
      thinking === 'disabled'
        ? payload['enable_thinking'] === false &&
          typeof option === 'object' &&
          option !== null &&
          'type' in option &&
          option.type === 'disabled'
        : payload['enable_thinking'] !== false && option === undefined
    return (
      configuredThinking &&
      (!Array.isArray(payload['tools']) || payload['tools'].length === 0 || payload['tool_choice'] === 'auto')
    )
  })
  const capped = payloads.every(
    (payload, index) =>
      (payload['max_tokens'] ?? payload['max_completion_tokens']) ===
      (traces[index]?.scope === actor ? 2448 : readerMaxOutputTokens),
  )
  const usageBounded = traces.every((trace) => !trace.unknownUsage && !exceededReservation(trace))
  const passed =
    native.status === 'done' &&
    writer.length > 0 &&
    reader.length >= 2 &&
    native.retrieval.some((item) => item.operation === 'archive_search' && !item.denied) &&
    cited &&
    !answer.abstain &&
    answer.claims.length > 0 &&
    answer.evidenceIds.every((id) => native.deliveries.some((item) => item.id === id)) &&
    correctPayloads &&
    capped &&
    usageBounded
  return {
    passed,
    checks: {
      writerRequests: writer.length,
      readerRequests: reader.length,
      cited,
      correctPayloads,
      capped,
      usageBounded,
    },
  }
}
