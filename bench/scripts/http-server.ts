import { createServer } from 'node:http'

/** Loopback-only transport boundary shared by CLI and Node-hosted tests. Caller owns the returned lifetime. */
export async function serveLocal(port: number, handle: (request: Request) => Promise<Response>) {
  const server = createServer((incoming, outgoing) => {
    void (async () => {
      const chunks: Uint8Array[] = []
      for await (const chunk of incoming) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
      const request = new Request(`http://127.0.0.1:${port}${incoming.url ?? '/'}`, {
        method: incoming.method ?? 'GET',
        headers: Object.fromEntries(
          Object.entries(incoming.headers).flatMap(([key, value]) =>
            value === undefined ? [] : [[key, Array.isArray(value) ? value.join(',') : value]],
          ),
        ),
        ...(chunks.length === 0 ? {} : { body: Buffer.concat(chunks) }),
      })
      const response = await handle(request)
      outgoing.writeHead(response.status, Object.fromEntries(response.headers))
      outgoing.end(Buffer.from(await response.arrayBuffer()))
    })().catch(() => {
      outgoing.writeHead(500)
      outgoing.end('Local transport failed; inspect private run traces.')
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
  return {
    url: `http://127.0.0.1:${port}`,
    stop: () =>
      new Promise<void>((resolve, reject) => {
        if (!server.listening) {
          resolve()
          return
        }
        server.closeAllConnections()
        if (!server.listening) {
          resolve()
          return
        }
        server.close((error) => (error ? reject(error) : resolve()))
      }),
  }
}
