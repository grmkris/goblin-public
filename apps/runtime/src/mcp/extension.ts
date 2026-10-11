import type { CallToolResult } from '@modelcontextprotocol/client'
import type { ToolExecutionResult } from '@earendil-works/pi-durable'
import { redactSecretFields as redact } from './redaction.ts'
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
export const mcpModelResult = (connectionId: string, result: CallToolResult): ToolExecutionResult => ({
  content: [
    { type: 'text', text: JSON.stringify({ origin: { connectionId, trust: 'untrusted' } }) },
    ...mcpModelContent(result),
  ],
  isError: result.isError === true,
  details: redact({
    origin: { connectionId, trust: 'untrusted' },
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
export const grantRequiredResult = (connectionId: string, name: string, connection: string): ToolExecutionResult => ({
  content: [
    {
      type: 'text',
      text: `Not granted: ${connection} · ${name}. The owner has been shown an Allow button for this tool. Stop here and wait for their decision; do not retry until they reply.`,
    },
  ],
  isError: true,
  diagnostics: [{ severity: 'info', code: 'GrantDenied', message: 'Owner grant required.' }],
  details: { kind: 'grant-required', connectionId, name },
})
