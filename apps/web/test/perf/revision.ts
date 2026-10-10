/**
 * A revision of the web app to measure: the checkout itself (`.`), a prepared checkout elsewhere (an absolute path), or
 * a commit checked out in a scratch worktree with today's harness copied in. Shared by `../ui-perf.ts` and `../ui-bytes.ts`; runs in Bun, never in the page.
 */
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync } from 'node:fs'
import path from 'node:path'

export const REPO = path.resolve(import.meta.dirname, '../../../..')
const WORKTREES = '/tmp/goblin-perf-worktrees'

/** Runs a command to completion and returns its output; a failure throws with what it printed. */
export function run(command: string, args: readonly string[], cwd: string): string {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed in ${cwd}:\n${result.stderr}`)
  return result.stdout.trim()
}
export const git = (...args: string[]) => run('git', args, REPO)

export type Revision = { readonly ref: string; readonly sha: string; readonly root: string }
const created: string[] = []

/**
 * `ref` ready to build: `.` is the checkout as it stands (other agents' edits included), anything else a detached
 * worktree with its dependencies installed. The harness is always today's (`test/perf/` is copied in); the React
 * plugins stay the revision's own once it has `vite.react.ts`.
 */
export function revision(ref: string): Revision {
  if (ref === '.') return { ref, sha: `${git('rev-parse', 'HEAD')}+worktree`, root: REPO }
  // A prepared checkout elsewhere (a bake-off variant): measured as it stands.
  if (path.isAbsolute(ref) && existsSync(path.join(ref, 'apps/web'))) return { ref, sha: `dir:${ref}`, root: ref }
  const sha = git('rev-parse', ref)
  const root = path.join(WORKTREES, sha.slice(0, 12))
  if (!existsSync(root)) {
    git('worktree', 'add', '--detach', root, sha)
    created.push(root)
    run('bun', ['install', '--frozen-lockfile'], root)
    // The agent app toolchain (packages/app/dist) is bundled into the app, so it is built first, as deploys do.
    run('bun', ['run', 'build'], path.join(root, 'packages/app'))
  }
  cpSync(path.join(REPO, 'apps/web/test/perf'), path.join(root, 'apps/web/test/perf'), { recursive: true })
  if (!existsSync(path.join(root, 'apps/web/vite.react.ts')))
    cpSync(path.join(REPO, 'apps/web/vite.react.ts'), path.join(root, 'apps/web/vite.react.ts'))
  return { ref, sha, root }
}

/** Builds the web app (or, with `config`, a fixture of it) from `source` into `outDir`. */
export function build(source: Revision, outDir: string, config?: string): void {
  const args = ['x', 'vite', 'build', ...(config === undefined ? [] : ['--config', config]), '--outDir', outDir]
  run('bun', args, path.join(source.root, 'apps/web'))
}

/** Removes the worktrees this run created, unless they are to be kept for the next one. */
export function cleanUp(keep: boolean): void {
  if (!keep) for (const root of created.splice(0)) git('worktree', 'remove', '--force', root)
}

/** A receipt directory under `.local/goblin-perf/`, named by the time it starts (UTC). */
export function receiptDirectory(kind: string): string {
  return path.join(REPO, '.local/goblin-perf', `${new Date().toISOString().replaceAll(':', '-').slice(0, 19)}-${kind}`)
}
