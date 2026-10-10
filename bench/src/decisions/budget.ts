import type { Attempt, Usage } from './schema.ts'
import type { Manifest, Model } from './manifest.ts'

export const cost = (model: Model, input: number, output: number): number =>
  (input * model.inputPerMillion + output * model.outputPerMillion) / 1_000_000
export function totals(records: readonly Attempt[]) {
  const unique = [...new Map(records.map((record) => [record.id, record])).values()]
  return {
    requests: unique.length,
    input: unique.reduce((sum, record) => sum + record.input, 0),
    output: unique.reduce((sum, record) => sum + record.output, 0),
    usd: unique.reduce((sum, record) => sum + record.costUsd, 0),
    unfinished: unique.some((record) => record.phase === 'reserve'),
    breach: unique.some((record) => record.error === 'reservation-breach'),
  }
}
export function admission(
  manifest: Manifest,
  records: readonly Attempt[],
  model: Model,
  input: number,
  output: number,
): string | null {
  const current = records.filter((record) => record.runId === manifest.runId)
  const used = totals(manifest.campaign === undefined ? records : current)
  const global = totals(records)
  const currentState = totals(current)
  if (global.unfinished) return 'unfinished-attempt'
  if (currentState.breach) return 'reservation-breach'
  // A terminal access/route rejection skips that arm; its full allowance still counts.
  if (
    records.some(
      (record) =>
        record.phase === 'settle' &&
        !record.usageKnown &&
        record.ownerApproved === undefined &&
        ![400, 401, 402, 403, 404, 405].includes(record.status),
    )
  )
    return 'unknown-usage'
  const cap = manifest.limits
  if (manifest.campaign !== undefined) {
    const campaign = totals(records.filter((record) => record.campaignId === manifest.campaign?.id))
    if (campaign.usd + cost(model, input, output) > manifest.campaign.maxUsd) return 'campaign-budget-ceiling'
  }
  if (input > cap.perCallInput || output > cap.perCallOutput) return 'per-call-token-ceiling'
  if (
    used.requests + 1 > cap.maxRequests ||
    used.input + input > cap.maxInput ||
    used.output + output > cap.maxOutput ||
    used.usd + cost(model, input, output) > cap.maxUsd
  )
    return 'budget-ceiling'
  return null
}
export function settle(
  started: Attempt,
  model: Model,
  reply: { status: number; latencyMs: number; error: string | null },
  usage: Usage | undefined,
): Attempt {
  const input = usage?.input ?? started.reservedInput
  const output = usage?.output ?? started.reservedOutput
  const breach = input > started.reservedInput || output > started.reservedOutput
  return {
    ...started,
    phase: 'settle',
    input,
    output,
    costUsd: cost(model, input, output),
    usageKnown: usage !== undefined,
    status: reply.status,
    latencyMs: reply.latencyMs,
    error: breach ? 'reservation-breach' : reply.error,
  }
}
