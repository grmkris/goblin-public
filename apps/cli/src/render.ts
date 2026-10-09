import {
  type FlowRecord,
  InspectConversations,
  InspectDetails,
  InspectEntries,
  type InspectEntry,
  InspectFlows,
  InspectProblems,
  InspectTurns,
  type RelatedOperation,
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
    ...((turn.errors ?? 0) > 0 ? [`${turn.errors} errors`] : []),
    `${turn.inputTokens}/${turn.outputTokens} tok`,
    turn.operationId,
    turn.reason ?? '',
  ].join('  ')

/** Text as indented lines, blank lines left out. */
const indented = (words: string | undefined, prefix: string): string[] =>
  (words ?? '')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => `${prefix}${line}`)

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
  return [
    head,
    ...indented(entry.thinking, '  ~ '),
    ...indented(entry.text ?? entry.data, '  '),
    ...calls,
    ...model,
    ...(entry.truncated ? ['  …truncated'] : []),
  ]
}

/** A flow step in a line: when, which flow and how it ended, how it came in and who acted, its chat and operation. */
const flowLine = (flow: FlowRecord) =>
  [
    time(flow.at),
    flow.flow.padEnd(19),
    flow.status.padEnd(8),
    `${flow.via}/${flow.actor}`.padEnd(16),
    flow.chat === undefined ? '' : `chat ${flow.chat}`,
    flow.operationId ?? '',
    flow.errorType ?? '',
    flow.ms === undefined ? '' : `${flow.ms}ms`,
  ]
    .filter((part) => part !== '')
    .join('  ')

const relatedLine = (related: RelatedOperation) =>
  [
    `  ${related.kind}`,
    related.operation,
    related.chat === undefined ? '' : `chat ${related.chat}`,
    related.state ?? '',
  ]
    .filter((part) => part !== '')
    .join('  ')

/** Pi's settlement in a line, or that there is none. */
const piLine = (submission: TurnTimeline['submission']) =>
  submission === undefined
    ? 'Pi: no submission found'
    : `Pi: ${submission.status}${submission.reason === undefined ? '' : ` (${submission.reason})`}`

const gapLines = (coverage: TurnTimeline['coverage']) =>
  coverage.complete ? [] : ['', ...coverage.gaps.map((gap) => `! ${gap}`)]

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
          piLine(timeline.submission),
          '',
          ...timeline.events.map(eventLine),
          ...gapLines(timeline.coverage),
        ].join('\n'),
      ),
    ),
  flows: (value) =>
    Option.getOrUndefined(
      Option.map(Schema.decodeUnknownOption(InspectFlows)(value), ({ flows }) =>
        flows.length === 0 ? 'No flows in that window.' : flows.map(flowLine).join('\n'),
      ),
    ),
  details: (value) =>
    Option.getOrUndefined(
      Option.map(Schema.decodeUnknownOption(InspectDetails)(value), (details) =>
        [
          ...(details.turn === undefined ? ['No turn: the steps of this operation'] : [turnLine(details.turn)]),
          ...(details.turn === undefined ? [] : [piLine(details.submission)]),
          '',
          ...details.events.map((event) => `${eventLine(event)}  ${event.operationId ?? ''}`),
          ...gapLines(details.coverage),
          ...(details.related.length === 0 ? [] : ['', 'Related:', ...details.related.map(relatedLine)]),
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
