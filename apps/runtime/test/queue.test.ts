import { describe, expect, it } from 'vitest'
import { createRegistry, defineExtension, defineTool, Harness, watchEvents } from '@earendil-works/pi-durable'
import { MemoryStorage } from '@earendil-works/pi-durable/storage/memory'
import { Type } from '@earendil-works/pi-ai'
import { queuedInputs, withdrawQueuedInput } from '../src/conversation-queue.ts'
import { BACKGROUND } from '../src/pi/context.ts'
import { authoredContent, ownerContent } from '../src/pi/content.ts'
import { fixtureModels, model } from './integration/model.ts'

async function heldQueue() {
  const release = Promise.withResolvers<void>()
  const entered = Promise.withResolvers<void>()
  const extension = defineExtension({
    name: 'queue-fixture',
    tools: [
      defineTool({
        name: 'hold',
        description: 'Bounded local test gate',
        parameters: Type.Object({}),
        replay: 'safe',
        execute: async () => {
          entered.resolve()
          await release.promise
          return { content: [{ type: 'text', text: 'released' }] }
        },
      }),
    ],
  })
  const registry = createRegistry()
  registry.install(extension)
  const pi = await Harness.open(
    new MemoryStorage(),
    {
      models: fixtureModels(),
      registry,
      settings: { extensions: [extension] },
    },
    BACKGROUND,
  )
  const root = await pi.root(BACKGROUND, {
    agent: { model: { provider: model.provider, modelId: model.id }, thinkingLevel: 'off' },
  })
  const first = await root.submit({ type: 'input', content: 'call hold {}', requestId: 'first' }, BACKGROUND)
  await entered.promise
  return { pi, root, first, release: release.resolve }
}

describe('queued content from real Pi (in memory, keyless fixture)', () => {
  it('keeps native order, duplicate text, metadata and authors, excludes writes, then places follow-ups in the transcript', async () => {
    const { pi, root, first, release } = await heldQueue()
    try {
      const content = ownerContent(
        'same words',
        [{ origin: { serverId: 'board' }, text: 'shared' }],
        [{ path: '/uploads/file.txt', name: 'file.txt', mimeType: 'text/plain', size: 3 }],
      )
      const second = await root.submit({ type: 'input', content, requestId: 'second' }, BACKGROUND)
      const third = await root.submit({ type: 'input', content, requestId: 'third' }, BACKGROUND)
      const authored = authoredContent('Telegram', 'from phone')
      const fourth = await root.submit({ type: 'input', content: authored, requestId: 'fourth' }, BACKGROUND)
      await root.submit({ type: 'write', entry: { kind: 'fixture.note' }, requestId: 'passive' }, BACKGROUND)
      const before = await queuedInputs(pi, String(root.id))
      expect(before.inputs).toEqual([
        { id: second.id, mode: 'followUp', content },
        { id: third.id, mode: 'followUp', content },
        { id: fourth.id, mode: 'followUp', content: authored },
      ])
      expect((await second.status(BACKGROUND)).status).toBe('queued')
      release()
      await first.wait(BACKGROUND)
      await fourth.wait(BACKGROUND)
      expect((await third.status(BACKGROUND)).status).toBe('done')
      expect(await queuedInputs(pi, String(root.id))).toEqual({ inputs: [] })
      const events = await watchEvents(pi, root.id, BACKGROUND)
      expect(
        events.snapshot.entries.flatMap((entry) => entry.model ?? []).filter((message) => message.role === 'user'),
      ).toHaveLength(4)
      await events.stop()
    } finally {
      release()
      await pi.close(BACKGROUND)
    }
  })

  it('withdraws only a queued input, leaves the held run alive, and makes repeats safe', async () => {
    const { pi, root, first, release } = await heldQueue()
    try {
      const queued = await root.submit({ type: 'input', content: 'remove me', requestId: 'remove-me' }, BACKGROUND)
      expect((await queued.status(BACKGROUND)).status).toBe('queued')
      expect(await withdrawQueuedInput(pi, String(root.id), queued.id)).toEqual({ status: 'removed' })
      expect(await withdrawQueuedInput(pi, String(root.id), queued.id)).toEqual({ status: 'already_settled' })
      const write = await root.submit({ type: 'write', entry: { kind: 'fixture.note' } }, BACKGROUND)
      expect(await withdrawQueuedInput(pi, String(root.id), write.id)).toEqual({ status: 'not_found' })
      expect((await write.status(BACKGROUND)).status).toBe('queued')
      expect(await withdrawQueuedInput(pi, '999', first.id)).toEqual({ status: 'not_found' })
      expect(await withdrawQueuedInput(pi, String(root.id), Number.MAX_SAFE_INTEGER)).toEqual({ status: 'not_found' })
      expect(await withdrawQueuedInput(pi, String(root.id), first.id)).toEqual({ status: 'already_started' })
      expect((await first.status(BACKGROUND)).status).toBe('placed')
      release()
      await first.wait(BACKGROUND)
      expect(await queuedInputs(pi, String(root.id))).toEqual({ inputs: [] })
    } finally {
      release()
      await pi.close(BACKGROUND)
    }
  })
})
