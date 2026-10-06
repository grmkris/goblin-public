import type { CommitPublication, Session } from '@earendil-works/pi-durable'
import { RunAttribute, type RunAttributes, type RunEventKind } from '@goblin/contracts/telemetry'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import { nowMillis } from '../clock.ts'
import { answerAttributes, statusOfStop } from './attributes.ts'
import type { RunTelemetry } from './events.ts'

/** What the recorder reads from the ledger after a restart: the newest event for a Pi task. */
export type RecorderLedger = {
  readonly latestForTask: (
    kind: RunEventKind,
    taskId: string,
  ) => { readonly id: string; readonly status: string; readonly attributes: RunAttributes } | undefined
}

const Id = Schema.Union([Schema.Number, Schema.String])
const Usage = Schema.Struct({
  input: Schema.Number,
  output: Schema.Number,
  cacheRead: Schema.Number,
  cacheWrite: Schema.Number,
  reasoning: Schema.optional(Schema.Number),
})
const Block = Schema.Struct({
  type: Schema.String,
  id: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  arguments: Schema.optional(Schema.Unknown),
})
const Assistant = Schema.Struct({
  role: Schema.Literal('assistant'),
  provider: Schema.String,
  model: Schema.String,
  responseModel: Schema.optional(Schema.String),
  responseId: Schema.optional(Schema.String),
  usage: Usage,
  stopReason: Schema.String,
  errorMessage: Schema.optional(Schema.String),
  timestamp: Schema.Number,
  content: Schema.Array(Block),
})
const ToolResult = Schema.Struct({
  role: Schema.Literal('toolResult'),
  toolCallId: Schema.String,
  toolName: Schema.String,
  isError: Schema.optional(Schema.Boolean),
  content: Schema.Unknown,
  timestamp: Schema.optional(Schema.Number),
})
const Diagnostics = Schema.Struct({
  diagnostics: Schema.optional(
    Schema.Array(Schema.Struct({ code: Schema.String, message: Schema.optional(Schema.String) })),
  ),
})
const Entry = Schema.Struct({
  id: Id,
  conversationId: Id,
  kind: Schema.String,
  model: Schema.optional(Schema.Array(Schema.Unknown)),
  data: Schema.optional(Schema.Unknown),
  byTaskId: Schema.optional(Id),
})
const Outcome = Schema.Struct({
  status: Schema.String,
  error: Schema.optional(Schema.Struct({ message: Schema.String })),
  reason: Schema.optional(Schema.String),
})
const Task = Schema.Struct({
  id: Id,
  conversationId: Id,
  kind: Schema.String,
  input: Schema.optional(Schema.Unknown),
  state: Schema.Struct({
    status: Schema.String,
    checkpoint: Schema.optional(
      Schema.Struct({
        phase: Schema.optional(Schema.String),
        attempt: Schema.optional(Schema.Number),
        model: Schema.optional(Schema.Struct({ provider: Schema.String, modelId: Schema.String })),
      }),
    ),
    outcome: Schema.optional(Outcome),
  }),
})
const ToolInput = Schema.Struct({ assistant: Id, callId: Schema.String })
const CompactionInput = Schema.Struct({ reason: Schema.String })
const Submission = Schema.Struct({
  id: Id,
  conversationId: Id,
  type: Schema.String,
  status: Schema.String,
  requestId: Schema.optional(Schema.String),
  reason: Schema.optional(Schema.String),
  detail: Schema.optional(Schema.Unknown),
})
const Live = Schema.Struct({
  run: Schema.optional(Schema.Struct({ taskId: Id, inputs: Schema.Array(Id) })),
  generation: Schema.optional(Schema.Struct({ attempt: Schema.Number, message: Schema.optional(Schema.Unknown) })),
})
const McpCall = Schema.Struct({ serverId: Schema.String, name: Schema.String })

const decode =
  <S extends Schema.Top & Schema.ConstraintDecoder<unknown>>(schema: S) =>
  (value: unknown): S['Type'] | undefined =>
    Option.getOrUndefined(Schema.decodeUnknownOption(schema)(value))
const decodeEntry = decode(Entry)
const decodeAssistant = decode(Assistant)
const decodeToolResult = decode(ToolResult)
const decodeDiagnostics = decode(Diagnostics)
const decodeTask = decode(Task)
const decodeToolInput = decode(ToolInput)
const decodeCompactionInput = decode(CompactionInput)
const decodeSubmission = decode(Submission)
const decodeLive = decode(Live)
const decodeMcpCall = decode(McpCall)

