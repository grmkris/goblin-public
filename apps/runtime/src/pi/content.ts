import type { TextContent } from '@earendil-works/pi-ai'
import { type Attachment, authorTag } from '@goblin/contracts'
import type { ResolvedSelections } from '../composer.ts'

/** What an open App shared, with where it comes from: an MCP App's server, or the agent app it is. */
export type SharedContext = {
  readonly origin: { readonly serverId: string } | { readonly app: string }
  readonly text: string
}

/**
 * The owner's message as Pi receives it: their words exactly as written, then the files they attached (one block
 * listing each file's path, name, size and type), then what each open App shared, each in a block of its own labelled
 * with where it came from and as untrusted. Neither is ever merged into the owner's words, so App context cannot pass
 * for an instruction from them.
 */
export function ownerContent(
  input: string,
  context: readonly SharedContext[] = [],
  attachments: readonly Attachment[] = [],
  selections: ResolvedSelections = { options: [], context: [] },
): string | TextContent[] {
  if (context.length === 0 && attachments.length === 0 && selections.options.length === 0) return input
  const prefixes = selections.options.map(
    ({ selection, label }) => `${selection.kind === 'skill' ? '/' : '@'}${JSON.stringify(label)}`,
  )
  return [
    { type: 'text', text: prefixes.length === 0 ? input : `${prefixes.join(' ')}\n${input}` },
    ...(selections.options.length === 0
      ? []
      : [
          {
            type: 'text' as const,
            text: JSON.stringify({
              composer: { text: input, selections: selections.options, context: selections.context },
            }),
          },
        ]),
    ...(attachments.length === 0 ? [] : [{ type: 'text' as const, text: JSON.stringify({ attachments }) }]),
    ...context.map(({ origin, text }): TextContent => ({
      type: 'text',
      text: JSON.stringify({ origin: { ...origin, trust: 'untrusted' }, appContext: text }),
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
