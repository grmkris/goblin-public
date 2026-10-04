import { McpServer } from '@modelcontextprotocol/server'
import * as Schema from 'effect/Schema'
import type { AskResult } from '../env.ts'
import type { TranscriptMessage } from '../pi/transcript.ts'

/** What the inbound MCP server needs from the resident agent, already bound to one authenticated client. */
export type ClientAgentPort = {
  readonly ask: (input: string, operationId: string, waitMs: number) => Promise<AskResult>
  readonly recent: (limit: number) => Promise<readonly TranscriptMessage[]>
}

const DEFAULT_WAIT_SECONDS = 50
const MAX_WAIT_SECONDS = 110

const AskInput = Schema.Struct({
  input: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(20_000)).annotate({
    description: 'What to ask or tell the resident agent.',
  }),
  operationId: Schema.optional(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)).annotate({
      description: 'Reuse the operationId from a `running` result to keep waiting for the same request.',
    }),
  ),
  waitSeconds: Schema.optional(
    Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: MAX_WAIT_SECONDS })).annotate({
      description: `How long to wait for the answer (default ${DEFAULT_WAIT_SECONDS}s).`,
    }),
  ),
})
const RecentInput = Schema.Struct({
  limit: Schema.optional(Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 50 }))),
})
const standard = <S extends Schema.Top & Schema.ConstraintDecoder<unknown>>(schema: S) =>
  Schema.toStandardJSONSchemaV1(Schema.toStandardSchemaV1(schema))

const text = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] })

/**
 * Purrable as an MCP server: authorized clients (Claude Code, Hermes, ...) can ask the resident agent things. They
 * talk in the agent's main conversation, labelled with their name; the agent uses the owner's granted tools under
 * resident authority.
 */
export const inboundServer = (agent: ClientAgentPort): McpServer => {
  const server = new McpServer(
    { name: 'purrable', version: '0.1.0' },
    {
      instructions:
        "Purrable is the owner's resident personal agent. Use ask_agent to delegate a question or task; it answers in its main conversation, where the owner sees your message labelled with your name.",
    },
  )
  server.registerTool(
    'ask_agent',
    {
      title: 'Ask the resident agent',
      description:
        'Ask Purrable, the owner\'s resident agent, a question or give it a task. It may use the owner\'s granted tools (for example MyPlan). Returns its answer, or status "running" with an operationId to wait again.',
      inputSchema: standard(AskInput),
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async (input) => {
      const waitMs = (input.waitSeconds ?? DEFAULT_WAIT_SECONDS) * 1000
      return text(await agent.ask(input.input, input.operationId ?? crypto.randomUUID(), waitMs))
    },
  )
  server.registerTool(
    'get_recent_messages',
    {
      title: 'Recent messages',
      description:
        "The recent messages of the agent's main conversation, newest last. A message written by someone other than the owner names its author.",
      inputSchema: standard(RecentInput),
      annotations: { readOnlyHint: true },
    },
    async (input) => text({ messages: await agent.recent(input.limit ?? 20) }),
  )
  return server
}
