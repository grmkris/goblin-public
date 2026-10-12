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

/**
 * What the model gets for a call beyond what the connection's sign-in granted (ADR 0042): words it can relay, and a
 * marker the web turns into an owner-only card to sign in again with more access. The turn ends: signing in is the
 * owner's act, and they say when to continue.
 */
export const scopeRequiredResult = (
  connectionId: string,
  name: string,
  scope: string,
  connection: string,
): ToolExecutionResult => ({
  content: [
    {
      type: 'text',
      text: `Needs more access: ${connection} says this call needs ${scope === '' ? 'more access' : `the scope ${scope}`}. The owner has been shown a card to sign in to it again with more access. Stop here and wait until they say to continue.`,
    },
  ],
  isError: true,
  control: { terminate: true },
  diagnostics: [{ severity: 'info', code: 'ScopeRequired', message: 'More access required.' }],
  details: { kind: 'scope-required', connectionId, name, scope },
})

/**
 * A model's call the server answered "input required: open this URL" (ADR 0042): goblin's own marker for the owner's
 * card, which reads the link from the kept request. Neither the link nor the server's message is in the result: the
 * transcript is indexed, and approval links can carry one-time tokens. The turn ends; the server's answer comes back
 * once the owner finishes or cancels it.
 */
export const urlRequiredResult = (
  requestId: string,
  connectionId: string,
  name: string,
  connection: string,
): ToolExecutionResult => ({
  content: [
    {
      type: 'text',
      text: `Waiting on the owner: ${connection} · ${name} asks them to finish a step on its site first, and nothing has completed yet. They have a card with the server's link. Once they finish or cancel it, the outcome arrives as a new message from the connection, with the server's answer. Stop and wait; do not call the tool again.`,
    },
  ],
  isError: true,
  control: { terminate: true },
  diagnostics: [
    { severity: 'info', code: 'url_required', message: 'The owner must finish a step on the server first.' },
  ],
  details: { kind: 'url-required', requestId, connectionId, name },
})
