import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { INBOX_APP, INBOX_VIEW } from './integration/inbox-source.ts'

const compact = (text: string) => text.replace(/\s+/gu, '')

it('builds the same inbox example that app_docs offers', () => {
  const docs = readFileSync(
    fileURLToPath(new URL('../../../packages/app/docs/examples.md', import.meta.url).toString()),
    'utf8',
  )
  expect(compact(docs)).toContain(compact(INBOX_APP))
  expect(compact(docs)).toContain(compact(INBOX_VIEW))
})
