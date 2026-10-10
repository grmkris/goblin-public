/**
 * Transcript performance, A/B. Builds the fixture in `perf/` (the real `useConversation` → projection → `Conversation`
 * path over a faked stream; no account, network or model) for production from two revisions, then measures them
 * interleaved in one session on a phone profile and a desktop one, because this box is shared and its load drifts.
 *
 *   heavy bun apps/web/test/ui-perf.ts [--base <ref>] [--candidate <ref|.>] [--reps 3]
 *     [--scenarios open,stream,scroll,idle] [--profiles mobile,desktop] [--keep]
 *
 * `--base` defaults to HEAD and `--candidate` to the working tree; the same revision twice gives the noise floor. Each
 * revision builds in a scratch worktree with today's fixture copied in and its own React plugins. Receipts go to
 * `.local/goblin-perf/<utc>-perf/`: every sample (`receipt.json`) and the verdicts (`summary.md`).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, writeSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { cpus, loadavg } from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { type Browser, type CDPSession, chromium, type Page } from 'playwright-core'
import { build, cleanUp, receiptDirectory, revision } from './perf/revision.ts'
import { history, type Sample, snapshot } from './perf/transcript-fixture.ts'

/** Where this script reports (@cloudflare/workers-types makes `process` `any`). */
const STDOUT = 1
const { values: options } = parseArgs({
  options: {
    base: { type: 'string', default: 'HEAD' },
    candidate: { type: 'string', default: '.' },
    reps: { type: 'string', default: '3' },
    scenarios: { type: 'string', default: 'open,stream,scroll,idle' },
    profiles: { type: 'string', default: 'mobile,desktop' },
    keep: { type: 'boolean', default: false },
  },
})
const out = receiptDirectory('perf')
mkdirSync(out, { recursive: true, mode: 0o700 })

/** A revision of the web app, its fixture built into `dist` and served from `origin`. */
type Variant = { label: string; ref: string; sha: string; dist: string; origin: string }
function prepare(ref: string, label: string): Variant {
  const source = revision(ref)
  const dist = path.join(out, `build-${label}`)
  build(source, dist, 'test/perf/vite.config.ts')
  return { label, ref, sha: source.sha, dist, origin: '' }
}

