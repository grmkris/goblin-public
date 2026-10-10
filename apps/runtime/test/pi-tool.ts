import type { ToolExecutionApi, ToolRegistration } from '@earendil-works/pi-durable'
import { BACKGROUND, conversationId } from '../src/pi/context.ts'

/** The members of Pi's execution API a tool under test reads, given by name. */
export type ToolApiParts = Partial<ToolExecutionApi>

/** The execution API of a call in conversation `session`, with `parts` besides. */
export const inConversation = (session: number, parts: ToolApiParts = {}): ToolApiParts => ({
  conversationId: conversationId(String(session)),
  ...parts,
})

/**
 * One call of `tool` as the Harness makes it, outside any Pi task (`BACKGROUND`), with only the members of the
 * execution API in `api`.
 */
export const executeTool = (tool: ToolRegistration, args: unknown, api: ToolApiParts = {}) =>
  // SAFETY: each test gives every member of the execution API its tool reads; the tool reads no other.
  tool.execute(args, api as ToolExecutionApi, BACKGROUND)
