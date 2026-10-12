import { ProtocolError, ProtocolErrorCode, createMcpHandler } from '@modelcontextprotocol/server'
import { declaresUrlElicitation, lowLevelServer } from './low-level-server.ts'

/** The Sidequest-like server's connection. */
export const SIDEQUEST = { connectionId: 'sq', endpoint: 'https://sq.test/mcp' }
/** The link it asks the owner to open: it carries a one-time token. */
export const APPROVE = 'https://sq.test/approve/op_1?token=one-time'

/** What a call carried, as the fixture saw it. */
type Seen = { readonly url: boolean; readonly answer: unknown; readonly state: unknown }

/** A url-mode elicitation for `url`, its message ending in a control character goblin drops. */
export const urlAsk = (url: string) => ({
  method: 'elicitation/create',
  params: { mode: 'url', message: 'Approve the new agent.\u0007', url, elicitationId: 'el_1' },
})

/**
 * A Sidequest-like server (ADR 0042): `create_agent` needs the operator's approval. A request that declares URL
 * elicitation gets "input required: open this URL" with request state `op_1` until it comes back accepted with that
 * state once `approved`; a declined one completes as an error; one that does not declare it gets today's link in the
 * text. `ask` changes what it asks, to test what goblin refuses. `state` switches what it does next: `unlisted` drops
 * `create_agent` from its list while still answering it (as Sidequest does once a setup becomes an agent),
 * `askOnDecline` keeps asking after a decline, `wrongOutput` answers outside the output schema and `refuse` answers a
 * JSON-RPC error.
 */
export const sidequestServer = (
  ask: (url: string) => Record<string, unknown> = (url) => ({ approval: urlAsk(url) }),
) => {
  const seen: Seen[] = []
  const state = { approved: false, wrongOutput: false, unlisted: false, askOnDecline: false, refuse: false }
  const official = createMcpHandler(() => {
    const server = lowLevelServer({ name: 'sq', version: '1.0.0' }, { capabilities: { tools: {} } })
    server.setRequestHandler('tools/list', () => ({
      tools: state.unlisted
        ? []
        : [
            {
              name: 'create_agent',
              inputSchema: { type: 'object' as const, properties: { name: { type: 'string' } } },
              outputSchema: { type: 'object' as const, properties: { agent: { type: 'string' } }, required: ['agent'] },
            },
          ],
    }))
    server.setRequestHandler('tools/call', (_request, ctx) => {
      // The server SDK lifts the request's envelope, input responses and state out of the params.
      const { envelope, inputResponses } = ctx.mcpReq
      const requestState = ctx.mcpReq.requestState?.<string>()
      const url = declaresUrlElicitation(envelope)
      seen.push({ url, answer: inputResponses?.['approval'], state: requestState })
      const answer = JSON.stringify(inputResponses?.['approval'])
      if (state.refuse) throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'operation key reused')
      if (url && answer === '{"action":"decline"}' && requestState === 'op_1' && !state.askOnDecline)
        return { content: [{ type: 'text', text: 'closed: the operator was not asked' }], isError: true }
      if (url && !(answer === '{"action":"accept"}' && requestState === 'op_1' && state.approved))
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
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => official.fetch(new Request(input, init))
  return { seen, state, fetch }
}
