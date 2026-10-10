/**
 * Does the transcript land where it should? Builds the fixture in `perf/` (the real `useConversation` → projection →
 * `Conversation` path over a faked stream; no account, network or model), plays scripted owner turns against a long
 * history on a phone profile and a desktop one, and reports what the scroller did frame by frame: how far the newest row
 * sat under the composer, whether the jump-to-end arrow was offered while streaming, whether the view was pulled back
 * up, and whether rows that were already there moved.
 *
 *   heavy bun apps/web/test/ui-follow.ts [--scenarios reply,tools,long-first,dock,same-batch,resnapshot] [--profiles mobile,desktop]
 *     [--parts 60] [--dist <built fixture>] [--assert]
 *
 * With `--shots` it also saves screenshots to the receipt directory: mid-turn, settled, and the last turn's folded line opened.
 * With `--assert` it exits 1 when a turn ends with its newest row hidden or the arrow still offered. Receipts go to
 * `.local/goblin-perf/<utc>-follow/receipt.json`.
 */
import { mkdirSync, writeFileSync, writeSync } from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { type Browser, chromium, type Page } from 'playwright-core'
import { install, PROFILES, serve } from './perf/browser.ts'
import { build, receiptDirectory, revision } from './perf/revision.ts'
import {
  FOLLOW_SCENARIOS,
  type FollowReport,
  type FollowScenario,
  followSteps,
  history,
} from './perf/transcript-fixture.ts'

const STDOUT = 1
const STDERR = 2
const { values: options } = parseArgs({
  options: {
    scenarios: { type: 'string', default: FOLLOW_SCENARIOS.join(',') },
    profiles: { type: 'string', default: 'desktop,mobile' },
    parts: { type: 'string', default: '60' },
    dist: { type: 'string' },
    assert: { type: 'boolean', default: false },
    shots: { type: 'boolean', default: false },
  },
})
const isScenario = (name: string): name is FollowScenario => FOLLOW_SCENARIOS.some((known) => known === name)

const out = receiptDirectory('follow')
mkdirSync(out, { recursive: true, mode: 0o700 })
const FOLDED_LINE = '[data-slot="tool-call-trigger"]'
const shot = (page: Page, name: string) => page.screenshot({ path: path.join(out, `${name}.png`) })

/** The newest folded line, as it reads while a tool turn runs, then a picture of the screen. */
async function sampleLine(page: Page, name: string): Promise<void> {
  const line = page.locator(FOLDED_LINE).last()
  for (const wait of [800, 1_000, 1_000, 1_000]) {
    await page.waitForTimeout(wait)
    const text = (await line.count()) > 0 ? await line.textContent() : null
    writeSync(STDERR, `    live line: ${JSON.stringify(text)}\n`)
  }
  await shot(page, `${name}-live`)
}

/** The settled screen and, for a tool turn, the newest folded line opened. */
async function shootSettled(page: Page, name: string, tools: boolean): Promise<void> {
  await shot(page, `${name}-settled`)
  const opener = page.locator(FOLDED_LINE).last()
  if (!tools || (await opener.count()) === 0) return
  await opener.click()
  await page.waitForTimeout(400)
  await shot(page, `${name}-open`)
}

/** One scripted turn on a fresh page in `profile`: what the scroller did, and with `--shots` how it looked. */
async function play(
  browser: Browser,
  origin: string,
  profile: string,
  scenario: FollowScenario,
): Promise<FollowReport> {
  const settings = PROFILES[profile]
  if (settings === undefined) throw new Error(`unknown profile ${profile}`)
  const { entries, parts } = history(Number(options.parts))
  const context = await browser.newContext(settings.context)
  try {
    const page = await context.newPage()
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    const cdp = await context.newCDPSession(page)
    if (settings.cpu > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: settings.cpu })
    await install(page, entries)
    await page.goto(`${origin}/?parts=${parts}`)
    await page.waitForFunction(() => window.perf.ready !== undefined, null, { timeout: 120_000 })
    const playing = page.evaluate((script) => window.perf.follow(script), followSteps(scenario, entries))
    const tools = options.shots && scenario === 'tool-storm'
    if (tools) await sampleLine(page, `${profile}-${scenario}`)
    const report = await playing
    if (options.shots) await shootSettled(page, `${profile}-${scenario}`, tools)
    if (errors.length > 0) throw new Error(`${scenario} ${profile}: ${errors.join('; ')}`)
    return report
  } finally {
    await context.close()
  }
}

const dist = options.dist ?? path.join(out, 'build')
if (options.dist === undefined) build(revision('.'), dist, 'test/perf/vite.config.ts')
const served = await serve(dist)
const browser = await chromium.launch()

type Row = { readonly scenario: string; readonly profile: string; readonly report: FollowReport }
const rows: Row[] = []
try {
  for (const profile of options.profiles.split(',')) {
    for (const scenario of options.scenarios.split(',').filter(isScenario)) {
      const report = await play(browser, served.origin, profile, scenario)
      rows.push({ scenario, profile, report })
      const { trace, ...numbers } = report
      writeSync(STDERR, `${profile} ${scenario} ${JSON.stringify(numbers)}\n`)
      for (const line of trace.slice(0, 40)) writeSync(STDERR, `    ${line}\n`)
    }
  }
} finally {
  await browser.close()
  served.close()
}
writeFileSync(
  path.join(out, 'receipt.json'),
  JSON.stringify({ evidence: 'local Chromium, fixture build', rows }, null, 2),
)
const failing = rows.filter(({ report }) => report.hiddenFinal > 1 || report.arrowFinal)
writeSync(
  STDOUT,
  `${JSON.stringify({ out, turns: rows.length, failing: failing.map((row) => `${row.profile} ${row.scenario}`) })}\n`,
)
if (options.assert && failing.length > 0) process.exitCode = 1
