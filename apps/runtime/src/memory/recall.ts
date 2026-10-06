import { defineExtension, defineTool, section } from '@earendil-works/pi-durable'
import { Type } from '@earendil-works/pi-ai'

/** OptChat's view guide (§7.2), for goblin: how to read the memory and when to zoom. Static, so caches hold. */
const GUIDE = [
  'Your memory of the main conversation: a request in it starts with the memory, inside <memory> tags, and then the',
  'recent messages in full. The memory holds the conversation before them, oldest first, as one-line summaries. Each',
  'line is `id+n|text`: the n messages from message id on, summarized. A summary tags each item with its kind: user',
  '(the owner, or another author it names), talk (your replies), tool (your tool calls), echo (their results) or work (a',
  "subagent's report). A short message is its own line, word for word. Recent lines cover one message each; the older",
  'the messages, the more a line covers.',
  '',
  '`zoom(id, n)` opens line id+n into the two lines of n/2 messages it was made from; `zoom(id, 1)` gives message id in',
  'full. Zoom whenever a summary only mentions something you need, such as a decision, a past attempt or where',
  'something is, before you act, guess or ask. Summaries keep little of tool output, so say in your reply what you',
  'learned that will matter later.',
].join('\n')

/** `zoom` into main's memory, bounded by what the conversation may see, and the guide to reading the view. */
export function recallExtension(zoom: (id: number, n: number, conversation: string) => Promise<string>, guide = GUIDE) {
  return defineExtension({
    name: 'goblin.recall',
    sections: [section('memory', () => guide)],
    tools: [
      defineTool({
        name: 'zoom',
        description:
          'Open the line id+n of your memory into the two lines of n/2 under it; n = 1 gives the message whole.',
        parameters: Type.Object({ id: Type.Integer({ minimum: 0 }), n: Type.Integer({ minimum: 1 }) }),
        replay: 'safe',
        execute: async ({ id, n }, api) => {
          const text = await zoom(id, n, String(api.conversationId))
          return { content: [{ type: 'text', text }] }
        },
      }),
    ],
  })
}
