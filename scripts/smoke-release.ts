// The smoke's release checks, apart from smoke-dev.ts, which runs on import: what the deploy built and shipped.
import { fileURLToPath } from 'node:url'
import { bundleCarries, releaseBuild } from './build-id.ts'
import type { DevClient } from './smoke-client.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const ASSET_TIMEOUT_MS = 30_000

/**
 * The deployed client bundle names this checkout's commit (`VITE_GOBLIN_BUILD`, set by `stage.ts`), so the stage's
 * crash reports name their release. The local stack serves unbuilt source, which names none.
 */
export async function clientBuild(dev: DevClient, stage: string): Promise<string> {
  if (stage === 'local') return 'skipped: the local stack serves unbuilt source'
  const build = releaseBuild(ROOT)
  const page = await dev.send('/terms', { owner: false })
  if (!page.ok) throw new Error('client_page_unavailable')
  const read = async (path: string): Promise<string> => {
    const asset = await fetch(new URL(path, dev.origin), { signal: AbortSignal.timeout(ASSET_TIMEOUT_MS) })
    return asset.ok ? asset.text() : ''
  }
  if (!(await bundleCarries(await page.text(), build, read))) throw new Error('client_build_mismatch')
  return build
}
