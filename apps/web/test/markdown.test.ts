import { describe, expect, it } from 'vitest'
import { looksLikeMarkdown } from '../src/lib/markdown.ts'

const lines = (...rows: readonly string[]) => rows.join('\n')

const docsPage = lines(
  '# Agent apps',
  '',
  'An app is a small program you write for the owner. Build or change one with `app_build`.',
  '',
  '## app.ts',
  '',
  '```ts',
  "import { defineApp, s } from '@goblin/app'",
  '```',
  '',
  '- Actions change state.',
  '- Views read it.',
)

const markdown: readonly (readonly [string, string])[] = [
  ['a documentation page', docsPage],
  ['headings and fences only', lines('# Examples', '', '## A counter', '', '```ts', 'export default 1', '```')],
  ['a note with a heading, a list and bold', lines('# Groceries', '', '- **milk**', '- eggs', '- bread')],
  ['a table on its own', lines('| Name | Count |', '| --- | ---: |', '| apples | 3 |')],
  ['a fence with a list and inline code', lines('Run `bun dev`:', '', '```sh', 'bun dev', '```', '', '- one', '- two')],
  [
    'a skill wrapped in tags',
    lines(
      '<skill handle="x" origin="y">',
      '',
      '# Deploy',
      '',
      '## Steps',
      '',
      '1. Run `bun run build`',
      '2. Ship',
      '',
      '</skill>',
    ),
  ],
]

const plain: readonly (readonly [string, string])[] = [
  ['a sentence', 'Shared with the research thread.'],
  ['nothing', ''],
  ['CSV', lines('name,count', 'apples,3', 'pears,|2|')],
  [
    'a directory listing',
    lines('total 8', 'drwxr-xr-x  3 k k 4096 Oct  6 10:00 .', '-rw-r--r--  1 k k  120 Oct  6 10:00 #notes#'),
  ],
  ['psql output', lines(' id | name', '----+------', '  1 | apples', '(1 row)')],
  [
    'a Python traceback',
    lines(
      'Traceback (most recent call last):',
      '  File "/app/pkg/__init__.py", line 3, in <module>',
      '    import missing  # noqa',
      'ModuleNotFoundError: No module named missing',
    ),
  ],
  ['a script with a spaced comment and backticks', lines('# Build', '', 'ls `pwd`/src', 'echo done | tee log')],
  ['YAML with a spaced comment and lists', lines('# Defaults', '', 'keys:', '  - one', '  - two', 'mode: fast')],
  [
    'a git diff',
    lines(
      'diff --git a/x.ts b/x.ts',
      '@@ -1,3 +1,3 @@',
      ' # header',
      '- removed **bold**',
      '- also `removed`',
      '+ added',
    ),
  ],
  ['inline-only prose', 'Created **notes.md** in `/docs`; see [the guide](https://example.com/guide) and #42.'],
  ['links without a heading', lines('- [one](https://a.example)', '- [two](https://b.example)', '- see #3')],
  ['a heading directly on a list', lines('# Shopping', '- milk', '- eggs')],
  ['a setext heading with a list and bold', lines('Title', '=====', '', '- **one**', '- two', '#tag')],
  ['Markdown beyond the size limit', `${docsPage}\n\n${'x'.repeat(64 * 1024)}`],
]

describe('Markdown detection', () => {
  it.each(markdown)('formats %s', (_name, text) => {
    expect(looksLikeMarkdown(text)).toBe(true)
  })
  it.each(plain)('leaves %s as plain text', (_name, text) => {
    expect(looksLikeMarkdown(text)).toBe(false)
  })
})
