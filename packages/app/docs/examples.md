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
