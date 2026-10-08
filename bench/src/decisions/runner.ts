import { arms, type Arm, type Fixture, type Row, type Answers } from './schema.ts'
import type { Manifest, Model } from './manifest.ts'
import { modelFor } from './manifest.ts'
import { rules } from './rules.ts'
import { packet, chatBody, typedBody, openaiBody } from './wire.ts'

export interface Batch {
  readonly fixtures: readonly Fixture[]
  readonly selected: readonly Fixture[]
  readonly arm: Arm
  readonly repetition: number
}
export function batches(fixtures: readonly Fixture[], arm: Arm, repetitions: number): Batch[] {
  const output: Batch[] = []
  for (let repetition = 1; repetition <= repetitions; repetition += 1) {
    for (let at = 0; at < fixtures.length; at += 2) {
      const group = fixtures.slice(at, at + 2)
      output.push({
        fixtures: group,
        selected: arm === 'critic' ? group.filter((fixture) => !rules(fixture).decided) : group,
        arm,
        repetition,
      })
    }
  }
  return output
}
export function requestBody(batch: Batch, model: Model, output: number): string {
  const data = packet(batch.fixtures, batch.selected)
  if (model.arm === 'cheap-llm') return JSON.stringify(chatBody(model.model, data, output))
  if (model.arm === 'openai-decisions') return JSON.stringify(openaiBody(data))
  return JSON.stringify(typedBody(model.model, data, model.arm === 'jev'))
}
export function plan(manifest: Manifest, fixtures: readonly Fixture[]) {
  const estimates = arms
    .filter((arm) => arm !== 'rules')
    .map((arm) => {
      const model = modelFor(manifest, arm)
      const calls = batches(fixtures, arm, manifest.repetitions).filter((batch) => batch.selected.length > 0)
      const input = calls.reduce(
        (sum, batch) =>
          sum +
          Math.ceil(new TextEncoder().encode(requestBody(batch, model, manifest.limits.perCallOutput)).length / 4),
        0,
      )
      const output = arm === 'cheap-llm' ? calls.length * manifest.limits.perCallOutput : 0
      const reservedInput = calls.reduce(
        (sum, batch) =>
          sum + new TextEncoder().encode(requestBody(batch, model, manifest.limits.perCallOutput)).length + 256,
        0,
      )
      const reservedOutput = calls.length * manifest.limits.perCallOutput
      return {
        arm,
        requests: calls.length,
        estimatedInput: input,
        estimatedOutput: output,
        estimatedCostUsd: (input * model.inputPerMillion + output * model.outputPerMillion) / 1_000_000,
        maximumReservedUsd:
          (reservedInput * model.inputPerMillion + reservedOutput * model.outputPerMillion) / 1_000_000,
        priceKind: model.priced ? 'published' : 'conservative upper rate',
      }
    })
  return {
    requests: estimates.reduce((sum, item) => sum + item.requests, 0),
    criticRequests: estimates.find((item) => item.arm === 'critic')?.requests ?? 0,
    estimatedInput: estimates.reduce((sum, item) => sum + item.estimatedInput, 0),
    estimatedOutput: estimates.reduce((sum, item) => sum + item.estimatedOutput, 0),
    estimatedCostUsd: estimates.reduce((sum, item) => sum + item.estimatedCostUsd, 0),
    maximumReservedUsd: estimates.reduce((sum, item) => sum + item.maximumReservedUsd, 0),
    estimates,
    ceilings: manifest.limits,
  }
}
export function localRow(fixture: Fixture, arm: Arm, repetition: number): Row {
  return {
    id: fixture.id,
    arm,
    task: fixture.task,
    repetition,
    answers: rules(fixture).answers,
    route: 'rules',
    error: null,
    latencyMs: 0,
    input: 0,
    output: 0,
    costUsd: 0,
    actualCostUsd: 0,
  }
}
export function modelRows(
  batch: Batch,
  outcome: {
    answers: Answers | null
    error: string | null
    latencyMs: number
    input: number
    output: number
    costUsd: number
    actualCostUsd: number | null
  },
): Row[] {
  return batch.fixtures.map((fixture) => {
    if (batch.arm === 'critic' && rules(fixture).decided) return localRow(fixture, batch.arm, batch.repetition)
    const answers =
      outcome.answers === null
        ? null
        : Object.fromEntries(
            Object.entries(outcome.answers)
              .filter(([key]) => key.startsWith(fixture.id + '.'))
              .map(([key, distribution]) => [key.slice(fixture.id.length + 1), distribution]),
          )
    const size = batch.selected.length
    return {
      id: fixture.id,
      arm: batch.arm,
      task: fixture.task,
      repetition: batch.repetition,
      route: 'model',
      answers,
      error: outcome.error,
      latencyMs: outcome.latencyMs,
      input: Math.ceil(outcome.input / size),
      output: Math.ceil(outcome.output / size),
      costUsd: outcome.costUsd / size,
      actualCostUsd: outcome.actualCostUsd === null ? null : outcome.actualCostUsd / size,
    }
  })
}