/** Where a turn came from, by the operation id each source gives its submissions. */
const SOURCES: readonly (readonly [string, string])[] = [
  ['telegram-', 'telegram'],
  ['routine-input:', 'routine'],
  ['routine-report:', 'routine_report'],
  ['subagent-report:', 'subagent_report'],
  ['subagent:', 'subagent'],
  ['thread-started:', 'thread'],
]
export const sourceOf = (operationId: string): string =>
  SOURCES.find(([prefix]) => operationId.startsWith(prefix))?.[1] ?? 'direct'

/** The kind of tool a call is, by its name. */
const familyOf = (tool: string): string =>
  tool === 'mcp_call' || tool === 'mcp_list'
    ? 'mcp'
    : tool === 'subagent'
      ? 'subagent'
      : tool === 'zoom'
        ? 'memory'
        : tool.startsWith('app_') || tool === 'code_run'
          ? 'app'
          : 'builtin'

const sizeOf = (value: unknown): number => JSON.stringify(value ?? null).length

type Assistant = typeof Assistant.Type
type Outcome = typeof Outcome.Type
/** Where an entry or task sits: its id, its conversation and the Pi task it belongs to. */
type Place = { readonly id: string; readonly conversation: string; readonly taskId: string }

/** The calls an answer makes, keyed `entry:call`, with the attributes their tool call events start with. */
function callsOf(entry: string, message: Assistant) {
  return message.content.flatMap((block) => {
    if (block.type !== 'toolCall' || block.id === undefined || block.name === undefined) return []
    const mcp = block.name === 'mcp_call' ? decodeMcpCall(block.arguments) : undefined
    const servers =
      mcp === undefined ? {} : { [RunAttribute.mcpServer]: mcp.serverId, [RunAttribute.mcpTool]: mcp.name }
    const attributes = { [RunAttribute.argumentBytes]: sizeOf(block.arguments), ...servers }
    return [[`${entry}:${block.id}`, { name: block.name, attributes }] as const]
  })
}

type Diagnostic = { readonly code: string; readonly message?: string | undefined }

/** A tool result's status: blocked by a hook, cut short, failed, or fine. */
function toolStatus(codes: readonly string[], isError: boolean) {
  if (codes.includes('blocked')) return 'blocked'
  if (codes.includes('interrupted') || codes.includes('aborted')) return 'interrupted'
  return isError ? 'error' : 'ok'
}

/** What a tool result tells about its call: name, size, and the first diagnostic as the reason. */
function resultAttributes(
  result: typeof ToolResult.Type,
  status: string,
  first: Diagnostic | undefined,
): RunAttributes {
  const reason =
    first === undefined
      ? {}
      : {
          [status === 'blocked' ? RunAttribute.blockedReason : RunAttribute.error]: first.message ?? first.code,
          [RunAttribute.errorType]: first.code,
        }
  return {
    [RunAttribute.toolName]: result.toolName,
    [RunAttribute.toolCallId]: result.toolCallId,
    [RunAttribute.toolFamily]: familyOf(result.toolName),
    [RunAttribute.resultBytes]: sizeOf(result.content),
    ...reason,
  }
}

const isFailure = (outcome: Outcome) =>
  outcome.status === 'faulted' || outcome.status === 'orphaned' || outcome.status === 'failed'
const outcomeStatus = (outcome: Outcome) => {
  if (outcome.status === 'aborted') return 'interrupted'
  return isFailure(outcome) ? 'error' : 'ok'
}
const outcomeAttributes = (outcome: Outcome): RunAttributes => ({
  [RunAttribute.reason]: outcome.status,
  ...(outcome.error === undefined ? {} : { [RunAttribute.error]: outcome.error.message }),
  ...(outcome.reason === undefined ? {} : { [RunAttribute.error]: outcome.reason }),
})

/** At most this many tool calls and submissions remembered between commits; older ones resolve from the ledger. */
const MAX_REMEMBERED = 500
const remember = <V>(map: Map<string, V>, key: string, value: V) => {
  map.set(key, value)
  if (map.size > MAX_REMEMBERED) map.delete(map.keys().next().value ?? key)
}

type Change = CommitPublication['changes'][number]

