# Files in an app

Each app has its own files, separate from the owner's. In `prepare`:

```ts
await ctx.files.write('/data/report.md', '# Report\n...') // text, up to 1 MB a file
const text = await ctx.files.read('/data/report.md') // null when missing
const entries = await ctx.files.list('/data') // [{ path, size }]
await ctx.files.delete('/data/old.md') // true when it existed
```

Paths start with `/`, use letters, digits, spaces and `_ . ( ) -`, and at most eight folders. An app's files total at
most 64 MB. Keep large data in files and small, structured data in state; state is at most 1 MB.

To read a file the owner gave you, use your own `files_read` tool and pass what you need as an action's input.
