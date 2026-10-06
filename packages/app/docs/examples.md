# Examples

## A counter with a history (files and prepare)

```ts
import { defineApp, s } from '@goblin/app'

export default defineApp({
  name: 'counter',
  title: 'Counter',
  description: 'Counts, and keeps a log of every change in a file.',
  state: { schema: s.object({ count: s.number({ int: true }) }), initial: { count: 0 } },
  actions: {
    add: {
      description: 'Add to the count.',
      input: s.object({ by: s.number({ int: true, min: 1, max: 100 }) }),
      prepare: async (input, ctx) => {
        const log = (await ctx.files.read('/log.txt')) ?? ''
        await ctx.files.write('/log.txt', `${log}${new Date(ctx.now).toISOString()} +${input.by}\n`)
        return null
      },
      run: (input, ctx) => ({ count: ctx.state.count + input.by }),
    },
  },
  views: { total: { description: 'The count.', input: s.object({}), select: (input, ctx) => ctx.state.count } },
})
```

## Split logic into a second file

```ts
// lib.ts
export const tally = (items: { done: boolean }[]) => ({
  done: items.filter((item) => item.done).length,
  all: items.length,
})
```

```ts
// app.ts
import { defineApp, s } from '@goblin/app'
import { tally } from './lib'
```

## An inbox or calendar glance tile

Use the server id shown in Connections. This example calls `myinbox/message_list` every 15 minutes, validates the
untrusted result in `prepare`, and keeps the newest five messages. A failed refresh keeps the last good messages and
records an error for the view to show; `run` remains a pure state transition. Inspect the connected tool schema and
adapt its arguments and result adapter: this example expects `structuredContent.messages` with the fields below.

```ts
// app.ts
import { defineApp, s } from '@goblin/app'

const Message = s.object({
  id: s.string({ min: 1, max: 200 }),
  subject: s.string({ max: 240 }),
  sender: s.string({ max: 240 }),
  receivedAt: s.number(),
})
type Message = { id: string; subject: string; sender: string; receivedAt: number }
type Prepared = { messages: Message[]; refreshedAt: number | null; error?: string }

function newestFive(value: unknown): Message[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'object' || item === null))
    throw new Error('message_list returned an invalid list')
  const rows = value.map((item) => {
    if (!('id' in item) || !('subject' in item) || !('sender' in item) || !('receivedAt' in item))
      throw new Error('Invalid message fields')
    if (
      typeof item.id !== 'string' ||
      typeof item.subject !== 'string' ||
      typeof item.sender !== 'string' ||
      typeof item.receivedAt !== 'number' ||
      !Number.isFinite(item.receivedAt)
    )
      throw new Error('Invalid message fields')
    if (item.id.length < 1 || item.id.length > 200 || item.subject.length > 240 || item.sender.length > 240)
      throw new Error('Message fields exceed the glance bounds')
    return { id: item.id, subject: item.subject, sender: item.sender, receivedAt: item.receivedAt }
  })
  return rows.toSorted((a, b) => b.receivedAt - a.receivedAt).slice(0, 5)
}

export type State = { messages: Message[]; refreshedAt: number | null; error?: string }

export default defineApp({
  name: 'inbox-glance',
  title: 'Inbox',
  description: 'A compact view of recent messages.',
  state: {
    schema: s.object({
      messages: s.array(Message, { max: 5 }),
      refreshedAt: s.nullable(s.number()),
      error: s.optional(s.string({ max: 400 })),
    }),
    initial: { messages: [], refreshedAt: null },
  },
  uses: { tools: ['myinbox/message_list'] },
  schedules: [{ action: 'refresh', every: '15m', input: {} }],
  actions: {
    refresh: {
      description: 'Refresh the latest messages.',
      input: s.object({}),
      prepare: async (_input, ctx): Promise<Prepared> => {
        try {
          const result = await ctx.tools.call('myinbox/message_list', { limit: 20 })
          if (typeof result !== 'object' || result === null || !('structuredContent' in result))
            throw new Error('message_list has no structured result')
          const data = result.structuredContent
          if (typeof data !== 'object' || data === null || !('messages' in data))
            throw new Error('message_list has no messages')
          return { messages: newestFive(data.messages), refreshedAt: ctx.now }
        } catch (cause) {
          return {
            messages: [],
            refreshedAt: null,
            error: cause instanceof Error ? cause.message.slice(0, 400) : 'Refresh failed',
          }
        }
      },
      run: (_input, ctx, prepared: Prepared): State =>
        prepared.error === undefined
          ? { messages: prepared.messages, refreshedAt: prepared.refreshedAt }
          : { messages: ctx.state.messages, refreshedAt: ctx.state.refreshedAt, error: prepared.error },
    },
  },
  views: {
    glance: { description: 'Read the latest messages.', input: s.object({}), select: (_input, ctx) => ctx.state },
  },
})
```

## Home view

The view is presentation only. On Home it shows two rows and freshness, or one row with the last refresh error; the page can show five. It never calls the server directly.

```tsx
import { useAppState, useHost } from '@goblin/app'
import type { State } from './app'

export default function View() {
  const host = useHost()
  const [state] = useAppState<State>()
  const home = host.surface === 'home'
  const rows = state.messages.slice(0, home ? (state.error === undefined ? 2 : 1) : 5)
  const updated = state.refreshedAt === null ? null : new Date(state.refreshedAt)
  return (
    <div className={home ? 'flex flex-col gap-1 p-2' : 'flex flex-col gap-2 p-3'}>
      {!home && <strong>Inbox</strong>}
      <span className="truncate text-xs text-muted-foreground">
        {updated === null
          ? 'Never refreshed'
          : `Updated ${home ? updated.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : updated.toLocaleString()}`}
      </span>
      {state.error !== undefined && <span className="truncate text-xs text-destructive">{state.error}</span>}
      {rows.map((message) => (
        <div key={message.id} className="truncate text-sm">
          <span>{message.subject}</span>
          <span className="text-xs text-muted-foreground"> · {message.sender}</span>
        </div>
      ))}
    </div>
  )
}
```
