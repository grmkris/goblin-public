import { Type } from '@earendil-works/pi-ai'
import type { AssistantMessage, Message, Model, ProviderStreams } from '@earendil-works/pi-ai'
import { createModels, createProvider } from '@earendil-works/pi-ai/models'
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream'
import { createRegistry, defineExtension, defineTool, hook, Harness, ToolTask } from '@earendil-works/pi-durable'
import type { JsonObject } from '@earendil-works/pi-durable'
import { MemoryStorage } from '@earendil-works/pi-durable/storage/memory'
import { RunAttribute, type RunEvent } from '@goblin/contracts/telemetry'
import { describe, expect, it, vi } from 'vitest'
import { BACKGROUND } from '../src/pi/context.ts'
import { CollectedRuns, RunTelemetry, boundAttributes, type RunSink } from '../src/telemetry/events.ts'
import { RunLog } from '../src/telemetry/log.ts'
import { PiRunRecorder, sourceOf } from '../src/telemetry/pi.ts'
import { auxReporter, mcpReporter } from '../src/telemetry/report.ts'
import { CheapModel } from '../src/memory/model.ts'
import { MODEL_PROVIDER } from '../src/pi/model.ts'
import { timed } from '../src/mcp/log.ts'
import { grantRequiredResult } from '../src/mcp/extension.ts'
import { NeedsAuthorization, NotFound, UpstreamMcp } from '../src/http/errors.ts'

const model: Model<'openai-completions'> = {
  id: 'telemetry-fixture',
  name: 'Telemetry fixture',
  provider: 'fixture',
  api: 'openai-completions',
  baseUrl: 'https://no-model-calls.invalid',
  reasoning: false,
  input: ['text'],
  contextWindow: 8192,
  maxTokens: 256,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
}

type Reply = Pick<AssistantMessage, 'content' | 'stopReason' | 'errorMessage'>