/**
 * Turns Pi's committed records into run events (ADR 0024). Pi's commit listener sees every conversation, main,
 * threads, subagents and routine runs alike, with no extension to install, and a record is the truth about what
 * happened: a model attempt starts when its generation task enters `request` and ends with the assistant entry it
 * appends (or the task's fault); a tool call starts with its tool task and ends with its result entry; a turn is a
 * submission from admission to settlement.
 *
 * The listener runs inside Pi's commit and must not throw (a throw faults the user's task), block, or call Pi:
 * everything here is synchronous, reads only the publication and the ledger, and is guarded.
 */
export class PiRunRecorder {
  readonly #telemetry: RunTelemetry
  readonly #ledger: RecorderLedger
  readonly #clock: () => number
  /** Per conversation, the run in progress: its generation task and its submissions. */
  readonly #runs = new Map<string, { readonly taskId: string; readonly inputs: readonly string[] }>()
  /** Submission id to its operation id. */
  readonly #operations = new Map<string, string>()
  /** `assistant entry:call id` to the call's name and argument size, from the answer that made it. */
  readonly #calls = new Map<string, { readonly name: string; readonly attributes: RunAttributes }>()
  /** Per generation task, the attempt in progress. */
  readonly #attempts = new Map<string, { readonly id: string; readonly attempt: number; partial: boolean }>()
  #failures = 0

  constructor(telemetry: RunTelemetry, ledger: RecorderLedger, clock: () => number = nowMillis) {
    this.#telemetry = telemetry
    this.#ledger = ledger
    this.#clock = clock
  }

  /** Follow `session`'s commits until it closes. */
  attach(session: Pick<Session, 'subscribeCommits' | 'subscribeClose'>): void {
    const unsubscribe = session.subscribeCommits((publication) => this.observe(publication))
    session.subscribeClose(unsubscribe)
  }

  observe(publication: CommitPublication): void {
    try {
      this.#observe(publication)
    } catch (error) {
      this.#failures += 1
      if (this.#failures > 5) return
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 300)
      console.warn(JSON.stringify({ level: 'warn', event: 'telemetry', where: 'pi', error: message }))
    }
  }

