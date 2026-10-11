import type { TextContent } from '@earendil-works/pi-ai'
import { type Attachment, type TopicSeedData, authorTag } from '@goblin/contracts'
import type { ResolvedSelections } from '../composer.ts'

/** What an open App shared, with where it comes from: an MCP App's server, or the agent app it is. */
export type SharedContext = {
  readonly origin: { readonly connectionId: string } | { readonly app: string }
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

/** A name or quote put inside `[… "…"]`: quotes, brackets and line breaks out, runs of space as one. */
const quotable = (text: string): string =>
  text
    .replaceAll(/["[\]]/gu, ' ')
    .replaceAll(/\s+/gu, ' ')
    .trim()

/**
 * A new Topic's seed as its Conversation's model reads it (ADR 0032): the compact brief, then each frozen excerpt from
 * the discussion it came from in a block of its own, labelled with where it came from and as quoted history, never as
 * an instruction.
 */
export function topicSeedContent(seed: TopicSeedData): TextContent[] {
  return [
    ...(seed.brief === '' ? [] : [{ type: 'text' as const, text: `[topic brief]\n${seed.brief}` }]),
    ...seed.sources.map((source): TextContent => ({
      type: 'text',
      text: JSON.stringify({
        source: { chat: source.chat, entries: [source.entryStart, source.entryEnd], trust: 'quoted-history' },
        excerpt: source.excerpt,
      }),
    })),
  ]
}

/**
 * Main's note that the owner started a thread with "+", as its model reads it: the thread's name and nothing from
 * inside it. The name is the cheap model's or the owner's, so quotes, brackets and line breaks are taken out of it.
 */
export function threadStartedContent(title: string): TextContent[] {
  return [{ type: 'text', text: `[thread started: "${quotable(title)}"]` }]
}

/** At most this many characters of the owner's words go into a thread head's note for the model. */
const HEAD_QUOTE = 200

/**
 * The note a chat's model reads where the owner started a Thread from its composer (ADR 0034): what they wrote,
 * bounded, so the chat knows the Thread exists without its conversation coming back.
 */
export function threadHeadContent(text: string): TextContent[] {
  const words = quotable(text)
  const quote = words.length > HEAD_QUOTE ? `${words.slice(0, HEAD_QUOTE)}…` : words
  return [{ type: 'text', text: `[the owner started a thread: "${quote}"]` }]
}

/** The note the chat's model reads where a turn was moved out into a Thread: only the Thread's name (ADR 0034). */
export function movedToThreadContent(title: string): TextContent[] {
  return [{ type: 'text', text: `[moved to thread "${quotable(title)}"]` }]
}
