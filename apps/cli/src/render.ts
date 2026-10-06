import {
  InspectConversations,
  InspectEntries,
  type InspectEntry,
  InspectProblems,
  InspectTurns,
  type TurnSummary,
  TurnTimeline,
} from '@goblin/contracts/inspect'
import { RunAttribute, type RunEvent } from '@goblin/contracts/telemetry'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'

const time = (at: number) => new Date(at).toISOString().replace('T', ' ').slice(0, 19)
const duration = (event: { readonly startedAt: number; readonly endedAt?: number | undefined }) =>
  event.endedAt === undefined ? 'open' : `${event.endedAt - event.startedAt}ms`
const text = (value: unknown) => (typeof value === 'string' || typeof value === 'number' ? String(value) : '')

/** What an event was about: its tool, model or channel, and why it ended as it did. */
function detail(event: RunEvent): string {
  const attributes = event.attributes
  const subject =
    text(attributes[RunAttribute.toolName]) ||
    text(attributes[RunAttribute.requestModel]) ||
    text(attributes[RunAttribute.mcpServer]) ||
    text(attributes[RunAttribute.channel])
  const why =
    text(attributes[RunAttribute.error]) ||
    text(attributes[RunAttribute.blockedReason]) ||
    text(attributes[RunAttribute.reason]) ||
    text(attributes[RunAttribute.finishReason])
  return [subject, why].filter((part) => part !== '').join('  ')
}

const eventLine = (event: RunEvent) =>
  `${time(event.startedAt)}  ${event.kind.padEnd(16)} ${event.status.padEnd(11)} ${duration(event).padStart(8)}  ${detail(event)}`

const turnLine = (turn: TurnSummary) =>
  [
    time(turn.startedAt),
    turn.status.padEnd(11),
    turn.source.padEnd(15),
    `${turn.modelAttempts} calls${turn.failedAttempts > 0 ? ` (${turn.failedAttempts} failed)` : ''}`,
    `${turn.toolCalls} tools${turn.failedToolCalls > 0 ? ` (${turn.failedToolCalls} failed)` : ''}`,
    `${turn.inputTokens}/${turn.outputTokens} tok`,
    turn.operationId,
    turn.reason ?? '',
  ].join('  ')

function entryLines(entry: InspectEntry): string[] {
  const who = [entry.role ?? entry.kind, entry.author === undefined ? '' : `(${entry.author})`].join('')
  const head = `#${entry.id} ${who}${entry.tool === undefined ? '' : ` ← ${entry.tool.name}${entry.tool.isError ? ' ERROR' : ''}`}`
  const model =
    entry.model === undefined
      ? []
      : [
          `  [${entry.model.model} ${entry.model.stopReason}${entry.model.error === undefined ? '' : `: ${entry.model.error}`}]`,
        ]
  const calls = (entry.toolCalls ?? []).map((call) => `  → ${call.name} ${call.arguments}`)
  const body = (entry.text ?? entry.data ?? '').split('\n').map((line) => `  ${line}`)
  return [
    head,
    ...body.filter((line) => line.trim() !== ''),
    ...calls,
    ...model,
    ...(entry.truncated ? ['  …truncated'] : []),
  ]
}

const RENDERERS: Readonly<Record<string, (value: unknown) => string | undefined>> = {
  conversations: (value) =>
    Option.getOrUndefined(
      Option.map(Schema.decodeUnknownOption(InspectConversations)(value), ({ conversations }) =>
        conversations.map((conversation) => JSON.stringify(conversation)).join('\n'),
      ),
    ),
  conversation: (value) =>
    Option.getOrUndefined(
      Option.map(Schema.decodeUnknownOption(InspectEntries)(value), (page) =>
        [
          ...(page.entries.length === 0 ? ['No entries.'] : page.entries.flatMap(entryLines)),
          ...(page.before === undefined ? [] : [`(older: --before ${page.before})`]),
        ].join('\n'),
      ),
    ),
  turns: (value) =>
    Option.getOrUndefined(
      Option.map(Schema.decodeUnknownOption(InspectTurns)(value), ({ turns }) =>
        turns.length === 0 ? 'No turns in that window.' : turns.map(turnLine).join('\n'),
      ),
    ),
  turn: (value) =>
    Option.getOrUndefined(
      Option.map(Schema.decodeUnknownOption(TurnTimeline)(value), (timeline) =>
        [
          turnLine(timeline.turn),
          timeline.submission === undefined
            ? 'Pi: no submission found'
            : `Pi: ${timeline.submission.status}${timeline.submission.reason === undefined ? '' : ` (${timeline.submission.reason})`}`,
          '',
          ...timeline.events.map(eventLine),
          ...(timeline.coverage.complete ? [] : ['', ...timeline.coverage.gaps.map((gap) => `! ${gap}`)]),
        ].join('\n'),
      ),
    ),
  problems: (value) =>
    Option.getOrUndefined(
      Option.map(Schema.decodeUnknownOption(InspectProblems)(value), ({ problems }) =>
        problems.length === 0
          ? 'No problems in that window.'
          : problems.map((event) => `${eventLine(event)}  ${event.operationId ?? ''}`).join('\n'),
      ),
    ),
}

/** A tool's result for a person reading a terminal; JSON for anything the renderers do not know. */
export function render(command: string, value: unknown): string {
  return RENDERERS[command]?.(value) ?? JSON.stringify(value, null, 2)
}

const decodeFailure = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)))

/** A tool's failure as a line: `NotFound: what=turn`, or its own text when it is not one of goblin's errors. */
export function failureText(message: string): string {
  const fields = Option.getOrUndefined(decodeFailure(message))
  const tag = fields?.['_tag']
  if (fields === undefined || typeof tag !== 'string') return message
  const parts = Object.entries(fields)
    .filter(([key]) => key !== '_tag')
    .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`)
  return parts.length === 0 ? tag : `${tag}: ${parts.join(' ')}`
}
