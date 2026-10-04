import type { TextContent } from '@earendil-works/pi-ai'
import { type AppContext, authorTag } from '@purrable/contracts'

/**
 * The owner's message as Pi receives it: their words exactly as written, then what each open App shared, each in a
 * block of its own labelled with the server it came from and as untrusted. App context is never merged into the
 * owner's words, so it cannot pass for an instruction from them.
 */
export function ownerContent(input: string, context: readonly AppContext[] = []): string | TextContent[] {
  if (context.length === 0) return input
  return [
    { type: 'text', text: input },
    ...context.map(({ serverId, text }): TextContent => ({
      type: 'text',
      text: JSON.stringify({ origin: { serverId, trust: 'untrusted' }, appContext: text }),
    })),
  ]
}

/**
 * A message someone other than the owner's browser wrote into a conversation (Telegram, an MCP client, a subagent):
 * the author's tag in a block of its own, then their words. The model reads both; the web shows the author.
 */
export function authoredContent(author: string, text: string): TextContent[] {
  return [
    { type: 'text', text: authorTag(author) },
    { type: 'text', text },
  ]
}
