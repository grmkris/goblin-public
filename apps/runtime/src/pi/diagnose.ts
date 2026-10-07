import { defineExtension } from '@earendil-works/pi-durable'
import { Coverage, TurnSummary, TurnTimeline } from '@goblin/contracts/inspect'
import { RunAttribute, RunAttributes, RunEventKind, RunEventStatus, type RunEvent } from '@goblin/contracts/telemetry'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import { nowMillis } from '../clock.ts'
import type { AppError } from '../http/errors.ts'
import { Inspect, attempt, attemptSync } from '../services.ts'
import type { RunProgram } from './resident-mcp.ts'
import { typedTool } from './typed-tool.ts'

const HOUR_MS = 60 * 60 * 1000
const PROBLEMS = 20
const TURNS = 10
/** The attributes that explain an event to the owner: what ran, and how it failed. */
const SHOWN = [
  RunAttribute.toolName,
  RunAttribute.mcpServer,
  RunAttribute.mcpTool,
  RunAttribute.mcpStep,
  RunAttribute.requestModel,
  RunAttribute.finishReason,
  RunAttribute.errorType,
  RunAttribute.error,
  RunAttribute.blockedReason,
  RunAttribute.reason,
  RunAttribute.source,
  RunAttribute.purpose,
  RunAttribute.delivery,
  RunAttribute.recovery,
] as const

/** One event in a line: what it was, how it ended, how long it took, and why (the {@link SHOWN} attributes). */
const Brief = Schema.StructWithRest(
  Schema.Struct({
    kind: RunEventKind,
    status: RunEventStatus,
    at: Schema.String,
    ms: Schema.optionalKey(Schema.Number),
    operationId: Schema.optionalKey(Schema.String),
  }),
  [RunAttributes],
)

/** A turn's timeline, a turn that is not there, or the recent problems and turns. Never trusted: errors are data. */
const Diagnosis = Schema.Union([
  Schema.Struct({
    trusted: Schema.Literal(false),
    turn: TurnSummary,
    submission: TurnTimeline.fields.submission,
    events: Schema.Array(Brief),
    coverage: Coverage,
  }),
  Schema.Struct({ found: Schema.Literal(false), note: Schema.String }),
  Schema.Struct({ trusted: Schema.Literal(false), problems: Schema.Array(Brief), turns: Schema.Array(TurnSummary) }),
])

const brief = (event: RunEvent): typeof Brief.Type => ({
  kind: event.kind,
  status: event.status,
  at: new Date(event.startedAt).toISOString(),
  ...(event.endedAt === undefined ? {} : { ms: event.endedAt - event.startedAt }),
  ...(event.operationId === undefined ? {} : { operationId: event.operationId }),
  ...Object.fromEntries(
    SHOWN.flatMap((key) => (event.attributes[key] === undefined ? [] : [[key, event.attributes[key]]])),
  ),
})

/**
 * `diagnose`: the agent's own read of how its recent turns ran (ADR 0024), so it can tell the owner why something
 * failed. Read-only, never content, never a model call. Error text can come from remote servers: it is data.
 */
const diagnoseTool = (run: RunProgram) =>
  typedTool({
    name: 'diagnose',
    description:
      'Explain your own recent work to the owner: without operationId, events needing attention and recent turn summaries; use all:true to include expected waits and confirmed recovered attempts. With operationId, the complete turn timeline and any coverage gaps. Error summaries are fixed codes; private details remain in conversation inspection. Read-only, grants nothing.',
    input: Schema.Struct({
      operationId: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200))),
      hours: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 168 }))),
      all: Schema.optionalKey(Schema.Boolean),
    }),
    output: Diagnosis,
    replay: 'safe',
    execute: async ({ operationId, hours, all }) =>
      run(
        Inspect.use((inspector): Effect.Effect<typeof Diagnosis.Type, AppError> => {
          if (operationId !== undefined)
            return attempt(() => inspector.turn(operationId)).pipe(
              Effect.map((timeline) => ({
                trusted: false as const,
                turn: timeline.turn,
                ...(timeline.submission === undefined ? {} : { submission: timeline.submission }),
                events: timeline.events.map(brief),
                coverage: timeline.coverage,
              })),
              Effect.catchTag('NotFound', () =>
                Effect.succeed({ found: false as const, note: 'No turn with that operation id in the last 30 days.' }),
              ),
            )
          const since = nowMillis() - (hours ?? 24) * HOUR_MS
          return attemptSync(() => ({
            trusted: false as const,
            problems: inspector.problems(since, PROBLEMS, all === true).problems.map(brief),
            turns: inspector.turns(since, TURNS).turns,
          }))
        }),
      ),
  })

/** The resident agent's read-only self-diagnosis, for its main conversation (where Telegram and clients talk). */
export const diagnoseExtension = (run: RunProgram) =>
  defineExtension({ name: 'goblin.diagnose', tools: [diagnoseTool(run)] })
