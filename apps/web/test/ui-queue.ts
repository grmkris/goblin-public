/** Real source UI with controlled owner HTTP and native event fixtures; no account or model calls. */
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, writeSync } from 'node:fs'
import path from 'node:path'
import { createServer } from 'vite'
import { chromium, type Page, type Route } from 'playwright-core'
import { ConversationQueue, type QueuedInput } from '@goblin/contracts'
import * as Schema from 'effect/Schema'

/** The file descriptor this script's result line goes to (@cloudflare/workers-types makes `process` `any`). */
const STDOUT = 1

const out = path.resolve(import.meta.dirname, '../../../.local/goblin-acceptance', `queue-${Date.now()}`)
mkdirSync(out, { recursive: true, mode: 0o700 })
const results: unknown[] = []
const errors: string[] = []
const content = [
  { type: 'text', text: 'Long queued message. '.repeat(70) },
  {
    type: 'text',
    text: JSON.stringify({
      composer: {
        text: 'Long queued message. '.repeat(70),
        selections: [
          { label: 'Notes', description: 'Fixture notes', selection: { kind: 'connection', serverId: 'notes' } },
        ],
        context: [],
      },
    }),
  },
  {
    type: 'text',
    text: JSON.stringify({
      attachments: [{ path: '/uploads/2026-01-01/notes.txt', name: 'notes.txt', size: 4, mimeType: 'text/plain' }],
    }),
  },
]

async function events(page: Page, inputs: readonly QueuedInput[]) {
  await page.evaluate(
    (items) =>
      window.dispatchEvent(
        new MessageEvent('fixture-batch', {
          data: JSON.stringify([{ type: 'inbox_update', items: items.map(({ id, mode }) => ({ id, mode })) }]),
        }),
      ),
    inputs,
  )
}
async function install(page: Page) {
  let inputs = Schema.decodeUnknownSync(ConversationQueue)({
    inputs: [
      { id: 5, mode: 'followUp', content },
      { id: 6, mode: 'followUp', content: 'duplicate' },
      { id: 7, mode: 'followUp', content: 'duplicate' },
      {
        id: 8,
        mode: 'followUp',
        content: [
          { type: 'text', text: '[from Telegram]' },
          { type: 'text', text: 'phone message' },
        ],
      },
    ],
  }).inputs
  let reads = 0
  const submissions: unknown[] = []
  let hold: (() => void) | undefined
  let failNext = false
  let failReads = false
  let removal: Promise<void> | undefined
  let releaseRemoval: (() => void) | undefined
  let refuseRemoval = false
  await page.addInitScript(() => {
    let opened = 0
    class Events extends EventTarget {
      readonly forward = (event: Event) => {
        if (!(event instanceof MessageEvent)) return
        const data: unknown = event.data
        this.dispatchEvent(new MessageEvent('batch', { data }))
      }
      constructor() {
        super()
        document.documentElement.dataset['streams'] = String(++opened)
        window.addEventListener('fixture-batch', this.forward)
      }
      close() {
        window.removeEventListener('fixture-batch', this.forward)
      }
    }
    Object.defineProperty(window, 'EventSource', { value: Events })
  })
  await page.route('**/api/conversations/1/**', async (route: Route) => {
    const request = route.request()
    const action = new URL(request.url()).pathname.split('/').at(-1)
    if (action === 'snapshot')
      return route.fulfill({
        json: {
          type: 'snapshot',
          entries: [],
          tools: [],
          inbox: inputs.map(({ id, mode }) => ({ id, mode })),
          run: { inputs: [1] },
        },
      })
    if (action === 'queue' && request.method() === 'DELETE') {
      const { submissionId } = Schema.decodeUnknownSync(Schema.Struct({ submissionId: Schema.Int }))(
        request.postDataJSON(),
      )
      await removal
      if (refuseRemoval) {
        refuseRemoval = false
        return route.fulfill({ status: 503, json: { error: 'Unavailable' } })
      }
      inputs = inputs.filter(({ id }) => id !== submissionId)
      await route.fulfill({ json: { status: 'removed' } })
      await events(page, inputs)
      return
    }
    if (action === 'queue') {
      reads += 1
      if (failReads) return route.fulfill({ status: 503, json: { error: 'Unavailable' } })
      return route.fulfill({ json: { inputs } })
    }
    if (action === 'composer') return route.fulfill({ json: { options: [], unavailable: [] } })
    if (action === 'messages') {
      const message = Schema.decodeUnknownSync(Schema.Struct({ input: Schema.String, operationId: Schema.String }))(
        request.postDataJSON(),
      )
      submissions.push(message)
      if (failNext) {
        failNext = false
        return route.abort('failed')
      }
      await new Promise<void>((resolve) => {
        hold = resolve
      })
      inputs = [...inputs, { id: 9, mode: 'followUp', content: message.input }]
      await route.fulfill({ status: 202, json: { accepted: true, session: '1', operationId: message.operationId } })
      await events(page, inputs)
      return
    }
    return route.fulfill({ json: {} })
  })
  page.on('pageerror', (error) => errors.push(error.message))
  return {
    holdRemoval: (refuse = false) => {
      refuseRemoval = refuse
      removal = new Promise<void>((resolve) => {
        releaseRemoval = resolve
      })
    },
    releaseRemoval: () => {
      releaseRemoval?.()
      removal = undefined
      releaseRemoval = undefined
    },
    release: () => {
      hold?.()
      hold = undefined
    },
    fail: () => {
      failNext = true
    },
    failReads: (next: boolean) => {
      failReads = next
    },
    invalidate: () => events(page, inputs),
    placed: async () => {
      inputs = inputs.filter(({ id }) => id !== 5)
      await events(page, inputs)
    },
    reads: () => reads,
    submissions,
  }
}

