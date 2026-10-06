# Agent apps

An app is a small program you write for the owner. It keeps durable JSON state on goblin's server, and you call each
action or view you define with `app_call` (`{"app": "<name>", "member": "<action>", "input": {...}}`). Build or change
one with `app_build`. Add a
`view.tsx` and the owner can open it as a live UI (topic `ui`).

## app.ts

```ts
import { defineApp, s } from '@goblin/app'

export default defineApp({
  name: 'reading-list', // kebab-case, never changes
  title: 'Reading list',
  description: 'Books the owner wants to read, and what they thought of them.',
  state: {
    schema: s.object({ books: s.array(s.object({ id: s.string(), title: s.string(), done: s.boolean() })) }),
    initial: { books: [] }, // start empty: no sample data
  },
  actions: {
    add: {
      description: 'Add a book to read.',
      input: s.object({ title: s.string({ min: 1, max: 200 }) }),
      run: (input, ctx) => ({ books: [...ctx.state.books, { id: ctx.id(), title: input.title, done: false }] }),
    },
    finish: {
      description: 'Mark a book read.',
      input: s.object({ id: s.string() }),
      run: (input, ctx) => {
        if (!ctx.state.books.some((book) => book.id === input.id)) throw new Error(`No book ${input.id}`)
        return { books: ctx.state.books.map((book) => (book.id === input.id ? { ...book, done: true } : book)) }
      },
    },
  },
  views: {
    unread: {
      description: 'Books not read yet.',
      input: s.object({}),
      select: (input, ctx) => ctx.state.books.filter((book) => !book.done),
    },
  },
})
```

## Rules

- `run(input, ctx, prepared)` is pure: it returns the whole next state and does nothing else. It may run again for
  the same call, so no I/O. `ctx.state` (current), `ctx.now` (ms since epoch), `ctx.id()` and `ctx.random()`.
- `prepare(input, ctx)` is optional and runs once, before `run`; whatever it returns is `run`'s third argument. It is
  the only place for I/O: `ctx.files` (the app's own files), `ctx.log(...)`, and the powers the owner approved
  (`ctx.fetch`, `ctx.tools`, `ctx.llm`, `ctx.notify`, `ctx.apps`: topic `powers`). `ctx.state` is read-only there.
- `select(input, ctx)` returns data from `ctx.state` for a view; it changes nothing.
- An action can also run on its own on a schedule, every 15 minutes to daily (topic `schedules`).
- Throw an `Error` with a clear message to refuse a call; nothing changes.
- State is plain JSON and must match `state.schema`. Leave optional fields out rather than setting `undefined`.
- Schemas: `s.string({min,max})`, `s.number({int,min,max})`, `s.boolean()`, `s.enum([...])`, `s.array(item,{max})`,
  `s.object({...})`, `s.record(value)`, `s.optional(schema)` (inside `s.object`), `s.nullable(schema)`.
- Inputs are `s.object(...)`. Action and view names are camelCase. At most 12 actions and views.
- Imports: only `@goblin/app` and your own files (`import { score } from './lib'`). No npm packages. `view.tsx` has
  its own imports (topic `ui`).
- `agent: false` on an action hides it from your tools (for actions only the app's own UI should call).

## Changing an app

Call `app_build` again with the same `name`, sending only the files that change (`""` removes one), or `edits`
(find/replace in a file) for small fixes. If the state's shape changes, add `state.migrate: (previous) => next`; the current state must fit the new
schema or migrate into it, or the build fails and the running version stays. `app_inspect` shows the source, the
state, recent events and errors; `app_rollback` goes back to an earlier version.

More: `app_docs({ topic })` with `ui`, `powers`, `schedules`, `files` or `examples`.
