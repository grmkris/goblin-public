import { FileStore } from '../../src/files/store.ts'
import { callOwner } from '../owner-client.ts'
import { type Probes, type ProbeStub, inAgent, inWorker } from './probe.ts'

const KIB = 1024

const keysOf = async (bucket: R2Bucket, owner: string): Promise<string[]> =>
  (await bucket.list({ prefix: `agents/${owner}/` })).objects.map((object) => object.key)

const tagOf = (cause: unknown): string =>
  typeof cause === 'object' && cause !== null && '_tag' in cause ? String(cause._tag) : 'thrown'

const outcome = (written: Promise<unknown>): Promise<string> => written.then(() => 'written', tagOf)

/** A stream of `size` bytes in 1 KiB chunks. */
function streamOf(size: number): ReadableStream<Uint8Array> {
  let left = size
  return new ReadableStream({
    pull(controller) {
      if (left === 0) return controller.close()
      const chunk = new Uint8Array(Math.min(KIB, left)).fill(7)
      left -= chunk.byteLength
      controller.enqueue(chunk)
    },
  })
}

/**
 * The real Shell Workspace and the stack's R2 bucket, as the agent's tools use them: the agent writes only under
 * `/agent`, text reads page, a declared size over the limit or a body longer than declared stores nothing.
 */
async function filesStoreProbe(sql: SqlStorage, bucket: R2Bucket, owner: string) {
  const store = new FileStore(sql, bucket, () => owner)
  const report = `# Report\n${'line\n'.repeat(40)}`
  const written = await store.write('agent', '/agent/report.md', report, 'text/markdown', report.length)
  const first = await store.text('/agent/report.md', 0, 64)
  const rest = await store.text('/agent/report.md', first.next ?? 0, 4 * KIB)
  const longer = await outcome(store.write('owner', '/uploads/long.bin', streamOf(4 * KIB), 'x/y', 2 * KIB))
  return {
    written: written.path,
    paged: first.text + rest.text === report && first.next === 64 && rest.next === undefined,
    agentUpload: await outcome(store.write('agent', '/uploads/x.txt', 'no', 'text/plain', 2)),
    agentDelete: await outcome(store.remove('agent', '/uploads/x.txt')),
    declaredTooLarge: await outcome(store.write('owner', '/uploads/huge.bin', 'x', 'x/y', 26 * KIB * KIB)),
    longer,
    longerStored: await store.stat('/uploads/long.bin').then(
      () => true,
      () => false,
    ),
    escape: await outcome(store.write('owner', '/uploads/../agent/x.txt', 'x', 'text/plain', 1)),
    keys: await keysOf(bucket, owner),
  }
}

const put = (agent: ProbeStub, path: string, body: Uint8Array, type: string) =>
  agent.fetch(`https://agent/api/files/content?path=${encodeURIComponent(path)}`, {
    method: 'PUT',
    body,
    headers: { 'content-type': type },
  })

/**
 * The owner's files over the agent's HTTP routes: small files stay in SQLite and larger ones spill to R2 under the
 * agent's prefix, downloads never render in place except plain images, deleting removes the R2 object, and erasing
 * the account empties the prefix.
 */
async function filesSequence(agent: ProbeStub, bucket: R2Bucket, owner: string) {
  const big = new Uint8Array(200 * KIB).fill(1)
  const uploads = [
    (await put(agent, '/uploads/notes.txt', new TextEncoder().encode('hello notes'), 'text/plain')).status,
    (await put(agent, '/uploads/big.bin', big, 'application/octet-stream')).status,
    (await put(agent, '/uploads/dot.png', new Uint8Array([137, 80, 78, 71]), 'image/png')).status,
    (await put(agent, '/uploads/../escape.txt', new Uint8Array([1]), 'text/plain')).status,
  ]
  const listing = await callOwner(agent, (api) => api.files.list({ query: { dir: '/uploads' } }))
  const spilled = await keysOf(bucket, owner)
  const bigRead = await agent.fetch(`https://agent/api/files/content?path=${encodeURIComponent('/uploads/big.bin')}`)
  const bigBytes = (await bigRead.arrayBuffer()).byteLength
  const png = await agent.fetch(`https://agent/api/files/content?path=${encodeURIComponent('/uploads/dot.png')}`)
  await png.arrayBuffer()
  const deleted = await agent.fetch(`https://agent/api/files/content?path=${encodeURIComponent('/uploads/big.bin')}`, {
    method: 'DELETE',
  })
  const afterDelete = await keysOf(bucket, owner)
  const gone = await agent.fetch(`https://agent/api/files/content?path=${encodeURIComponent('/uploads/big.bin')}`)
  await gone.arrayBuffer()
  await put(agent, '/uploads/big-again.bin', big, 'application/octet-stream')
  const beforeErase = await keysOf(bucket, owner)
  const erased = await agent.deleteAgentData()
  return {
    uploads,
    names: listing.entries.map((entry) => entry.name).toSorted(),
    usedBytes: listing.usedBytes,
    spilled,
    big: {
      bytes: bigBytes,
      type: bigRead.headers.get('content-type'),
      disposition: bigRead.headers.get('content-disposition'),
      csp: bigRead.headers.get('content-security-policy'),
    },
    png: { type: png.headers.get('content-type'), disposition: png.headers.get('content-disposition') },
    deleted: deleted.status,
    afterDelete,
    gone: gone.status,
    beforeErase,
    erased,
    afterErase: await keysOf(bucket, owner),
  }
}

export const probes: Probes = {
  'files-store': inAgent(({ storage, env, name }) => filesStoreProbe(storage.sql, env.FILES, name)),
  'files-sequence': inWorker(({ agent, env, name }) => filesSequence(agent, env.FILES, name)),
}