async function matrix(origin: string, page: Page, label: string, dark: boolean) {
  const fixture = await install(page)
  await page.goto(`${origin}queue.html`)
  if (dark) await page.evaluate(() => document.documentElement.classList.add('dark'))
  const full = page.getByRole('region', { name: 'Full conversation' })
  const inline = page.getByRole('region', { name: 'Inline thread' })
  await full.locator('[data-submission="5"]').waitFor()
  assert.equal(await full.locator('[data-submission]').count(), 4)
  assert.equal(await inline.locator('[data-submission]').count(), 4)
  assert.equal(await page.locator('html').getAttribute('data-streams'), '1', 'full and inline share one SSE')
  assert.equal(fixture.reads(), 1, 'full and inline share one initial content read')
  assert(await full.getByRole('link', { name: 'notes.txt' }).isVisible())
  assert(await full.getByLabel('Selected references').getByText('@Notes').isVisible())
  assert(await full.getByText('Telegram · Follow-up').isVisible())
  const summary = full.getByLabel('Expand queued message 1')
  await summary.focus()
  await summary.press('Enter')
  assert.equal(await full.locator('[data-submission="5"] details').getAttribute('open'), '')
  const bounds = await full.evaluate((element) => {
    const queue = element.querySelector('.dock-cards')
    const dock = element.querySelector('.chat-dock')
    return {
      pane: element.getBoundingClientRect().height,
      dock: dock?.getBoundingClientRect().height,
      scrollable: queue !== null && queue.scrollHeight > queue.clientHeight,
      overflow: element.scrollWidth > element.clientWidth,
    }
  })
  assert(bounds.dock !== undefined && bounds.dock < bounds.pane, JSON.stringify(bounds))
  assert(bounds.scrollable, 'expanded long text scrolls above the composer')
  assert(!bounds.overflow, 'narrow queue has no horizontal overflow')
  await page.screenshot({ path: path.join(out, `${label}.png`) })
  await summary.press('Enter')
  fixture.failReads(true)
  await fixture.invalidate()
  await full.getByText('Queued messages could not be refreshed. Retrying…').waitFor()
  assert.equal(await full.locator('[data-submission]').count(), 4)
  fixture.failReads(false)
  await fixture.invalidate()
  await full.getByText('Queued messages could not be refreshed. Retrying…').waitFor({ state: 'hidden' })
  const field = full.getByRole('textbox', { name: 'Message' })
  await field.fill('new follow-up')
  fixture.fail()
  await full.getByRole('button', { name: 'Send', exact: true }).click()
  await full.getByRole('alert').waitFor()
  assert.equal(await field.inputValue(), 'new follow-up', 'a refused submission retains its draft')
  await full.getByRole('button', { name: 'Send', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('textarea')?.readOnly === true)
  assert.equal(await field.inputValue(), 'new follow-up', 'submitting retains draft')
  fixture.release()
  await full.locator('[data-submission="9"]').waitFor()
  assert.equal(await field.inputValue(), '')
  assert.deepEqual(fixture.submissions[0], fixture.submissions[1], 'unchanged retry uses the same operation ID')
  fixture.holdRemoval(true)
  const remove = full.getByRole('button', { name: 'Remove queued message 2', exact: true })
  await remove.click()
  assert(await remove.isDisabled(), 'only the selected removal is busy')
  assert(await full.getByRole('button', { name: 'Remove queued message 3', exact: true }).isEnabled())
  assert.equal(await field.inputValue(), '', 'removal leaves the composer available')
  fixture.releaseRemoval()
  // The typed client's copy for a failure the API did not type, then the reference to quote.
  await full.getByRole('alert').getByText('Could not remove the queued message.', { exact: false }).waitFor()
  assert(await remove.isEnabled(), 'a failed removal can be retried')
  assert.equal(await full.locator('[data-submission="6"]').count(), 1, 'a failed removal keeps its input')
  assert.equal(await inline.locator('[data-submission="6"]').count(), 1)
  await remove.click()
  await full.locator('[data-submission="6"]').waitFor({ state: 'hidden' })
  await inline.locator('[data-submission="6"]').waitFor({ state: 'hidden' })
  assert(await full.getByPlaceholder('Add a follow-up…').isVisible(), 'removing a queued item leaves active work alive')
  await fixture.placed()
  await full.locator('[data-submission="5"]').waitFor({ state: 'hidden' })
  await page.reload()
  await full.locator('[data-submission="9"]').waitFor()
  assert.equal(await full.locator('[data-submission]').count(), 3, 'reload restores pending inputs')
  results.push({ label, bounds, retry: true, restored: true, sharedStream: true, removal: true, removalRetry: true })
}

const server = await createServer({ configFile: path.join(import.meta.dirname, 'browser/vite.config.ts') })
await server.listen()
const origin = server.resolvedUrls?.local[0]
if (!origin) throw new Error('queue_fixture_origin_missing')
const browser = await chromium.launch()
try {
  for (const width of [1440, 390])
    for (const dark of [false, true]) {
      const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce' })
      try {
        await matrix(origin, page, `${width}-${dark ? 'dark' : 'light'}`, dark)
      } finally {
        await page.close()
      }
    }
  assert.deepEqual(errors, [])
} finally {
  writeFileSync(
    path.join(out, 'receipt.json'),
    JSON.stringify({ evidence: 'local Chromium with HTTP/native-event fixtures', results, errors }, null, 2),
  )
  await browser.close()
  await server.close()
}
writeSync(STDOUT, `${JSON.stringify({ checks: results.length, errors, out })}\n`)
