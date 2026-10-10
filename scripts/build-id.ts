/**
 * The build a stage deploy names: the checkout's full commit SHA. `stage.ts` hands it to the web build as
 * `VITE_GOBLIN_BUILD`, so a crash report names the release it came from, and the smoke looks for it in the deployed
 * client bundle.
 */
import { execFileSync } from 'node:child_process'

const SHA = /^[0-9a-f]{40}$/u

/** `root`'s HEAD commit. A release checkout may belong to another user, so git is told to trust it. */
export function releaseBuild(root: string): string {
  const head = execFileSync('git', ['-c', `safe.directory=${root}`, '-C', root, 'rev-parse', '--verify', 'HEAD'], {
    encoding: 'utf8',
  }).trim()
  if (!SHA.test(head)) throw new Error('release_build_sha_required')
  return head
}

/** Every built script a page or a chunk names: `/assets/<file>.js` in the HTML, `./<file>.js` between chunks. */
const scriptsIn = (text: string): string[] =>
  Array.from(text.matchAll(/(?:\/assets\/|\.\/)([\w.-]+\.js)\b/gu), ([, file]) => `/assets/${file ?? ''}`)

/**
 * Whether the client bundle a page loads carries `build`: the scripts the page names and, breadth first, the chunks
 * they import, reading at most `limit` files.
 */
export async function bundleCarries(
  page: string,
  build: string,
  read: (path: string) => Promise<string>,
  limit = 60,
): Promise<boolean> {
  const queue = [...new Set(scriptsIn(page))]
  const seen = new Set(queue)
  for (let index = 0; index < queue.length && index < limit; index++) {
    const code = await read(queue[index] ?? '')
    if (code.includes(build)) return true
    for (const next of scriptsIn(code)) {
      if (seen.has(next)) continue
      seen.add(next)
      queue.push(next)
    }
  }
  return false
}
