import { Type, type AssistantMessage, type Model, type ProviderStreams } from '@earendil-works/pi-ai'
import { createModels, createProvider } from '@earendil-works/pi-ai/models'
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream'
import { createRegistry, defineExtension, defineTool, Harness } from '@earendil-works/pi-durable'
import { MemoryStorage } from '@earendil-works/pi-durable/storage/memory'
import { RunAttribute } from '@goblin/contracts/telemetry'
import { describe, expect, it } from 'vitest'
import { BACKGROUND } from '../src/pi/context.ts'
import { CollectedRuns, RunTelemetry } from '../src/telemetry/events.ts'
import { PiRunRecorder } from '../src/telemetry/pi.ts'

const model: Model<'openai-completions'> = {
  id: 'recovery-fixture',
  name: 'Recovery fixture',
  provider: 'fixture',
  api: 'openai-completions',
  baseUrl: 'https://no-model-calls.invalid',
  reasoning: false,
  input: ['text'],
  contextWindow: 8192,
  maxTokens: 256,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
}
class Ledger extends CollectedRuns {
  read(id: string) {
    return this.events().find((event) => event.id === id)
  }
  latestForTask(kind: string, taskId: string) {
    return this.events().findLast((event) => event.kind === kind && event.taskId === taskId)
  }
  forOperation(operationId: string) {
    return this.events().filter((event) => event.operationId === operationId)
  }
}

const echo = defineExtension({
  name: 'recovery-tools',
  tools: [
    defineTool({
      name: 'echo',
      description: 'echo',
      parameters: Type.Object({ text: Type.String() }),
      replay: 'safe',
      execute: async ({ text }) => ({ content: [{ type: 'text', text }] }),
    }),
  ],
})

function controlledModel() {
  let started = 0
  const releases: (() => void)[] = []
  const ready = Promise.withResolvers<void>()
  const stream: ProviderStreams['stream'] = (target, context) => {
    const toolRound = context.messages.at(-1)?.role !== 'toolResult'
    const message: AssistantMessage = {
      role: 'assistant',
      api: target.api,
      provider: target.provider,
      model: target.id,
      content: toolRound
        ? [{ type: 'toolCall', id: `call-${++started}`, name: 'echo', arguments: { text: 'private fixture' } }]
        : [{ type: 'text', text: 'done' }],
      stopReason: toolRound ? 'toolUse' : 'stop',
      timestamp: Date.now(),
      usage: {
        input: 10,
        output: 5,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 15,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    }
    const output = createAssistantMessageEventStream()
    const finish = () => {
      output.push({ type: 'done', reason: toolRound ? 'toolUse' : 'stop', message })
      output.end(message)
    }
    if (toolRound) {
      releases.push(finish)
      if (started === 2) ready.resolve()
    } else queueMicrotask(finish)
    return output
  }
  return {
    api: { stream, streamSimple: stream },
    ready: ready.promise,
    release: () => releases.forEach((finish) => finish()),
  }
}

describe('recorder reconstruction (real in-memory Pi)', () => {
  it('restores simultaneous conversations and correlates their tools and final answers', async () => {
    const provider = controlledModel()
    const models = createModels()
    models.setProvider(
      createProvider({
        id: model.provider,
        models: [model],
        auth: { apiKey: { name: 'keyless fixture', resolve: async () => ({ auth: {} }) } },
        api: provider.api,
      }),
    )
    const registry = createRegistry()
    registry.install(echo)
    const pi = await Harness.open(
      new MemoryStorage(),
      { models, registry, settings: { extensions: [echo] } },
      BACKGROUND,
    )
    const ledger = new Ledger()
    const before = new PiRunRecorder(new RunTelemetry([ledger], (id) => ledger.read(id)), ledger)
    let detach: (() => void) | undefined
    before.attach({
      subscribeCommits: (listener) => {
        detach = pi.subscribeCommits(listener)
        return detach
      },
      subscribeClose: (listener) => pi.subscribeClose(listener),
    })
    const agent = { model: { provider: model.provider, modelId: model.id }, thinkingLevel: 'off' as const }
    const root = await pi.root(BACKGROUND, { agent })
    const side = await pi.createConversation({ ownership: { kind: 'ownerless' }, agent }, BACKGROUND)
    const first = await root.submit({ type: 'input', content: 'main', requestId: 'main-op' }, BACKGROUND)
    const second = await side.submit({ type: 'input', content: 'side', requestId: 'side-op' }, BACKGROUND)
    await provider.ready
    detach?.()
    const after = new PiRunRecorder(new RunTelemetry([ledger], (id) => ledger.read(id)), ledger)
    after.attach(pi)
    await after.restore(pi)
    provider.release()
    const settled = await Promise.all([first.wait(BACKGROUND), second.wait(BACKGROUND)])
    expect(settled.map((receipt) => receipt.status)).toEqual(['done', 'done'])
    for (const [operationId, conversation, answer] of [
      ['main-op', String(root.id), Number(settled[0]?.answer)],
      ['side-op', String(side.id), Number(settled[1]?.answer)],
    ] as const) {
      const events = ledger.forOperation(operationId)
      expect(events.filter((event) => event.kind === 'model.attempt')).toHaveLength(2)
      expect(events.filter((event) => event.kind === 'tool.call')).toHaveLength(1)
      expect(events.every((event) => event.conversationId === conversation)).toBe(true)
      expect(events.some((event) => event.attributes[RunAttribute.entry] === answer)).toBe(true)
      expect(events.find((event) => event.kind === 'turn.submitted')?.attributes[RunAttribute.coverageGap]).toBe(false)
    }
    expect(JSON.stringify(ledger.events())).not.toContain('private fixture')
    await pi.close(BACKGROUND)
  })
})
