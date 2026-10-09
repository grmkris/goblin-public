/**
 * `effect:check`: Effect language-service diagnostics (`@effect/tsgo`) on the given tsconfigs, one after another.
 *
 *   bun ../../tools/effect-check.ts tsconfig.json scripts/tsconfig.json     from a workspace's `effect:check` script
 *   bun tools/effect-check.ts --workspaces tsconfig.json                    `bun run effect:check`: the root tsconfig,
 *                                                                           then every workspace through turbo
 *
 * The diagnostics and their severities are configured in the `@effect/language-service` block of tsconfig.base.json
 * (docs/agents/effect.md). Errors, warnings and directives that change nothing gate (`gatingDiagnostics` in report.ts).
 * The check fails on any of them, when a tsconfig does not enable the plugin (its files would go unchecked) or when
 * effect-tsgo itself fails. Tsconfig paths are relative to
 * the current directory. This script does not use `heavy`; run the whole task through it (`heavy bun run effect:check`).
 */
import path from 'node:path'
import { effectTsgoArgs, verifiedEffectOutput } from './effect.ts'
import { decodeEffect, gatingDiagnostics, uncheckedFiles } from './report.ts'
import { bin, repoRoot, run } from './run.ts'

/** effect-tsgo exits 1 when it reports error diagnostics; anything else non-zero means it did not run. */
const FOUND = 1

/** Checks one tsconfig and prints its gating diagnostics. Returns whether it passed. */
const check = async (tsconfig: string): Promise<boolean> => {
  const project = path.resolve(tsconfig)
  const label = path.relative(repoRoot, project)
  const { stdout, stderr, exitCode } = await run(effectTsgoArgs(project))
  if (exitCode !== 0 && exitCode !== FOUND) {
    console.error(`${label}: effect-tsgo exited ${exitCode}\n${stderr.trim()}`)
    return false
  }
  const output = verifiedEffectOutput(decodeEffect(JSON.parse(stdout)))
  const found = gatingDiagnostics(output)
  for (const diagnostic of found)
    console.log(
      `${diagnostic.file}:${diagnostic.line}:${diagnostic.column} ${diagnostic.severity} effect(${diagnostic.name}): ${diagnostic.message}`,
    )
  const unchecked = uncheckedFiles(label, output)
  if (unchecked !== undefined) console.error(unchecked)
  console.log(`${label}: ${found.length} findings in ${output.summary.filesChecked} files`)
  return found.length === 0 && unchecked === undefined
}

/** Every workspace's effect:check, two at a time (each is a full type check); all of them run even when one fails. */
const workspaces = async (): Promise<boolean> => {
  const argv = [bin('turbo'), 'run', 'effect:check', '--concurrency=2', '--continue']
  console.log(`$ ${argv.join(' ')}`)
  return (await run(argv, { inherit: true })).exitCode === 0
}

const args = Bun.argv.slice(2)
const tsconfigs = args.filter((arg) => arg !== '--workspaces')
if (tsconfigs.length === 0) {
  console.error('usage: bun tools/effect-check.ts [--workspaces] <tsconfig>...')
  process.exit(2)
}
let passed = true
for (const tsconfig of tsconfigs) passed = (await check(tsconfig)) && passed
if (args.includes('--workspaces')) passed = (await workspaces()) && passed
process.exit(passed ? 0 : 1)
