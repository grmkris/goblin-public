import { type CommitPublication, type Harness, type Session } from '@earendil-works/pi-durable'
import { RunAttribute, type RunAttributes, type RunEvent, type RunEventKind } from '@goblin/contracts/telemetry'
import { nowMillis } from '../clock.ts'
import { BACKGROUND, type PiContext } from '../pi/context.ts'
import { answerAttributes, statusOfStop } from './attributes.ts'
import { expectedFailure, failureSummary, safeErrorType, safeFailureCode } from './safety.ts'
import type { RunTelemetry } from './events.ts'
import { rehydrateTelemetry } from './rehydrate.ts'
import {
  decodeEntry,
  decodeAssistant,
  decodeToolResult,
  decodeDiagnostics,
  decodeTask,
  decodeToolInput,
  decodeCompactionInput,
  decodeSubmission,
  decodeLive,
  decodeMcpCall,
} from './pi-records.ts'

/** What the recorder reads from the ledger after a restart: the newest event for a Pi task. */
export type RecorderLedger = {
  readonly latestForTask: (
    kind: RunEventKind,
    taskId: string,
  ) =>
    | {
        readonly id: string
        readonly status: string
        readonly attributes: RunAttributes
        readonly operationId?: string | undefined
      }
    | undefined
  readonly read?: (id: string) => { readonly operationId?: string | undefined } | undefined
  readonly forOperation?: (operationId: string) => readonly RunEvent[]
}

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
    : tool === 'subagent' || tool.startsWith('subagent_')
      ? 'subagent'
      : tool === 'zoom'
        ? 'memory'
        : tool.startsWith('app_') || tool === 'code_run'
          ? 'app'
          : 'builtin'

const sizeOf = (value: unknown): number => JSON.stringify(value ?? null).length

type Assistant = NonNullable<ReturnType<typeof decodeAssistant>>
type Outcome = NonNullable<NonNullable<ReturnType<typeof decodeTask>>['state']['outcome']>
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
  if (codes.includes('blocked') || codes.some(expectedFailure)) return 'blocked'
  if (codes.includes('interrupted') || codes.includes('aborted')) return 'interrupted'
  return isError ? 'error' : 'ok'
}

/** What a tool result tells about its call: name, size, and the first diagnostic as the reason. */
function resultAttributes(
  result: NonNullable<ReturnType<typeof decodeToolResult>>,
  status: string,
  first: Diagnostic | undefined,
): RunAttributes {
  const code = safeFailureCode(first?.code ?? (status === 'error' ? 'tool_error' : status))
  const reason =
    status === 'ok'
      ? {}
      : {
          [status === 'blocked' ? RunAttribute.blockedReason : RunAttribute.error]: failureSummary(code),
          [RunAttribute.errorType]: code,
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
  ...(outcome.error === undefined
    ? {}
    : {
        [RunAttribute.errorType]: safeErrorType(outcome.error),
        [RunAttribute.error]: failureSummary(safeErrorType(outcome.error)),
      }),
  ...(outcome.reason === undefined
    ? {}
    : {
        [RunAttribute.errorType]: safeFailureCode(outcome.reason),
        [RunAttribute.error]: failureSummary(outcome.reason),
      }),
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

  /** Rehydrate live correlation while the newly opened harness is paused. Never called inside a commit listener. */
  async restore(harness: Harness, context: PiContext = BACKGROUND): Promise<void> {
    try {
      const state = await rehydrateTelemetry(harness, context)
      for (const [id, operation] of state.operations) remember(this.#operations, id, operation)
      for (const [conversation, run] of state.runs) this.#runs.set(conversation, run)
    } catch (error) {
      console.warn(JSON.stringify({ level: 'warn', event: 'telemetry', where: 'restore', error: safeErrorType(error) }))
    }
  }

  observe(publication: CommitPublication): void {
    try {
      this.#observe(publication)
    } catch (error) {
      this.#failures += 1
      if (this.#failures > 5) return
      const message = safeErrorType(error)
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
    for (const change of changes) this.#clearLive(change)
  }

  #clearLive(change: Change): void {
    if (change.type !== 'document' || change.record.kind !== 'pi.live' || change.conversationId === undefined) return
    if (decodeLive(change.value)?.run === undefined) this.#runs.delete(String(change.conversationId))
  }

  #live(change: Change, partials: boolean, now = 0): void {
    if (change.type !== 'document' || change.record.kind !== 'pi.live' || change.conversationId === undefined) return
    const conversation = String(change.conversationId)
    const live = decodeLive(change.value)
    if (!partials) {
      if (live?.run !== undefined)
        this.#runs.set(conversation, { taskId: String(live.run.taskId), inputs: live.run.inputs.map(String) })
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
    return input === undefined
      ? undefined
      : (this.#operations.get(input) ?? this.#ledger.read?.(`turn:${input}`)?.operationId)
  }

  #scope(conversation: string, taskId?: string) {
    const operationId = this.#operationOf(conversation) ?? this.#taskOperation(taskId)
    return {
      conversationId: conversation,
      ...(operationId === undefined ? {} : { operationId }),
      ...(taskId === undefined ? {} : { taskId }),
    }
  }

  #taskOperation(taskId: string | undefined): string | undefined {
    if (taskId === undefined) return undefined
    return (
      this.#ledger.latestForTask('model.attempt', taskId)?.operationId ??
      this.#ledger.latestForTask('tool.call', taskId)?.operationId
    )
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

  #turn(submission: NonNullable<ReturnType<typeof decodeSubmission>>, id: string, now: number) {
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
    const detail =
      typeof submission.detail === 'string' ? { [RunAttribute.errorType]: safeFailureCode(submission.detail) } : {}
    const events = this.#ledger.forOperation?.(submission.requestId)
    const coverage =
      submission.status === 'done' && submission.answer !== undefined && events !== undefined
        ? {
            [RunAttribute.coverageGap]: !events.some(
              (event) => event.attributes[RunAttribute.entry] === Number(submission.answer),
            ),
          }
        : {}
    this.#telemetry.finish(
      `turn:${id}`,
      {
        status:
          submission.status === 'done'
            ? 'ok'
            : expectedFailure(submission.reason) || expectedFailure(submission.detail)
              ? 'blocked'
              : 'error',
        endedAt: now,
        attributes:
          submission.status === 'done'
            ? coverage
            : { [RunAttribute.reason]: submission.reason ?? 'unanswered', ...detail },
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
    const emptyAnswer =
      message.stopReason === 'stop' &&
      !message.content.some((block) => block.type === 'text' && block.text !== undefined && block.text.trim() !== '')
    this.#telemetry.finish(
      id,
      {
        status: statusOfStop(message.stopReason),
        endedAt: now,
        attributes: { ...answerAttributes({ ...message, emptyAnswer }), [RunAttribute.entry]: Number(place.id) },
      },
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
      {
        status,
        endedAt: now,
        attributes: { ...resultAttributes(result, status, diagnostics[0]), [RunAttribute.entry]: Number(place.id) },
      },
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
      if (this.#telemetry.isOpen(id) || this.#ledger.latestForTask('tool.call', taskId) !== undefined) return
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
