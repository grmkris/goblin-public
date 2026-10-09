import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { compilers } from '../../coding/scripts/binaries.ts'
import { Overlay } from '../../coding/scripts/overlay.ts'
import { DockerRunner } from '../../coding/scripts/runner/docker.ts'
import { HttpRunner, httpsTransport } from '../../coding/scripts/runner/http.ts'
import { NativeRunner } from '../../coding/scripts/runner/native.ts'
import { limits } from '../../coding/scripts/runner/contract.ts'

export const root = path.resolve(import.meta.dirname, '../../..')
export const state = path.join(root, '.local/coding-cf-spike')
export async function fixture() {
  const config: { root: string; base: string } = await Bun.file(
    path.join(root, '.local/coding-spike/config.json'),
  ).json()
  const names: string[] = await Bun.file(path.join(root, '.local/coding-spike/files.json')).json()
  const files = new Map<string, string>()
  for (const name of names)
    if (/^apps\/cli\/(?:src|test)\/.*\.ts$/u.test(name))
      files.set(name, await readFile(path.join(config.root, name), 'utf8'))
  const changes: [string, string][] = []
  const published = path.join(root, '.local/coding-spike/pr')
  for await (const name of new Bun.Glob('apps/cli/{src,test}/**/*.ts').scan(published)) {
    const content = await Bun.file(path.join(published, name)).text()
    if (files.get(name) !== content) changes.push([name, content])
  }
  if (changes.length === 0 || changes.length > 8) throw new Error('missing_hello_fixture')
  return { ...config, files, changes }
}
export async function backends(data: Awaited<ReturnType<typeof fixture>>, image: string | undefined, endpoint: string) {
  const env = await readFile(path.join(state, 'runner.env'), 'utf8')
  const token = env.match(/^GOBLIN_CODING_RUNNER_TOKEN=(\w+)$/mu)?.[1]
  if (!token) throw new Error('runner_token_missing')
  const receipt: { image: string; imageDigest: string } = await Bun.file(path.join(state, 'image-receipt.json')).json()
  const docker = new DockerRunner({
    image: image ?? receipt.image,
    state: path.join(root, '.local/coding-runner/comparison'),
  })
  await docker.reconcile()
  return {
    native: new NativeRunner(data.files, compilers(state), (spec, input) => docker.executeChecked(spec, input)),
    docker,
    cloudflare: new HttpRunner(httpsTransport(endpoint, token), 'cloudflare', receipt.imageDigest),
  }
}
export function request(overlay: Overlay) {
  return { session: overlay.id, base: overlay.base, revision: overlay.revision, changes: [...overlay.changes] }
}
export function specification(data: Awaited<ReturnType<typeof fixture>>, taskId: string) {
  return { taskId, base: data.base, snapshot: data.root, limits }
}
