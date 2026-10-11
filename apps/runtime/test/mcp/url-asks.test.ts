import { createMcpHandler } from '@modelcontextprotocol/server'
import { describe, expect, it } from 'vitest'
import { declaresUrlElicitation, lowLevelServer } from './low-level-server.ts'
import { managerOf } from './manager.ts'
import { MemoryGrants } from './memory.ts'

const serverConfig = { connectionId: 'sq', endpoint: 'https://sq.test/mcp' }
const APPROVE = 'https://sq.test/approve/op_1?token=one-time'

/** What a call carried, as the fixture saw it. */
type Seen = { readonly url: boolean; readonly answer: unknown; readonly state: unknown }

/**
 * A Sidequest-like server (ADR 0042): `create_agent` needs the operator's approval. A request that declares URL
 * elicitation gets "input required: open this URL" with request state `op_1` until it comes back accepted with that
 * state; one that does not gets today's link in the text. `ask` changes what it asks, to test what goblin refuses.
 */
const sidequest = (ask: (url: string) => Record<string, unknown> = (url) => ({ approval: urlAsk(url) })) => {
  const seen: Seen[] = []
  const state = { approved: false, wrongOutput: false }
  const official = createMcpHandler(() => {
    const server = lowLevelServer({ name: 'sq', version: '1.0.0' }, { capabilities: { tools: {} } })
    server.setRequestHandler('tools/list', () => ({
      tools: [
        {
          name: 'create_agent',
          inputSchema: { type: 'object' as const, properties: { name: { type: 'string' } } },
          outputSchema: {
            type: 'object' as const,
            properties: { agent: { type: 'string' } },
            required: ['agent'],
          },
        },
      ],
    }))
    server.setRequestHandler('tools/call', (_request, ctx) => {
      // The server SDK lifts the request's envelope, input responses and state out of the params.
      const { envelope, inputResponses } = ctx.mcpReq
      const requestState = ctx.mcpReq.requestState?.<string>()
      const url = declaresUrlElicitation(envelope)
      seen.push({ url, answer: inputResponses?.['approval'], state: requestState })
      const accepted = JSON.stringify(inputResponses?.['approval']) === '{"action":"accept"}'
      if (url && !(accepted && requestState === 'op_1' && state.approved))
        // SAFETY: the 2026 server seam takes a hand-built input_required result in place of a CallToolResult.
        return { resultType: 'input_required', inputRequests: ask(APPROVE), requestState: 'op_1' } as never
      if (!url) return { content: [{ type: 'text', text: `Approval needed: ${APPROVE}` }], isError: true }
      return {
        content: [{ type: 'text', text: 'created' }],
        structuredContent: state.wrongOutput ? { other: 1 } : { agent: 'ag_1' },
      }
    })
    return server
  })
  const manager = managerOf({
    servers: [serverConfig],
    allows: (grant) =>
      new MemoryGrants([{ connectionId: 'sq', capability: 'tool', name: 'create_agent' }]).allows(grant),
    auth: () => ({ token: async () => 'fixture' }),
    fetch: async (input, init) => official.fetch(new Request(input, init)),
  })
  return { seen, state, manager }
}

const urlAsk = (url: string) => ({
  method: 'elicitation/create',
  params: { mode: 'url', message: 'Approve the new agent.\u0007', url, elicitationId: 'el_1' },
})

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
