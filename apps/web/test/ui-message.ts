/** Local SDK-frame acceptance: no account, remote tool, deployment or model call. */
import assert from 'node:assert/strict'
import { writeSync } from 'node:fs'
import path from 'node:path'
import { build, createServer } from 'vite'
import { chromium } from 'playwright-core'
import { record, records } from '../src/lib/boundary.ts'

/** Where this script reports (@cloudflare/workers-types makes `process` `any`). */
const STDOUT = 1
const STDERR = 2

const built = await build({
  configFile: false,
  build: {
    write: false,
    minify: false,
    lib: {
      entry: path.join(import.meta.dirname, 'browser/question-app.ts'),
      name: 'QuestionFixture',
      formats: ['iife'],
    },
  },
})
const bundles = Array.isArray(built) ? built : [built]
const chunk = bundles
  .flatMap((item) => {
    assert('output' in item, 'unexpected fixture watch build')
    return item.output
  })
  .find((item) => item.type === 'chunk')
assert(chunk?.type === 'chunk', 'missing SDK fixture bundle')
const html = `<!doctype html><html><body><script>${chunk.code.replaceAll('</script', '<\\/script')}</script></body></html>`
const receipt = {
  type: 'myplan.question.answer',
  version: 1,
  workspaceId: 'ws_fixture',
  itemId: 'item_fixture',
  threadId: 'thread_fixture',
  questionId: 'question_fixture',
  answerOperationId: 'answer_fixture',
  url: 'https://dev.myplan.lol/workspaces/ws_fixture/items/item_fixture',
}
const server = await createServer({ configFile: path.join(import.meta.dirname, 'browser/vite.config.ts') })
await server.listen()
const origin = server.resolvedUrls?.local[0]
assert(origin, 'missing browser fixture origin')
const browser = await chromium.launch()
const errors: string[] = []
/** The owner messages the page posted, as sent: read through `submitted`. */
const submissions: unknown[] = []
const submitted = (index: number) => record(submissions[index])
let saved = false
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
  page.on('pageerror', (error) => errors.push(error.message))
  await page.route('**/api/mcp/myplan/resources/read', (route) =>
    route.fulfill({
      json: { contents: [{ uri: 'ui://myplan/question.html', mimeType: 'text/html;profile=mcp-app', text: html }] },
    }),
  )
  await page.route('**/api/mcp/myplan/tools/call', (route) => {
    assert.equal(route.request().headers()['x-mcp-caller'], 'app')
    const body = record(route.request().postDataJSON())
    if (body?.name === 'question_answer') saved = true
    return route.fulfill({ json: { content: [], structuredContent: saved ? { continuation: receipt } : {} } })
  })
  await page.route('**/api/conversations/*/messages', (route) => {
    assert.equal(new URL(route.request().url()).pathname, '/api/conversations/7/messages')
    const body = record(route.request().postDataJSON())
    submissions.push(body)
    // The second try is answered with Pi's receipt, as the owner API's contract has it.
    return route.fulfill(
      submissions.length === 1
        ? { status: 503, json: { error: 'TemporaryFailure' } }
        : { status: 202, json: { accepted: true, session: 'session-7', operationId: body?.operationId } },
    )
  })
  await page.goto(`${origin}message.html`)
  const frame = page.frameLocator('iframe').frameLocator('iframe')
  try {
    await frame.getByRole('status').filter({ hasText: 'Ready' }).waitFor({ timeout: 10000 })
  } catch (cause) {
    const diagnostics = {
      frames: page.frames().map((item) => item.url()),
      body: await page.locator('body').innerText(),
      errors,
    }
    writeSync(STDERR, `Fixture diagnostics ${JSON.stringify(diagnostics)}\n`)
    throw cause
  }
  await frame.getByRole('textbox', { name: 'Answer' }).fill('answer stays inside MyPlan')
  await frame.getByRole('button', { name: 'Save answer' }).click()
  await frame.getByRole('status').filter({ hasText: 'Saved; use Continue' }).waitFor()
  assert.equal(submissions.length, 0, 'App staging must not submit an owner message')
  const offer = page.getByRole('status', { name: 'Continue after MyPlan answer' })
  await offer.waitFor()
  await offer.getByRole('button', { name: 'Continue' }).click()
  await offer.getByRole('alert').waitFor()
  await offer.getByRole('button', { name: 'Continue' }).click()
  await offer.waitFor({ state: 'hidden' })
  assert.equal(submissions.length, 2)
  assert.equal(submitted(0)?.operationId, submitted(1)?.operationId, 'retry uses the same receipt operation')
  assert.equal(submitted(0)?.input, 'Continue with the saved MyPlan answer.')
  assert.equal(records(submitted(0)?.appContext)[0]?.app, '42')
  assert(
    !JSON.stringify(submissions).includes('answer stays inside MyPlan'),
    'owner continuation carries no answer text',
  )
  await page.reload()
  await offer.waitFor()
  assert.equal(submissions.length, 2, 'reload may stage but cannot auto-send')
  await offer.getByRole('button', { name: 'Continue' }).click()
  await offer.waitFor({ state: 'hidden' })
  assert.equal(submitted(2)?.operationId, submitted(0)?.operationId, 'reload reuses receipt identity')
  await page.reload()
  await offer.waitFor()
  await offer.getByRole('button', { name: 'Dismiss' }).click()
  await offer.waitFor({ state: 'hidden' })
  assert.equal(submissions.length, 3, 'Dismiss leaves the saved answer without conversation continuation')
  assert.deepEqual(errors, [])
  writeSync(
    STDOUT,
    'MCP question App browser acceptance: save, stage, owner Continue, retry, reload, dismiss passed.\n',
  )
} finally {
  await browser.close()
  await server.close()
}
