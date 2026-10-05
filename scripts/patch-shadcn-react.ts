/**
 * `bun scripts/patch-shadcn-react.ts [--test]`: rebuilds `patches/@shadcn%2Freact@0.3.1.patch`, Purrable's patch of the
 * MessageScroller in @shadcn/react, from upstream source (patches/shadcn-react/README.md says what is in it and why).
 *
 * In a temporary directory it checks out shadcn-ui/ui at the 0.3.1 release, applies `patches/shadcn-react/
 * message-scroller.diff`, installs the package with upstream's own pnpm and lockfile, and builds the message-scroller
 * entry unminified and self-contained, with a marker line `tools/check-patches.ts` looks for. It proves the public
 * types did not change, then writes the patch as a git diff of the published file against the built one, so bun
 * applies it on install. `--test` first runs upstream's jsdom and browser suites (Playwright Chromium) on the patched
 * source. Run it through `heavy`; it never touches node_modules here: `bun install` applies the new patch afterwards.
 */
import { createHash } from 'node:crypto'
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const VERSION = '0.3.1'
/** shadcn-ui/ui `chore(release): version packages` (#11714), the commit @shadcn/react 0.3.1 was published from. */
const BASE = '63c1308d112b6b1205d86244a156cca1abef5087'
const ROOT = path.resolve(import.meta.dirname, '..')
const DIFF = path.join(ROOT, 'patches/shadcn-react/message-scroller.diff')
const PATCH = path.join(ROOT, `patches/@shadcn%2Freact@${VERSION}.patch`)
const ENTRY = 'dist/message-scroller/index.js'
const TYPES = 'dist/message-scroller/index.d.ts'
/** The line tools/check-patches.ts finds in the installed file: the patch applied, and which diff it was built from. */
const MARKER = `// @shadcn/react ${VERSION} + purrable patches/shadcn-react ${createHash('sha256').update(readFileSync(DIFF)).digest('hex').slice(0, 12)}`
const BUILD_CONFIG = `import { defineConfig } from "tsup"

export default defineConfig({
  entry: { "message-scroller/index": "src/message-scroller/index.ts" },
  format: ["esm"],
  dts: false,
  minify: false,
  splitting: false,
  sourcemap: false,
  target: "esnext",
  treeshake: true,
  outDir: "dist-purrable",
})
`

function run(argv: readonly string[], cwd: string): string {
  const result = Bun.spawnSync([...argv], { cwd, stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0)
    throw new Error(
      `${argv.join(' ')} failed (${result.exitCode}):\n${result.stderr.toString()}${result.stdout.toString()}`,
    )
  return result.stdout.toString()
}

/** The published package, from the registry tarball: what bun installs before it applies the patch. */
function published(work: string): string {
  const tarball = run(['npm', 'pack', `@shadcn/react@${VERSION}`, '--silent'], work).trim()
  run(['tar', '-xzf', tarball], work)
  return path.join(work, 'package')
}

/** Upstream at BASE with the diff applied and its dependencies installed. */
function upstream(work: string): string {
  const repo = path.join(work, 'ui')
  run(
    [
      'git',
      'clone',
      '--quiet',
      '--filter=blob:none',
      '--sparse',
      '--no-checkout',
      'https://github.com/shadcn-ui/ui.git',
      repo,
    ],
    work,
  )
  run(['git', 'sparse-checkout', 'set', 'packages/react'], repo)
  run(['git', 'checkout', '--quiet', BASE], repo)
  run(['git', 'apply', DIFF], repo)
  const manifest: unknown = JSON.parse(readFileSync(path.join(repo, 'package.json'), 'utf8'))
  const pnpm =
    typeof manifest === 'object' && manifest !== null && 'packageManager' in manifest
      ? String(manifest.packageManager)
      : ''
  if (!pnpm.startsWith('pnpm@')) throw new Error(`upstream packageManager is ${pnpm || 'unset'}, expected pnpm`)
  run(['bunx', pnpm, 'install', '--frozen-lockfile', '--filter', '@shadcn/react...'], repo)
  return path.join(repo, 'packages/react')
}

function test(pkg: string): void {
  const playwright = path.join(pkg, 'node_modules/playwright/cli.js')
  run(['node', playwright, 'install', 'chromium-headless-shell'], pkg)
  run(['node_modules/.bin/vitest', 'run', 'src/message-scroller'], pkg)
  run(['node_modules/.bin/vitest', 'run', '-c', 'vitest.browser.config.ts', 'src/message-scroller'], pkg)
}

/** The patched entry, built on its own; the public types of upstream's full build must equal the published ones. */
function build(pkg: string, pristine: string): string {
  run(['node_modules/.bin/tsup'], pkg)
  if (readFileSync(path.join(pkg, TYPES), 'utf8') !== readFileSync(path.join(pristine, TYPES), 'utf8'))
    throw new Error(`the patch changes ${TYPES}: the patch must replace it too`)
  writeFileSync(path.join(pkg, 'tsup.purrable.config.ts'), BUILD_CONFIG)
  run(['node_modules/.bin/tsup', '--config', 'tsup.purrable.config.ts'], pkg)
  const built = readFileSync(path.join(pkg, 'dist-purrable/message-scroller/index.js'), 'utf8')
  const imports = [...built.matchAll(/^import .* from "([^"]+)"/gmu)].map((match) => match[1])
  if (imports.some((specifier) => specifier !== 'react' && specifier !== 'react/jsx-runtime'))
    throw new Error(`the built entry imports ${imports.join(', ')}; only react may stay external`)
  // Prepended after the build, as upstream's own config does: tsup's tree shaking drops an esbuild banner.
  return `"use client";\n${MARKER}\n${built}`
}

/** The published file and the built one as a git diff with package-relative paths, the format bun applies. */
function patchOf(work: string, pristine: string, built: string): string {
  const repo = path.join(work, 'patch')
  run(['git', 'init', '--quiet', repo], work)
  const file = path.join(repo, ENTRY)
  run(['mkdir', '-p', path.dirname(file)], work)
  copyFileSync(path.join(pristine, ENTRY), file)
  run(['git', 'add', ENTRY], repo)
  writeFileSync(file, built)
  return run(['git', '-c', 'core.autocrlf=false', 'diff', '--no-color', '--no-ext-diff', ENTRY], repo)
}

const work = mkdtempSync(path.join(tmpdir(), 'patch-shadcn-react-'))
try {
  const pristine = published(work)
  const pkg = upstream(work)
  if (process.argv.includes('--test')) test(pkg)
  writeFileSync(PATCH, patchOf(work, pristine, build(pkg, pristine)))
  console.log(
    `wrote ${path.relative(ROOT, PATCH)} (${MARKER.slice(3)}); run \`bun install\`, then bun run check:patches`,
  )
} finally {
  rmSync(work, { recursive: true, force: true })
}
