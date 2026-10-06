import type { CallToolResult } from '@modelcontextprotocol/client'
import type { ToolExecutionResult } from '@earendil-works/pi-durable'
import type { JsonValue } from '@goblin/contracts'
import { Predicate } from 'effect'

const SECRET_KEY = /token|secret|password|authorization|cookie|private.?key|api.?key/iu
const isRecord = (value: unknown): value is Record<string, unknown> => Predicate.isObject(value)
const redact = (value: unknown, key = ''): JsonValue => {
  if (SECRET_KEY.test(key)) return '[redacted]'
  if (Predicate.isString(value) || Predicate.isNumber(value) || Predicate.isBoolean(value) || value === null)
    return value
  if (Array.isArray(value)) return value.map((item) => redact(item))
  if (isRecord(value))
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, redact(item, name)]))
  return '[unsupported]'
}
/** Pi supports text and image blocks. Other MCP blocks remain explicit tagged data in the result details. */
const mcpModelContent = (result: CallToolResult): NonNullable<ToolExecutionResult['content']> => {
  const blocks: NonNullable<ToolExecutionResult['content']> = []
  for (const block of result.content) {
    if (block.type === 'text') blocks.push({ type: 'text', text: block.text })
    else if (block.type === 'image') blocks.push({ type: 'image', data: block.data, mimeType: block.mimeType })
    else blocks.push({ type: 'text', text: JSON.stringify({ unsupportedMcpContent: redact(block) }) })
  }
  return blocks
}
/** A redacted model envelope; the manager retains the original rich MCP result for the host. */
export const mcpModelResult = (serverId: string, result: CallToolResult): ToolExecutionResult => ({
  content: [
    { type: 'text', text: JSON.stringify({ origin: { serverId, trust: 'untrusted' } }) },
    ...mcpModelContent(result),
  ],
  isError: result.isError === true,
  details: redact({
    origin: { serverId, trust: 'untrusted' },
    structuredContent: result.structuredContent,
    _meta: result._meta,
    content: result.content,
  }),
})

/**
 * What the model gets for a tool the owner has not granted: words it can relay, and a marker the web turns into an
 * owner-only Allow card. The marker is the top-level `kind`; `mcpModelResult` details never have one, so a remote
 * server's content cannot forge it. The model is told to wait: granting is the owner's act, never the model's.
 */
export const grantRequiredResult = (serverId: string, name: string): ToolExecutionResult => ({
  content: [
    {
      type: 'text',
      text: `Not granted: ${serverId} · ${name}. The owner has been shown an Allow button for this tool. Stop here and wait for their decision; do not retry until they reply.`,
    },
  ],
  isError: true,
  details: { kind: 'grant-required', serverId, name },
})