  #observe(publication: CommitPublication): void {
    const now = this.#clock()
    const { changes } = publication
    // Order matters within one commit: the run before its attempts, an answer before the tool calls it made, an
    // ending before a start (a recovered attempt converts the lost one and starts again in one commit).
    for (const change of changes) this.#live(change, false)
    for (const change of changes) if (change.type === 'submission') this.#admitted(change.value, now)
    for (const change of changes) if (change.type === 'entry') this.#entry(change.value, now)
    for (const change of changes) if (change.type === 'task') this.#task(change.value, publication.seq, now)
    for (const change of changes) if (change.type === 'submission') this.#settled(change.value, now)
    for (const change of changes) this.#live(change, true, now)
  }

  #live(change: Change, partials: boolean, now = 0): void {
    if (change.type !== 'document' || change.record.kind !== 'pi.live' || change.conversationId === undefined) return
    const conversation = String(change.conversationId)
    const live = decodeLive(change.value)
    if (!partials) {
      if (live?.run === undefined) this.#runs.delete(conversation)
      else this.#runs.set(conversation, { taskId: String(live.run.taskId), inputs: live.run.inputs.map(String) })
      return
    }
    // The first committed partial of an attempt: Pi throttles partials, so this is the first chunk within ~100 ms.
    const run = this.#runs.get(conversation)
    if (live?.generation?.message === undefined || run === undefined) return
    const attempt = this.#attempts.get(run.taskId)
    if (attempt === undefined || attempt.partial || attempt.attempt !== live.generation.attempt) return
    attempt.partial = true
    this.#telemetry.annotate(attempt.id, { [RunAttribute.firstPartialAt]: now })
  }

  #operationOf(conversation: string): string | undefined {
    const input = this.#runs.get(conversation)?.inputs[0]
    return input === undefined ? undefined : this.#operations.get(input)
  }

  #scope(conversation: string, taskId?: string) {
    const operationId = this.#operationOf(conversation)
    return {
      conversationId: conversation,
      ...(operationId === undefined ? {} : { operationId }),
      ...(taskId === undefined ? {} : { taskId }),
    }
  }

  #admitted(value: unknown, now: number): void {
    const submission = decodeSubmission(value)
    if (submission === undefined || submission.type !== 'input' || submission.requestId === undefined) return
    const id = String(submission.id)
    remember(this.#operations, id, submission.requestId)
    if (submission.status !== 'queued' && submission.status !== 'placed') return
    const turn = `turn:${id}`
    if (this.#telemetry.isOpen(turn)) return
    this.#telemetry.begin(this.#turn(submission, id, now))
  }

  #turn(submission: typeof Submission.Type, id: string, now: number) {
    const operationId = submission.requestId ?? id
    return {
      id: `turn:${id}`,
      kind: 'turn.submitted' as const,
      conversationId: String(submission.conversationId),
      operationId,
      startedAt: now,
      attributes: { [RunAttribute.operation]: 'invoke_agent', [RunAttribute.source]: sourceOf(operationId) },
    }
  }

  #settled(value: unknown, now: number): void {
    const submission = decodeSubmission(value)
    if (submission === undefined || submission.type !== 'input' || submission.requestId === undefined) return
    if (submission.status !== 'done' && submission.status !== 'unanswered') return
    const id = String(submission.id)
    const detail = typeof submission.detail === 'string' ? { [RunAttribute.error]: submission.detail } : {}
    this.#telemetry.finish(
      `turn:${id}`,
      {
        status: submission.status === 'done' ? 'ok' : 'error',
        endedAt: now,
        attributes:
          submission.status === 'done' ? {} : { [RunAttribute.reason]: submission.reason ?? 'unanswered', ...detail },
      },
      this.#turn(submission, id, now),
    )
  }

  #entry(value: unknown, now: number): void {
    const entry = decodeEntry(value)
    if (entry === undefined || entry.byTaskId === undefined) return
    const conversation = String(entry.conversationId)
    const place = { id: String(entry.id), conversation, taskId: String(entry.byTaskId) }
    if (entry.kind === 'pi.assistant') this.#answered(place, entry.model?.[0], now)
    else if (entry.kind === 'pi.tool-result') this.#toolResult(place, entry.model?.[0], entry.data, now)
  }

  /** An assistant entry ends the attempt that produced it, and names the tool calls it makes. */
  #answered(place: Place, raw: unknown, now: number): void {
    const message = decodeAssistant(raw)
    if (message === undefined) return
    for (const [key, call] of callsOf(place.id, message)) remember(this.#calls, key, call)
    const id = this.#attemptFor(place)
    this.#telemetry.finish(
      id,
      { status: statusOfStop(message.stopReason), endedAt: now, attributes: answerAttributes(message) },
      {
        id,
        kind: 'model.attempt',
        ...this.#scope(place.conversation, place.taskId),
        // Pi stamps a response just before its request goes out.
        startedAt: message.timestamp,
        attributes: { [RunAttribute.operation]: 'chat' },
      },
    )
  }

  /** The attempt an answer belongs to: the one in progress, the ledger's unanswered one after a restart, or its own. */
  #attemptFor(place: Place): string {
    const open = this.#attempts.get(place.taskId)
    this.#attempts.delete(place.taskId)
    if (open !== undefined) return open.id
    const recalled = this.#ledger.latestForTask('model.attempt', place.taskId)
    const unanswered = recalled !== undefined && recalled.attributes[RunAttribute.finishReason] === undefined
    return unanswered ? recalled.id : `model:${place.taskId}:entry:${place.id}`
  }

  /** A tool result ends its tool call; a result the generation wrote itself (the tool was not there) is one event. */
  #toolResult(place: Place, raw: unknown, data: unknown, now: number): void {
    const result = decodeToolResult(raw)
    if (result === undefined) return
    const diagnostics: readonly Diagnostic[] = decodeDiagnostics(data)?.diagnostics ?? []
    const status = toolStatus(
      diagnostics.map((diagnostic) => diagnostic.code),
      result.isError === true,
    )
    const own = `tool:${place.taskId}`
    const started = this.#telemetry.isOpen(own) || this.#ledger.latestForTask('tool.call', place.taskId) !== undefined
    const id = started ? own : `tool:entry:${place.id}`
    this.#telemetry.finish(
      id,
      { status, endedAt: now, attributes: resultAttributes(result, status, diagnostics[0]) },
      {
        id,
        kind: 'tool.call',
        ...this.#scope(place.conversation, place.taskId),
        startedAt: result.timestamp ?? now,
        attributes: { [RunAttribute.operation]: 'execute_tool' },
      },
    )
  }

  #task(value: unknown, seq: number, now: number): void {
    const task = decodeTask(value)
    if (task === undefined) return
    const taskId = String(task.id)
    const conversation = String(task.conversationId)
    const { state } = task
    if (state.outcome !== undefined)
      return this.#ended(task.kind, { id: taskId, conversation, taskId }, state.outcome, now)
    if (task.kind === 'pi.generation') {
      const checkpoint = state.checkpoint
      if (state.status !== 'running' || checkpoint?.phase !== 'request' || checkpoint.attempt === undefined) return
      this.#attemptStarted({ id: String(seq), conversation, taskId }, checkpoint.attempt, checkpoint.model, now)
    } else if (task.kind === 'pi.tool') {
      const id = `tool:${taskId}`
      if (this.#telemetry.isOpen(id)) return
      const input = decodeToolInput(task.input)
      const call = input === undefined ? undefined : this.#calls.get(`${String(input.assistant)}:${input.callId}`)
      this.#telemetry.begin({
        id,
        kind: 'tool.call',
        ...this.#scope(conversation, taskId),
        startedAt: now,
        attributes: {
          [RunAttribute.operation]: 'execute_tool',
          ...(input === undefined ? {} : { [RunAttribute.toolCallId]: input.callId }),
          ...(call === undefined
            ? {}
            : {
                [RunAttribute.toolName]: call.name,
                [RunAttribute.toolFamily]: familyOf(call.name),
                ...call.attributes,
              }),
        },
      })
    } else if (task.kind === 'pi.compaction') {
      const id = `compaction:${taskId}`
      if (this.#telemetry.isOpen(id)) return
      const input = decodeCompactionInput(task.input)
      this.#telemetry.begin({
        id,
        kind: 'compaction',
        ...this.#scope(conversation, taskId),
        startedAt: now,
        attributes: input === undefined ? {} : { [RunAttribute.compactionReason]: input.reason },
      })
    }
  }

  /** A generation entered `request`: an attempt starts. `place.id` is the commit sequence, unique per start. */
  #attemptStarted(
    place: Place,
    attempt: number,
    model: { readonly provider: string; readonly modelId: string } | undefined,
    now: number,
  ): void {
    const { taskId, conversation } = place
    const open = this.#attempts.get(taskId)
    if (open?.attempt === attempt && this.#telemetry.isOpen(open.id)) return
    if (open !== undefined)
      this.#telemetry.finish(open.id, {
        status: 'interrupted',
        endedAt: now,
        attributes: { [RunAttribute.recovery]: 'restarted' },
      })
    const id = `model:${taskId}:${attempt}:${place.id}`
    this.#attempts.set(taskId, { id, attempt, partial: false })
    this.#telemetry.begin({
      id,
      kind: 'model.attempt',
      ...this.#scope(conversation, taskId),
      startedAt: now,
      attributes: {
        [RunAttribute.operation]: 'chat',
        [RunAttribute.attempt]: attempt,
        ...(model === undefined
          ? {}
          : { [RunAttribute.provider]: model.provider, [RunAttribute.requestModel]: model.modelId }),
      },
    })
  }

  /** A task that ended without the entry that normally ends its event: a fault, an abort, a lost definition. */
  #ended(kind: string, place: Place, outcome: Outcome, now: number): void {
    const status = outcomeStatus(outcome)
    const attributes = status === 'ok' ? {} : outcomeAttributes(outcome)
    if (kind === 'pi.generation') {
      const open = this.#attempts.get(place.taskId)
      this.#attempts.delete(place.taskId)
      if (open !== undefined && this.#telemetry.isOpen(open.id))
        this.#telemetry.finish(open.id, { status, endedAt: now, attributes })
    } else if (kind === 'pi.tool' || kind === 'pi.compaction') {
      const id = `${kind === 'pi.tool' ? 'tool' : 'compaction'}:${place.taskId}`
      if (this.#telemetry.isOpen(id)) this.#telemetry.finish(id, { status, endedAt: now, attributes })
    } else if (isFailure(outcome)) {
      // Any other task (a subagent relay, an anchor, an app job) is reported only when it failed.
      this.#telemetry.record({
        id: `task:${place.taskId}`,
        kind: 'error',
        status: 'error',
        ...this.#scope(place.conversation, place.taskId),
        startedAt: now,
        endedAt: now,
        attributes: { [RunAttribute.taskKind]: kind, ...attributes },
      })
    }
  }
}