/** A scripted model: each request takes the next reply; after a tool result it answers `done`. */
function scripted(replies: Reply[]): ProviderStreams {
  const stream: ProviderStreams['stream'] = (target, context) => {
    const last = context.messages.findLast((message: Message) => message.role !== 'system')
    const reply: Reply =
      last?.role === 'toolResult'
        ? { content: [{ type: 'text', text: 'done' }], stopReason: 'stop' }
        : (replies.shift() ?? { content: [{ type: 'text', text: 'hi' }], stopReason: 'stop' })
    const message: AssistantMessage = {
      role: 'assistant',
      api: target.api,
      provider: target.provider,
      model: target.id,
      usage: {
        input: 10,
        output: 5,
        cacheRead: 2,
        cacheWrite: 0,
        totalTokens: 17,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      timestamp: Date.now(),
      ...reply,
    }
    const output = createAssistantMessageEventStream()
    queueMicrotask(() => {
      output.push({ type: 'start', partial: message })
      if (message.stopReason === 'error') output.push({ type: 'error', reason: 'error', error: message })
      else output.push({ type: 'done', reason: message.stopReason === 'toolUse' ? 'toolUse' : 'stop', message })
      output.end(message)
    })
    return output
  }
  return { stream, streamSimple: stream }
}

const call = (name: string, args: JsonObject): Reply => ({
  content: [{ type: 'toolCall', id: `call-${name}`, name, arguments: args }],
  stopReason: 'toolUse',
})

const tools = defineExtension({
  name: 'telemetry-tools',
  tools: [
    defineTool({
      name: 'echo',
      description: 'echo',
      parameters: Type.Object({ text: Type.String() }),
      replay: 'safe',
      execute: async ({ text }) => ({ content: [{ type: 'text', text }] }),
    }),
    defineTool({
      name: 'mcp_call',
      description: 'stand-in for the resident MCP tool',
      parameters: Type.Object({ serverId: Type.String(), name: Type.String(), arguments: Type.Object({}) }),
      replay: 'unsafe',
      execute: async () => ({ content: [{ type: 'text', text: 'remote said no' }], isError: true }),
    }),
    defineTool({
      name: 'wait_grant',
      description: 'owner decision',
      parameters: Type.Object({}),
      replay: 'safe',
      execute: async () => grantRequiredResult('myplan', 'notes_search'),
    }),
    defineTool({
      name: 'guarded',
      description: 'always blocked',
      parameters: Type.Object({}),
      replay: 'safe',
      execute: async () => ({ content: [{ type: 'text', text: 'never runs' }] }),
    }),
  ],
  hooks: [
    hook(ToolTask, {
      beforeTool: (toolCall) => (toolCall.name === 'guarded' ? { block: 'budget used up' } : undefined),
    }),
  ],
})

/** The newest state of every event, from a sink that also answers the recorder's ledger questions. */
class Collected extends CollectedRuns {
  latestForTask(kind: string, taskId: string) {
    return this.events().findLast((event) => event.kind === kind && event.taskId === taskId)
  }
  read(id: string) {
    return this.events().find((event) => event.id === id)
  }
}

/** One turn through real Pi (in memory) with the recorder attached; returns the run events it recorded. */
async function turn(replies: Reply[], input = 'hello', operationId = 'op-1', extra: readonly RunSink[] = []) {
  const collected = new Collected()
  const telemetry = new RunTelemetry([...extra, collected], (id) => collected.read(id))
  const recorder = new PiRunRecorder(telemetry, collected)
  const models = createModels()
  models.setProvider(
    createProvider({
      id: model.provider,
      models: [model],
      auth: { apiKey: { name: 'keyless fixture', resolve: async () => ({ auth: {} }) } },
      api: scripted(replies),
    }),
  )
  const registry = createRegistry()
  registry.install(tools)
  const pi = await Harness.open(
    new MemoryStorage(),
    { models, registry, settings: { extensions: [tools], retry: { baseDelayMs: 1 } } },
    BACKGROUND,
  )
  recorder.attach(pi)
  const root = await pi.root(BACKGROUND, {
    agent: { model: { provider: model.provider, modelId: model.id }, thinkingLevel: 'off' },
  })
  const settled = await (
    await root.submit({ type: 'input', content: input, requestId: operationId }, BACKGROUND)
  ).wait(BACKGROUND)
  await pi.close(BACKGROUND)
  return { settled, events: collected.events() }
}

const ofKind = (events: readonly RunEvent[], kind: RunEvent['kind']) => events.filter((event) => event.kind === kind)
const throwingReport = () => {
  throw new Error('PRIVATE_CALLBACK_ERROR')
}

describe('run telemetry from Pi commits (unit, in-memory Pi)', () => {
  it('keeps invalid tool arguments and provider error payloads out of telemetry', async () => {
    const privateText = 'PRIVATE_APP_SOURCE_7fd8'
    const provider = await turn([
      { content: [], stopReason: 'error', errorMessage: `provider rejected ${privateText}` },
    ])
    expect(JSON.stringify(provider.events)).not.toContain(privateText)
    expect(ofKind(provider.events, 'model.attempt')).toMatchObject([
      { status: 'error', attributes: { [RunAttribute.error]: 'Model provider failed.' } },
    ])
    const { events } = await turn([call('echo', { source: privateText })])
    expect(JSON.stringify(events)).not.toContain(privateText)
    expect(ofKind(events, 'tool.call')).toMatchObject([
      { status: 'error', attributes: { [RunAttribute.errorType]: 'invalid_arguments' } },
    ])
  })
  it('records a turn: a failed attempt that is retried, a tool round, the answer', async () => {
    const { settled, events } = await turn([
      { content: [], stopReason: 'error', errorMessage: 'HTTP 503 upstream overloaded' },
      call('echo', { text: 'ping' }),
    ])
    expect(settled.status).toBe('done')

    const [turnEvent] = ofKind(events, 'turn.submitted')
    expect(turnEvent).toMatchObject({ status: 'ok', operationId: 'op-1', conversationId: '1' })
    expect(turnEvent?.attributes[RunAttribute.source]).toBe('direct')

    const attempts = ofKind(events, 'model.attempt')
    expect(attempts.map((event) => [event.status, event.attributes[RunAttribute.finishReason]])).toEqual([
      ['error', 'error'],
      ['ok', 'toolUse'],
      ['ok', 'stop'],
    ])
    expect(attempts.map((event) => event.attributes[RunAttribute.attempt])).toEqual([1, 2, 1])
    expect(attempts[0]?.attributes[RunAttribute.error]).toBe('Model provider failed.')
    for (const attempt of attempts) {
      expect(attempt).toMatchObject({ operationId: 'op-1', conversationId: '1' })
      expect(attempt.attributes).toMatchObject({
        [RunAttribute.requestModel]: model.id,
        [RunAttribute.provider]: model.provider,
        [RunAttribute.inputTokens]: 10,
        [RunAttribute.outputTokens]: 5,
        [RunAttribute.cacheReadTokens]: 2,
      })
      expect(attempt.endedAt).toBeGreaterThanOrEqual(attempt.startedAt)
    }

    const [tool] = ofKind(events, 'tool.call')
    expect(tool).toMatchObject({ status: 'ok', operationId: 'op-1' })
    expect(tool?.attributes).toMatchObject({
      [RunAttribute.toolName]: 'echo',
      [RunAttribute.toolCallId]: 'call-echo',
      [RunAttribute.toolFamily]: 'builtin',
      [RunAttribute.argumentBytes]: JSON.stringify({ text: 'ping' }).length,
    })
    // Telemetry never carries content: no prompt, answer or tool text in any attribute.
    expect(JSON.stringify(events)).not.toMatch(/hello|ping|done"/u)
  })

  it('names the MCP server and tool of an mcp_call, and records its failure', async () => {
    const { events } = await turn([call('mcp_call', { serverId: 'myplan', name: 'notes_search', arguments: {} })])
    const [tool] = ofKind(events, 'tool.call')
    expect(tool?.status).toBe('error')
    expect(tool?.attributes).toMatchObject({
      [RunAttribute.toolFamily]: 'mcp',
      [RunAttribute.mcpServer]: 'myplan',
      [RunAttribute.mcpTool]: 'notes_search',
    })
  })

  it('records a call a hook blocked, and a call to a tool that is not there', async () => {
    const blocked = await turn([call('guarded', {})])
    expect(ofKind(blocked.events, 'tool.call')).toMatchObject([
      { status: 'blocked', attributes: { [RunAttribute.blockedReason]: 'Execution blocked.' } },
    ])
    const missing = await turn([call('nonexistent', {})])
    expect(ofKind(missing.events, 'tool.call')).toMatchObject([
      { status: 'error', attributes: { [RunAttribute.errorType]: 'tool_unavailable' } },
    ])
  })

  it('classifies owner grant waits and empty remote failures without copying private details', async () => {
    const blocked = await turn([call('wait_grant', {})])
    expect(ofKind(blocked.events, 'tool.call')).toMatchObject([
      {
        status: 'blocked',
        attributes: { [RunAttribute.errorType]: 'GrantDenied', [RunAttribute.blockedReason]: 'Owner grant required.' },
      },
    ])
    const failed = await turn([call('mcp_call', { serverId: 'myplan', name: 'notes_search', arguments: {} })])
    expect(ofKind(failed.events, 'tool.call')).toMatchObject([
      { status: 'error', attributes: { [RunAttribute.errorType]: 'tool_error', [RunAttribute.error]: 'Tool failed.' } },
    ])
  })

  it('records cutoffs and empty final answers without replaying them', async () => {
    const cutoff = await turn([{ content: [{ type: 'text', text: 'partial' }], stopReason: 'length' }])
    expect(ofKind(cutoff.events, 'model.attempt')).toMatchObject([
      { status: 'ok', attributes: { [RunAttribute.cutoff]: true, [RunAttribute.finishReason]: 'length' } },
    ])
    const empty = await turn([{ content: [], stopReason: 'stop' }])
    expect(ofKind(empty.events, 'model.attempt')).toMatchObject([
      { status: 'ok', attributes: { [RunAttribute.emptyAnswer]: true } },
    ])
    expect(ofKind(empty.events, 'model.attempt')).toHaveLength(1)
  })

  it('keeps the turn running when a sink throws', async () => {
    const failing: RunSink = {
      name: 'failing',
      started: () => {
        throw new Error('disk full')
      },
      ended: () => {
        throw new Error('disk full')
      },
    }
    const { settled, events } = await turn([call('echo', { text: 'x' })], 'hello', 'op-2', [failing])
    expect(settled.status).toBe('done')
    expect(ofKind(events, 'turn.submitted')).toMatchObject([{ status: 'ok', operationId: 'op-2' }])
  })
})

describe('run telemetry (unit)', () => {
  it('logs each ended event as one `run` line of ids, timing and allowlisted attributes', () => {
    const info = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const log = new RunLog(() => 'user-1')
      const ended: RunEvent = {
        id: 'tool:t1',
        kind: 'tool.call',
        status: 'error',
        conversationId: '1',
        operationId: 'telegram-12',
        taskId: 't1',
        startedAt: 10,
        endedAt: 250,
        attributes: { [RunAttribute.toolName]: 'mcp_call', [RunAttribute.errorType]: 'Internal', note: 'my notes' },
      }
      log.ended(ended)
      log.ended({ ...ended, id: 'tool:t2', status: 'blocked', attributes: { [RunAttribute.errorType]: 'GrantDenied' } })
      expect(warn).toHaveBeenCalledTimes(1)
      expect(JSON.parse(String(warn.mock.calls[0]?.[0]))).toEqual({
        level: 'warn',
        event: 'run',
        kind: 'tool.call',
        status: 'error',
        agent: 'user-1',
        conversation: '1',
        operation: 'telegram-12',
        task: 't1',
        id: 'tool:t1',
        ms: 240,
        [RunAttribute.toolName]: 'mcp_call',
        [RunAttribute.errorType]: 'Internal',
      })
      expect(JSON.parse(String(info.mock.calls[0]?.[0]))).toMatchObject({ level: 'info', id: 'tool:t2' })
    } finally {
      info.mockRestore()
      warn.mockRestore()
    }
  })

  it('names where a turn came from by its operation id', () => {
    expect(sourceOf('telegram-tg-123')).toBe('telegram')
    expect(sourceOf('routine-input:rr_1:op')).toBe('routine')
    expect(sourceOf('subagent-report:7')).toBe('subagent_report')
    expect(sourceOf('subagent:7')).toBe('subagent')
    expect(sourceOf('persona:owner:op-3:2')).toBe('persona')
    // A thread start writes `thread-started:<chat>` passively; it never submits a turn, so it names no source.
    expect(sourceOf('thread-started:12')).toBe('direct')
    expect(sourceOf('5f0c2b9e-1d1e-4a7a-9f0e-1c1c1c1c1c1c')).toBe('direct')
  })

  it('bounds attributes and marks what it shortened', () => {
    const bounded = boundAttributes({ [RunAttribute.error]: 'x'.repeat(2000), keep: 1 })
    expect(bounded).toEqual({ [RunAttribute.error]: 'Unclassified failure.' })
    const many = boundAttributes(Object.fromEntries(Object.values(RunAttribute).map((key) => [key, 'v'.repeat(160)])))
    expect(JSON.stringify(many).length).toBeLessThanOrEqual(2088)
    expect(many[RunAttribute.truncated]).toBe(true)
  })

  it('ends an event that started before a restart from the ledger, and says it resumed', () => {
    const collected = new Collected()
    const before = new RunTelemetry([collected], (id) => collected.read(id))
    before.begin({ id: 'turn:7', kind: 'turn.submitted', operationId: 'op', startedAt: 1, attributes: {} })
    // The restart sweep marks what was started as interrupted; a new object ends it when Pi settles it.
    const started = collected.read('turn:7')
    if (started === undefined) throw new Error('turn:7 was not recorded')
    collected.ended({ ...started, status: 'interrupted', endedAt: 2 })
    const after = new RunTelemetry([collected], (id) => collected.read(id))
    after.finish('turn:7', { status: 'ok', endedAt: 3 })
    expect(collected.read('turn:7')).toMatchObject({
      status: 'ok',
      startedAt: 1,
      endedAt: 3,
      attributes: { [RunAttribute.recovery]: 'resumed' },
    })
  })
})

describe('run telemetry outside Pi (unit)', () => {
  const cheapModels = (replies: Reply[]) => {
    const models = createModels()
    models.setProvider(
      createProvider({
        id: MODEL_PROVIDER,
        models: [{ ...model, provider: MODEL_PROVIDER }],
        auth: { apiKey: { name: 'keyless fixture', resolve: async () => ({ auth: {} }) } },
        api: scripted(replies),
      }),
    )
    return models
  }

  it('records a cheap model call with its purpose and tokens, and a failed one', async () => {
    const collected = new CollectedRuns()
    const telemetry = new RunTelemetry([collected])
    let spent = 0
    const replies: Reply[] = [
      { content: [{ type: 'text', text: 'Trip plans' }], stopReason: 'stop' },
      { content: [], stopReason: 'error', errorMessage: 'HTTP 429 rate limited' },
    ]
    const namer = new CheapModel(
      cheapModels(replies),
      model.id,
      (use) => (spent += use.input + use.output + use.cacheRead + use.cacheWrite),
      auxReporter(telemetry, 'naming'),
    )
    await expect(namer.complete('Name this thread.', 'we talked about trips', 20)).resolves.toBe('Trip plans')
    await expect(namer.complete('Name this thread.', 'again', 20)).rejects.toMatchObject({
      _tag: 'ModelFailed',
      detail: 'HTTP 429 rate limited',
    })
    expect(spent).toBe(34)
    expect(collected.events()).toMatchObject([
      {
        kind: 'model.aux',
        status: 'ok',
        attributes: {
          [RunAttribute.purpose]: 'naming',
          [RunAttribute.inputTokens]: 10,
          [RunAttribute.outputTokens]: 5,
        },
      },
      {
        kind: 'model.aux',
        status: 'error',
        attributes: { [RunAttribute.purpose]: 'naming', [RunAttribute.error]: 'Model provider failed.' },
      },
    ])
    expect(JSON.stringify(collected.events())).not.toMatch(/trips|Trip plans/u)
  })

  it('records authorization waits as blocked and keeps logger failures separate from call results', async () => {
    const collected = new CollectedRuns()
    const report = mcpReporter(new RunTelemetry([collected]))
    await expect(
      timed(
        { step: 'connect', serverId: 'myplan' },
        () => Promise.reject(new NeedsAuthorization({ serverId: 'myplan' })),
        report,
      ),
    ).rejects.toBeInstanceOf(NeedsAuthorization)
    expect(collected.events()).toMatchObject([
      { status: 'blocked', attributes: { [RunAttribute.errorType]: 'NeedsAuthorization' } },
    ])
    let calls = 0
    await expect(timed({ step: 'call', serverId: 'myplan' }, async () => ++calls, throwingReport)).resolves.toBe(1)
    const original = new NotFound({ what: 'fixture' })
    await expect(
      timed({ step: 'call', serverId: 'myplan' }, () => Promise.reject(original), throwingReport),
    ).rejects.toBe(original)
    expect(calls).toBe(1)
  })

  it('correlates explicit MCP scopes with exactly their tool tasks', () => {
    const collected = new CollectedRuns()
    const telemetry = new RunTelemetry([collected])
    const report = mcpReporter(telemetry)
    telemetry.begin({
      id: 'tool:one',
      kind: 'tool.call',
      conversationId: '1',
      operationId: 'one-op',
      taskId: 'one',
      startedAt: 1,
      attributes: {},
    })
    telemetry.begin({
      id: 'tool:two',
      kind: 'tool.call',
      conversationId: '2',
      operationId: 'two-op',
      taskId: 'two',
      startedAt: 1,
      attributes: {},
    })
    report({ step: 'call', serverId: 'myplan', scope: { conversationId: '2', taskId: 'two' } }, 'ok', 2, 3)
    report({ step: 'call', serverId: 'myplan', scope: { conversationId: '1', taskId: 'one' } }, 'ok', 2, 3)
    report({ step: 'connect', serverId: 'myplan', sharedConnection: true }, 'ok', 2, 3)
    expect(ofKind(collected.events(), 'mcp.request')).toMatchObject([
      { operationId: 'two-op', conversationId: '2' },
      { operationId: 'one-op', conversationId: '1' },
      { attributes: { [RunAttribute.sharedConnection]: true } },
    ])
    expect(ofKind(collected.events(), 'mcp.request')[2]?.operationId).toBeUndefined()
  })

  it('records each remote MCP step, and a failed one by its tag', async () => {
    const collected = new CollectedRuns()
    const report = mcpReporter(new RunTelemetry([collected]))
    await timed({ step: 'call', serverId: 'myplan', tool: 'notes_search' }, async () => 'ok', report)
    await expect(
      timed(
        { step: 'connect', serverId: 'myplan' },
        () => Promise.reject(new UpstreamMcp({ serverId: 'myplan', reason: 'timeout' })),
        report,
      ),
    ).rejects.toThrow()
    expect(collected.events()).toMatchObject([
      {
        kind: 'mcp.request',
        status: 'ok',
        attributes: {
          [RunAttribute.mcpStep]: 'call',
          [RunAttribute.mcpServer]: 'myplan',
          [RunAttribute.mcpTool]: 'notes_search',
        },
      },
      {
        kind: 'mcp.request',
        status: 'error',
        attributes: { [RunAttribute.mcpStep]: 'connect', [RunAttribute.errorType]: 'UpstreamMcp:timeout' },
      },
    ])
  })
})
