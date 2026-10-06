import type { TextContent } from '@earendil-works/pi-ai'
import { type AppContext, type Attachment, authorTag } from '@goblin/contracts'

/**
 * The owner's message as Pi receives it: their words exactly as written, then the files they attached (one block
 * listing each file's path, name, size and type), then what each open App shared, each in a block of its own labelled
 * with the server it came from and as untrusted. Neither is ever merged into the owner's words, so App context cannot
 * pass for an instruction from them.
 */
export function ownerContent(
  input: string,
  context: readonly AppContext[] = [],
  attachments: readonly Attachment[] = [],
): string | TextContent[] {
  if (context.length === 0 && attachments.length === 0) return input
  return [
    { type: 'text', text: input },
    ...(attachments.length === 0 ? [] : [{ type: 'text' as const, text: JSON.stringify({ attachments }) }]),
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

/**
 * Main's note that the owner started a thread with "+", as its model reads it: the thread's name and nothing from
 * inside it. The name is the cheap model's or the owner's, so quotes, brackets and line breaks are taken out of it.
 */
export function threadStartedContent(title: string): TextContent[] {
  const name = title
    .replaceAll(/["[\]]/gu, ' ')
    .replaceAll(/\s+/gu, ' ')
    .trim()
  return [{ type: 'text', text: `[thread started: "${name}"]` }]
}
