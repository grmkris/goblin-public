// Builds the agent app toolchain (ADR 0021). dist/toolchain.js holds what runs in Dynamic Workers, as ESM source
// strings: the SDK, the release entry, the transpiler, the style compiler with the stylesheets it compiles, and the
// agent's docs, with one hash over the code (part of every release id). dist/runtime/ holds what an app's frame loads:
// core.js (React, the UI SDK, goblin's components), ui.css (their styles and the kit's), and charts.js, maps.js (+
// maps.css), diagrams.js and icons.js, which share core's React through the frame's module registry.
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { type Sheets, candidates, compileCss } from '../src/css.ts'
import { VIEW_IMPORTS } from '../src/view-imports.ts'

const root = new URL('..', import.meta.url).pathname
const packages = new URL('../..', import.meta.url).pathname

/** Leaves a release's or an isolate's sibling module to its module map: `./app.js`, `./sheets.js`. */
const siblings: Bun.BunPlugin = {
  name: 'siblings',
  setup(build) {
    build.onResolve({ filter: /^\.\/(?:app|sheets|view)\.js$/u }, (args) => ({ path: args.path, external: true }))
  },
}

/** A frame bundle's React (and React DOM) is core's, required from the frame's registry. */
const sharedReact: Bun.BunPlugin = {
  name: 'shared-react',
  setup(build) {
    build.onResolve({ filter: /^(?:react|react-dom)(?:\/.*)?$/u }, (args) => ({ path: args.path, namespace: 'shared' }))
    build.onLoad({ filter: /.*/u, namespace: 'shared' }, (args) => ({
      contents: `module.exports = globalThis.__goblinRequire(${JSON.stringify(args.path)})`,
      loader: 'js',
    }))
  },
}

async function isolateModule(entry: string, minify: boolean): Promise<string> {
  const result = await Bun.build({
    entrypoints: [`${root}src/${entry}`],
    format: 'esm',
    target: 'browser',
    minify,
    external: ['cloudflare:workers'],
    plugins: [siblings],
  })
  if (!result.success) throw new AggregateError(result.logs, `build of ${entry} failed`)
  const [output] = result.outputs
  if (output === undefined) throw new Error(`build of ${entry} produced nothing`)
  return output.text()
}

/** A frame bundle: its script and, for maps, its stylesheet. */
async function frameBundle(name: string): Promise<{ readonly js: string; readonly css: string }> {
  const result = await Bun.build({
    entrypoints: [`${root}src/ui/${name}.ts`],
    format: 'iife',
    target: 'browser',
    minify: true,
    define: { 'process.env.NODE_ENV': '"production"' },
    plugins: name === 'core' ? [] : [sharedReact],
  })
  if (!result.success) throw new AggregateError(result.logs, `build of ${name} failed`)
  const js = result.outputs.find((output) => output.kind === 'entry-point')
  const css = result.outputs.filter((output) => output.path.endsWith('.css'))
  if (js === undefined) throw new Error(`build of ${name} produced nothing`)
  return { js: await js.text(), css: (await Promise.all(css.map((output) => output.text()))).join('\n') }
}

const text = (path: string) => readFile(path, 'utf8')

/** Every word of goblin's components, the kit and the frame's own code that could be a class. */
async function componentWords(): Promise<string[]> {
  const dirs = [`${packages}ui/src/components`, `${packages}kit/src`, `${root}src/ui`]
  const words: string[] = []
  for (const dir of dirs)
    for (const file of (await readdir(dir)).toSorted())
      if (/\.tsx?$/u.test(file)) words.push(...candidates(await text(`${dir}/${file}`)))
  return words
}

const ui = `${packages}ui/src`
const sheets: Sheets = {
  theme: await text(`${ui}/styles.css`),
  imports: {
    tailwindcss: await text(`${root}node_modules/tailwindcss/index.css`),
    'tw-animate-css': await text(`${root}node_modules/tw-animate-css/dist/tw-animate.css`),
    './shadcn.css': await text(`${ui}/shadcn.css`),
    './typeset.css': await text(`${ui}/typeset.css`),
    '@fontsource-variable/geist': '',
  },
}
const styleSheets = `export default ${JSON.stringify(sheets)}\n`

const sdk = await isolateModule('sdk.ts', false)
const release = await isolateModule('release.ts', false)
const transpiler = await isolateModule('transpile.ts', true)
const style = await isolateModule('style.ts', true)
const render = await isolateModule('render.ts', true)
const docs: Record<string, string> = {}
for (const file of (await readdir(`${root}docs`)).toSorted())
  if (file.endsWith('.md')) docs[file.replace(/\.md$/u, '')] = await text(`${root}docs/${file}`)

const frame: Record<string, string> = {
  'ui.css': `${await compileCss(sheets, await componentWords())}\n${await text(`${packages}kit/src/kit.css`)}`,
}
for (const name of ['core', 'charts', 'maps', 'diagrams', 'icons']) {
  const bundle = await frameBundle(name)
  frame[`${name}.js`] = bundle.js
  if (bundle.css !== '') frame[`${name}.css`] = bundle.css
}
const hash = createHash('sha256')
  .update(JSON.stringify({ sdk, release, transpiler, style, styleSheets, render }))
  .digest('hex')
  .slice(0, 16)

const module = [
  '// Generated by packages/app/scripts/build.ts. Do not edit.',
  `export const TOOLCHAIN_HASH = ${JSON.stringify(hash)}`,
  `export const SDK = ${JSON.stringify(sdk)}`,
  `export const RELEASE = ${JSON.stringify(release)}`,
  `export const TRANSPILER = ${JSON.stringify(transpiler)}`,
  `export const STYLE = ${JSON.stringify(style)}`,
  `export const STYLE_SHEETS = ${JSON.stringify(styleSheets)}`,
  `export const RENDER = ${JSON.stringify(render)}`,
  `export const RENDER_IMPORTS = ${JSON.stringify(Object.keys(VIEW_IMPORTS))}`,
  `export const DOCS = ${JSON.stringify(docs)}`,
  '',
].join('\n')
await mkdir(`${root}dist`, { recursive: true })
await writeFile(`${root}dist/toolchain.js`, module)
await rm(`${root}dist/runtime`, { recursive: true, force: true })
await mkdir(`${root}dist/runtime`, { recursive: true })
for (const [name, content] of Object.entries(frame)) await writeFile(`${root}dist/runtime/${name}`, content)

const kb = (value: string) => `${(value.length / 1024).toFixed(0)} KB`
console.info(
  `@goblin/app toolchain ${hash}: transpiler ${kb(transpiler)}, style ${kb(style)} + ${kb(styleSheets)}; frame ${Object.entries(
    frame,
  )
    .map(([name, content]) => `${name} ${kb(content)}`)
    .join(', ')}`,
)
