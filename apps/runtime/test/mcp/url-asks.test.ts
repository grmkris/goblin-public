import { describe, expect, it } from 'vitest'
import { managerOf } from './manager.ts'
import { MemoryGrants } from './memory.ts'
import { APPROVE, SIDEQUEST, sidequestServer, urlAsk } from './sidequest-fixture.ts'

/** The Sidequest-like server and a manager whose one grant is `create_agent`. */
const sidequest = (ask?: (url: string) => Record<string, unknown>) => {
  const { seen, state, fetch } = sidequestServer(ask)
  const manager = managerOf({
    servers: [SIDEQUEST],
    allows: (grant) =>
      new MemoryGrants([{ connectionId: 'sq', capability: 'tool', name: 'create_agent' }]).allows(grant),
    auth: () => ({ token: async () => 'fixture' }),
    fetch,
  })
  return { seen, state, manager }
}

describe("the model's calls and URL requests (unit, ADR 0042)", () => {
  it('declares URL elicitation only on a model call, and reads the link the server asks the owner to open', async () => {
    const { seen, manager } = sidequest()
    try {
      const asked = await manager.connections.callModelTool('sq', 'create_agent', { name: 'Worker' })
      expect(asked).toEqual({
        kind: 'url',
        prompt: { inputKey: 'approval', requestState: 'op_1', url: APPROVE, message: 'Approve the new agent.' },
      })
      // The owner's console, an App and an approval's dispatch never declare it: the server answers as before.
      const plain = await manager.connections.callTool('sq', 'create_agent', { name: 'Worker' }, { caller: 'human' })
      expect(plain).toMatchObject({ isError: true, content: [{ text: `Approval needed: ${APPROVE}` }] })
      expect(seen.map(({ url }) => url)).toEqual([true, false])
    } finally {
      await manager.dispose()
    }
  })

  it('retries with the answer and the request state, waits again while pending, then takes the checked result', async () => {
    const { seen, state, manager } = sidequest()
    try {
      const answer = { inputKey: 'approval', action: 'accept' as const, requestState: 'op_1' }
      const pending = await manager.connections.callModelTool('sq', 'create_agent', { name: 'Worker' }, { answer })
      expect(pending).toMatchObject({ kind: 'url', prompt: { requestState: 'op_1' } })
      state.approved = true
      const done = await manager.connections.callModelTool('sq', 'create_agent', { name: 'Worker' }, { answer })
      expect(done).toMatchObject({ kind: 'complete', result: { structuredContent: { agent: 'ag_1' } } })
      expect(seen.at(-1)).toEqual({ url: true, answer: { action: 'accept' }, state: 'op_1' })
      // A complete result is still checked against the tool's output schema.
      state.wrongOutput = true
      await expect(
        manager.connections.callModelTool('sq', 'create_agent', { name: 'Worker' }, { answer }),
      ).rejects.toMatchObject({ _tag: 'UpstreamMcp', reason: 'remote-rpc' })
    } finally {
      await manager.dispose()
    }
  })

  // A form is refused before goblin reads it: goblin declares URL elicitation only, so it is a protocol error.
  it.each([
    [
      'a form',
      'remote-rpc',
      () => ({
        approval: {
          method: 'elicitation/create',
          params: { mode: 'form', message: 'Your name?', requestedSchema: { type: 'object', properties: {} } },
        },
      }),
    ],
    ['two requests', 'unsupported', (url: string) => ({ approval: urlAsk(url), again: urlAsk(url) })],
    ['a plain http link', 'unsupported', () => ({ approval: urlAsk('http://sq.test/approve') })],
    ['a link with credentials', 'unsupported', () => ({ approval: urlAsk('https://user:pw@sq.test/approve') })],
  ])('refuses what it cannot show the owner: %s', async (_case, reason, ask) => {
    const { manager } = sidequest(ask)
    try {
      await expect(manager.connections.callModelTool('sq', 'create_agent', {})).rejects.toMatchObject({
        _tag: 'UpstreamMcp',
        reason,
      })
    } finally {
      await manager.dispose()
    }
  })
})
