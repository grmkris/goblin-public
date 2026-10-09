import type { InspectDetails, RelatedOperation } from '@goblin/contracts/inspect'
import { RunAttribute, type RunEvent, type RunEventStatus } from '@goblin/contracts/telemetry'

/** One step of what ran behind a message, in the owner's words: what it was, what it touched, how it ended. */
export type DetailStep = {
  readonly id: string
  readonly label: string
  readonly detail: string | undefined
  readonly status: RunEventStatus
  readonly ms: number | undefined
}

const attribute = (event: RunEvent, key: string): string | undefined => {
  const value = event.attributes[key]
  return value === undefined || value === '' ? undefined : String(value)
}

const named = (what: string, ...names: readonly (string | undefined)[]): string => {
  const name = names.filter((each) => each !== undefined).join(' · ')
  return name === '' ? what : `${what} ${name}`
}

/** What a step was: the model it asked, the tool it called, the flow it took. */
function labelOf(event: RunEvent): string {
  switch (event.kind) {
    case 'turn.submitted':
      return 'Message submitted'
    case 'model.attempt':
      return named('Model', attribute(event, RunAttribute.responseModel) ?? attribute(event, RunAttribute.requestModel))
    case 'model.aux':
      return named('Helper model', attribute(event, RunAttribute.purpose))
    case 'tool.call':
      return named('Tool', attribute(event, RunAttribute.toolName))
    case 'compaction':
      return 'Context compacted'
    case 'channel.received':
      return named('Received from', attribute(event, RunAttribute.channel))
    case 'channel.reply':
      return named('Replied on', attribute(event, RunAttribute.channel))
    case 'recovery':
      return 'Recovered'
    case 'mcp.request':
      return named('MCP', attribute(event, RunAttribute.mcpServer), attribute(event, RunAttribute.mcpTool))
    case 'error':
      return 'Error'
    case 'flow':
      return named('Flow', attribute(event, RunAttribute.flow))
  }
}

/** What else is worth a line under a step: why it failed, its tokens, how a flow came in. */
function detailOf(event: RunEvent): string | undefined {
  const failure = attribute(event, RunAttribute.errorType) ?? attribute(event, RunAttribute.blockedReason)
  if (failure !== undefined) return failure
  if (event.kind === 'flow') return attribute(event, RunAttribute.flowVia)
  const input = event.attributes[RunAttribute.inputTokens]
  const output = event.attributes[RunAttribute.outputTokens]
  if (typeof input === 'number' && typeof output === 'number') return `${input} in · ${output} out tokens`
  return undefined
}

/** The steps of a message's operation, in the order they ran. */
export const detailSteps = (details: InspectDetails): DetailStep[] =>
  details.events
    .toSorted((a, b) => a.startedAt - b.startedAt)
    .map((event) => ({
      id: event.id,
      label: labelOf(event),
      detail: detailOf(event),
      status: event.status,
      ms: event.endedAt === undefined ? undefined : event.endedAt - event.startedAt,
    }))

const counted = (count: number, one: string, failed = 0) =>
  `${count} ${one}${count === 1 ? '' : 's'}${failed > 0 ? ` (${failed} failed)` : ''}`

/** The operation in a few lines: where it came from and how it ended, what it took, what it cost. */
export function detailSummary(details: InspectDetails): string[] {
  const { turn } = details
  if (turn === undefined) return ['A written note: no model ran for it.']
  const ended = turn.endedAt === undefined ? 'still running' : durationText(turn.endedAt - turn.startedAt)
  return [
    `From ${turn.source} · ${turn.status}${turn.reason === undefined ? '' : ` (${turn.reason})`} · ${ended}`,
    `${counted(turn.modelAttempts, 'model attempt', turn.failedAttempts)} · ${counted(turn.toolCalls, 'tool call', turn.failedToolCalls)}`,
    `${turn.inputTokens} in · ${turn.outputTokens} out tokens${(turn.errors ?? 0) > 0 ? ` · ${counted(turn.errors ?? 0, 'error')}` : ''}`,
  ]
}

/** A related operation in a line: what it was, and where it stands. */
export const relatedText = (related: RelatedOperation): string =>
  related.state === undefined ? related.kind : `${related.kind} · ${related.state}`

/** Milliseconds as the owner reads them: under a second in ms, else seconds with one decimal, else minutes. */
export function durationText(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`
  return `${(ms / 60_000).toFixed(1)} min`
}