const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }
/** Serves a built fixture; anything that is not a file is the page. */
async function serve(variant: Variant): Promise<Server> {
  const server = createServer((request, response) => {
    const name = new URL(request.url ?? '/', 'http://fixture').pathname
    const file = path.join(variant.dist, name === '/' ? 'index.html' : name)
    const found = file.startsWith(variant.dist) && existsSync(file) ? file : path.join(variant.dist, 'index.html')
    response.writeHead(200, { 'content-type': TYPES[path.extname(found)] ?? 'application/octet-stream' })
    response.end(readFileSync(found))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('perf_fixture_address_missing')
  variant.origin = `http://127.0.0.1:${address.port}`
  return server
}

type Profile = { readonly cpu: number; readonly context: Parameters<Browser['newContext']>[0] }
const PROFILES: Record<string, Profile> = {
  mobile: {
    cpu: 4,
    context: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
  },
  desktop: { cpu: 1, context: { viewport: { width: 1280, height: 800 } } },
}
const SIZES = { open: [100, 200, 400, 800, 1600], stream: [0, 200, 1000], scroll: [1000], idle: [200] } as const
type Scenario = keyof typeof SIZES
const isScenario = (name: string): name is Scenario => Object.hasOwn(SIZES, name)

/** The fixture's own stream (the shape `ui-queue.ts` fakes) and its reads, answered from the synthetic history. */
async function install(page: Page, entries: readonly Record<string, unknown>[]) {
  await page.addInitScript(() => {
    class Events extends EventTarget {
      readonly forward = (event: Event) => {
        if (event instanceof MessageEvent) this.dispatchEvent(new MessageEvent('batch', { data: event.data }))
      }
      constructor() {
        super()
        window.addEventListener('fixture-batch', this.forward)
      }
      close() {
        window.removeEventListener('fixture-batch', this.forward)
      }
    }
    Object.defineProperty(window, 'EventSource', { value: Events })
  })
  const body = JSON.stringify(snapshot(entries))
  await page.route('**/api/**', (route) => {
    const action = new URL(route.request().url()).pathname.split('/').at(-1)
    if (action === 'snapshot') return route.fulfill({ body, contentType: 'application/json' })
    if (action === 'queue') return route.fulfill({ json: { inputs: [] } })
    return route.fulfill({ json: {} })
  })
}

const percentile = (values: readonly number[], p: number) => {
  const sorted = values.toSorted((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0
}
const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0)
const round = (value: number) => Math.round(value * 10) / 10
const frames = (sample: Sample) => ({
  frameP50: round(percentile(sample.frames, 50)),
  frameP95: round(percentile(sample.frames, 95)),
  slowFrames: sample.frames.filter((frame) => frame > 25).length,
  longTaskMs: round(sum(sample.longTasks)),
  commits: sample.commits,
  commitMs: round(sample.commitMs),
})

type Metrics = Record<string, number>
type Probe = { readonly page: Page; readonly cdp: CDPSession; readonly lastId: number }
const timings = async (cdp: CDPSession): Promise<Metrics> =>
  Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(({ name, value }) => [name, value]))
const ms = (seconds: number | undefined) => round((seconds ?? 0) * 1000)

/** Opening: until the whole transcript first shows at its end, what the main thread did, and what stays in memory. */
async function open({ page, cdp }: Probe): Promise<Metrics> {
  const at = await timings(cdp)
  await cdp.send('HeapProfiler.collectGarbage')
  const heap = await cdp.send('Runtime.getHeapUsage')
  return {
    readyMs: round(await page.evaluate(() => window.perf.ready ?? 0)),
    taskMs: ms(at.TaskDuration),
    scriptMs: ms(at.ScriptDuration),
    layoutMs: ms(at.LayoutDuration),
    styleMs: ms(at.RecalcStyleDuration),
    nodes: at.Nodes ?? 0,
    heapMb: round(heap.usedSize / 1024 / 1024),
  }
}

/** Streaming a reply while the owner types: frames, long tasks, React's work and how late keystrokes were painted. */
async function stream({ page, lastId }: Probe): Promise<Metrics> {
  await page.evaluate(() => window.perf.start())
  const streaming = page.evaluate((id) => window.perf.stream(id), lastId)
  await page.getByLabel('Typing probe').click()
  await page.keyboard.type('the quick brown fox jumps over', { delay: 120 })
  await streaming
  const sample = await page.evaluate(() => window.perf.stop())
  return { ...frames(sample), inputMax: round(Math.max(0, ...sample.inputs)), slowInputs: sample.inputs.length }
}

/** Reading back through history with the wheel. */
async function scroll({ page }: Probe): Promise<Metrics> {
  const box = page.viewportSize() ?? { width: 390, height: 844 }
  await page.mouse.move(box.width / 2, box.height / 2)
  await page.evaluate(() => window.perf.start())
  for (let step = 0; step < 30; step += 1) {
    await page.mouse.wheel(0, -500)
    await page.waitForTimeout(60)
  }
  return frames(await page.evaluate(() => window.perf.stop()))
}

/** After a reply finished: what the page keeps doing while nothing happens. */
async function idle(probe: Probe): Promise<Metrics> {
  await stream(probe)
  await probe.page.waitForTimeout(1000)
  const before = await timings(probe.cdp)
  await probe.page.waitForTimeout(10_000)
  const after = await timings(probe.cdp)
  return { idleTaskMsPerS: round(ms((after.TaskDuration ?? 0) - (before.TaskDuration ?? 0)) / 10) }
}
const SCENARIOS: Record<Scenario, (probe: Probe) => Promise<Metrics>> = { open, stream, scroll, idle }

type Job = { readonly variant: Variant; readonly scenario: Scenario; readonly size: number; readonly profile: string }
/** One measurement on a fresh page; every number is lower-is-better. */
async function measure(browser: Browser, { variant, scenario, size, profile }: Job): Promise<Metrics> {
  const { entries, parts } = history(size)
  const settings = PROFILES[profile]
  if (settings === undefined) throw new Error(`unknown profile ${profile}`)
  const context = await browser.newContext(settings.context)
  try {
    const page = await context.newPage()
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    const cdp = await context.newCDPSession(page)
    if (settings.cpu > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: settings.cpu })
    await cdp.send('Performance.enable')
    await install(page, entries)
    await page.goto(`${variant.origin}/?parts=${parts}`)
    await page.waitForFunction(() => window.perf.ready !== undefined, null, { timeout: 180_000 })
    const metrics = await SCENARIOS[scenario]({ page, cdp, lastId: entries.length })
    if (errors.length > 0) throw new Error(`${variant.label} ${scenario}: ${errors.join('; ')}`)
    return metrics
  } finally {
    await context.close()
  }
}

type Row = Omit<Job, 'variant'> & { readonly variant: string; readonly rep: number; readonly metrics: Metrics }
const median = (values: readonly number[]) => percentile(values, 50)
const spread = (values: readonly number[]) => (values.length === 0 ? 0 : Math.max(...values) - Math.min(...values))
/** B against A: a win or a regression only when the medians differ by more than either side's own spread. */
function verdict(a: readonly number[], b: readonly number[]) {
  const noise = Math.max(spread(a), spread(b))
  const delta = median(a) - median(b)
  if (delta > noise) return { noise, delta, verdict: 'win' as const }
  return { noise, delta, verdict: -delta > noise ? ('regression' as const) : ('same' as const) }
}
function verdicts(rows: readonly Row[]) {
  const groups = new Map<string, Row[]>()
  for (const row of rows) {
    const key = `${row.scenario} | ${row.size} | ${row.profile}`
    groups.set(key, [...(groups.get(key) ?? []), row])
  }
  return [...groups].flatMap(([key, group]) =>
    Object.keys(group[0]?.metrics ?? {}).map((metric) => {
      const side = (label: string) =>
        group.filter((row) => row.variant === label).map((row) => row.metrics[metric] ?? 0)
      const [a, b] = [side('A'), side('B')]
      const result = verdict(a, b)
      const change = median(a) === 0 ? '' : `${round((-result.delta / median(a)) * 100)}%`
      return {
        ...result,
        line: `| ${key} | ${metric} | ${median(a)} | ${median(b)} | ${change} | ${round(result.noise)} | ${result.verdict} |`,
      }
    }),
  )
}

const variants = [prepare(options.base, 'A'), prepare(options.candidate, 'B')]
const servers = await Promise.all(variants.map(serve))
const browser = await chromium.launch()
const environment = { chromium: browser.version(), cpus: cpus().length, loadBefore: loadavg().map(round) }
const reps = Array.from({ length: Number(options.reps) }, (_, rep) => rep)
// Interleaved, and in alternating order, so drifting load falls on both sides alike.
const jobs = options.scenarios
  .split(',')
  .filter(isScenario)
  .flatMap((scenario) =>
    SIZES[scenario].flatMap((size) =>
      options.profiles.split(',').flatMap((profile) =>
        reps.flatMap((rep) =>
          (rep % 2 === 0 ? variants : variants.toReversed()).map((variant) => ({
            variant,
            scenario,
            size,
            profile,
            rep,
          })),
        ),
      ),
    ),
  )
const rows: Row[] = []
try {
  for (const { variant, rep, ...job } of jobs)
    rows.push({ ...job, variant: variant.label, rep, metrics: await measure(browser, { variant, ...job }) })
} finally {
  await browser.close()
  for (const server of servers) server.close()
  cleanUp(options.keep)
}
const results = verdicts(rows)
const described = variants.map(({ label, ref, sha }) => ({ label, ref, sha }))
const loadAfter = loadavg().map(round)
writeFileSync(
  path.join(out, 'receipt.json'),
  JSON.stringify(
    {
      evidence: 'local Chromium, production fixture build, faked stream',
      variants: described,
      environment: { ...environment, loadAfter },
      rows,
    },
    null,
    2,
  ),
)
writeFileSync(
  path.join(out, 'summary.md'),
  [
    `# Transcript performance: A ${described[0]?.sha} vs B ${described[1]?.sha}`,
    '',
    `Chromium ${environment.chromium}, ${environment.cpus} CPUs, load ${environment.loadBefore.join(' ')} → ` +
      `${loadAfter.join(' ')}, ${reps.length} reps interleaved. Every metric is lower-is-better; a win or regression ` +
      'needs the medians to differ by more than the larger spread.',
    '',
    '| scenario | size | profile | metric | A | B | change | noise | verdict |',
    '| --- | ---: | --- | --- | ---: | ---: | ---: | ---: | --- |',
    ...results.map(({ line }) => line),
    '',
  ].join('\n'),
)
const count = (kind: string) => results.filter((result) => result.verdict === kind).length
writeSync(
  STDOUT,
  `${JSON.stringify({ out, wins: count('win'), regressions: count('regression'), samples: rows.length })}\n`,
)
