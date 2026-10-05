/** Comment frames keep idle streams open through proxies that close silent connections. */
const HEARTBEAT_MS = 25_000

/** Sends one `event:` frame with its JSON `data`. */
export type SseSend = (event: string, data: unknown) => void

/**
 * A Server-Sent Events response. `open` starts the source: it sends frames, calls `finish` (with an error to fail the
 * stream) when the source ends, and returns what stops the source when the client goes away.
 */
export function sseResponse(open: (send: SseSend, finish: (error?: Error) => void) => () => unknown): Response {
  const encoder = new TextEncoder()
  let connected = true
  let heartbeat: ReturnType<typeof setInterval> | undefined
  let stop: (() => unknown) | undefined
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      heartbeat = setInterval(() => {
        if (connected) controller.enqueue(encoder.encode(': ping\n\n'))
      }, HEARTBEAT_MS)
      const send: SseSend = (event, data) => {
        if (connected) controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
      }
      const finish = (error?: Error) => {
        clearInterval(heartbeat)
        if (!connected) return
        connected = false
        if (error === undefined) controller.close()
        else controller.error(error)
      }
      stop = open(send, finish)
    },
    async cancel() {
      connected = false
      clearInterval(heartbeat)
      await stop?.()
    },
  })
  return new Response(body, { headers: { 'cache-control': 'no-cache', 'content-type': 'text/event-stream' } })
}
