/**
 * `bun run check:patches`: every dependency in root package.json `patchedDependencies` is installed with its patch
 * applied (tools/patches.ts). Runs in `check` and `check:fast`, and in the deploy recipe after `bun install`.
 */
import { checkPatches, PATCHES } from './patches.ts'
import { repoRoot } from './run.ts'

const failures = checkPatches(repoRoot)
if (failures.length > 0) {
  for (const failure of failures) console.error(`check:patches: ${failure}`)
  process.exit(1)
}
console.log(`check:patches: ${PATCHES.map((spec) => spec.key).join(', ')} patched`)
