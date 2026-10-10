/**
 * What a first visit downloads, A/B: builds the web app from two revisions into fresh directories (the checkout's
 * `dist` accumulates generations) and sizes, from TanStack Start's route manifest, the JavaScript the root and each
 * chat route preload, the stylesheet every page links, all client JavaScript (lazy chunks included) and the Worker.
 *
 *   heavy bun apps/web/test/ui-bytes.ts [--base <ref>] [--candidate <ref|.>] [--keep]
 *
 * Sizes are deterministic, so one build of each is enough. The receipt goes to `.local/goblin-perf/<utc>-bytes/`.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync, writeSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { brotliCompressSync, gzipSync } from 'node:zlib'
import { build, cleanUp, receiptDirectory, revision } from './perf/revision.ts'

/** Where this script reports (@cloudflare/workers-types makes `process` `any`). */
const STDOUT = 1
const { values: options } = parseArgs({
  options: {
    base: { type: 'string', default: 'HEAD' },
    candidate: { type: 'string', default: '.' },
    keep: { type: 'boolean', default: false },
  },
})
const out = receiptDirectory('bytes')
mkdirSync(out, { recursive: true, mode: 0o700 })

/** The routes a chat opens through: the shell's root, the main chat and a chat by id. */
const ROUTES = ['/', '/c/$chatId'] as const
type Size = { readonly raw: number; readonly gzip: number; readonly brotli: number }
/** Each file compressed on its own, as it travels, then summed. */
const size = (list: readonly string[]): Size =>
  list
    .map((file) => readFileSync(file))
    .reduce(
      (total, bytes) => ({
        raw: total.raw + bytes.length,
        gzip: total.gzip + gzipSync(bytes, { level: 9 }).length,
        brotli: total.brotli + brotliCompressSync(bytes).length,
      }),
      { raw: 0, gzip: 0, brotli: 0 },
    )
const files = (directory: string, extension: string): string[] =>
  readdirSync(directory, { recursive: true, encoding: 'utf8' })
    .filter((name) => name.endsWith(extension))
    .map((name) => path.join(directory, name))

type Manifest = { routes: Record<string, { preloads?: readonly string[] }> }

/** The sizes of one built revision. */
async function measure(dist: string): Promise<Record<string, Size>> {
  const client = path.join(dist, 'client')
  const server = path.join(dist, 'server')
  const name = /_tanstack-start-manifest_v-[\w-]+\.js/u.exec(readFileSync(path.join(server, 'server.js'), 'utf8'))?.[0]
  if (name === undefined) throw new Error('start_manifest_missing')
  const loaded: { tsrStartManifest: () => Manifest } = await import(
    pathToFileURL(path.join(server, 'assets', name)).href
  )
  const { routes } = loaded.tsrStartManifest()
  const preloads = (route: string) => routes[route]?.preloads ?? []
  const chunks = (list: readonly string[]) => [...new Set(list)].map((asset) => path.join(client, asset))
  const css = files(path.join(client, 'assets'), '.css')
  return {
    rootJs: size(chunks(preloads('__root__'))),
    ...Object.fromEntries(
      ROUTES.map((route) => [`route ${route} js`, size(chunks([...preloads('__root__'), ...preloads(route)]))]),
    ),
    stylesheet: size(css.filter((file) => path.basename(file).startsWith('styles-'))),
    allClientJs: size(files(client, '.js')),
    allClientCss: size(css),
    worker: size(files(server, '.js')),
  }
}

const sides = []
try {
  for (const [label, ref] of [
    ['A', options.base],
    ['B', options.candidate],
  ] as const) {
    const built = revision(ref)
    const dist = path.join(out, `build-${label}`)
    build(built, dist)
    sides.push({ label, ref, sha: built.sha, sizes: await measure(dist) })
  }
} finally {
  cleanUp(options.keep)
}
const [a, b] = sides
if (a === undefined || b === undefined) throw new Error('bytes_sides_missing')
const kb = (bytes: number) => Math.round(bytes / 102.4) / 10
const lines = Object.entries(a.sizes).map(([what, before]) => {
  const after = b.sizes[what] ?? { raw: 0, gzip: 0, brotli: 0 }
  const change = (key: keyof Size) => `${kb(before[key])} → ${kb(after[key])} (${kb(after[key] - before[key])})`
  return `| ${what} | ${change('raw')} | ${change('gzip')} | ${change('brotli')} |`
})
writeFileSync(path.join(out, 'receipt.json'), JSON.stringify({ evidence: 'local production builds', sides }, null, 2))
writeFileSync(
  path.join(out, 'summary.md'),
  [
    `# Web bytes: A ${a.sha} vs B ${b.sha}`,
    '',
    "KiB, A → B (change). Route rows are the root's preloads plus the route's, each file once.",
    '',
    '| what | raw | gzip | brotli |',
    '| --- | --- | --- | --- |',
    ...lines,
    '',
  ].join('\n'),
)
writeSync(STDOUT, `${JSON.stringify({ out, rows: lines.length })}\n`)
