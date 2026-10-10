import { McpServer } from '@modelcontextprotocol/server'
import * as Schema from 'effect/Schema'
import type { AskResult, TranscriptMessage } from '@goblin/contracts/internal'
import { INSPECTION_GUIDE, type InspectReader, registerInspection } from './inspection.ts'
import { failed, standard, text } from './tools.ts'

/** What the inbound MCP server needs from the resident agent, already bound to one authenticated client. */
export type ClientAgentPort = {
  readonly ask: (input: string, operationId: string, waitMs: number) => Promise<AskResult>
  readonly recent: (limit: number) => Promise<readonly TranscriptMessage[]>
  /** Present when the client holds `goblin:inspect`: the read-only inspection tools (ADR 0024). */
  readonly inspect?: InspectReader
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
const ASK_GUIDE =
  "goblin is the owner's resident personal agent. Use ask_agent to delegate a question or task; it answers in its main conversation, where the owner sees your message labelled with your name."

/**
 * goblin as an MCP server: authorized clients (Claude Code, Hermes, ...) can ask the resident agent things. They
 * talk in the agent's main conversation, labelled with their name; the agent uses the owner's granted tools under
 * resident authority. A client the owner let inspect also reads the agent's conversations and runs.
 */
export const inboundServer = (agent: ClientAgentPort): McpServer => {
  const server = new McpServer(
    { name: 'goblin', version: '0.1.0' },
    { instructions: agent.inspect === undefined ? ASK_GUIDE : `${ASK_GUIDE} ${INSPECTION_GUIDE}` },
  )
  server.registerTool(
    'ask_agent',
    {
      title: 'Ask the resident agent',
      description:
        'Ask goblin, the owner\'s resident agent, a question or give it a task. It may use the owner\'s granted tools (for example MyPlan). Returns its answer, or status "running" with an operationId to wait again.',
      inputSchema: standard(AskInput),
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async (input) => {
      const waitMs = (input.waitSeconds ?? DEFAULT_WAIT_SECONDS) * 1000
      try {
        return text(await agent.ask(input.input, input.operationId ?? crypto.randomUUID(), waitMs))
      } catch (cause) {
        // expected: the failure is the tool's error result, its tag and safe fields only (tools.ts).
        return failed(cause)
      }
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
  if (agent.inspect !== undefined) registerInspection(server, agent.inspect)
  return server
}
