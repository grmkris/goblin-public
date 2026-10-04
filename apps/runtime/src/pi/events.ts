import type { AgentEvent, AgentEventStream, SnapshotEvent } from '@earendil-works/pi-durable'

/** Comment frames keep idle streams open through proxies that close silent connections. */
const HEARTBEAT_MS = 25_000

/**
 * Pi-native SSE: `event: snapshot` with Pi's authoritative snapshot, then `event: batch` with committed event
 * batches. A transport projection only; a reconnecting client starts again from a fresh snapshot.
 */
export function piEventResponse(events: AgentEventStream): Response {
  const encoder = new TextEncoder()
  let connected = true
  let heartbeat: ReturnType<typeof setInterval> | undefined
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      heartbeat = setInterval(() => {
        if (connected) controller.enqueue(encoder.encode(': ping\n\n'))
      }, HEARTBEAT_MS)
      const send = (event: string, value: SnapshotEvent | readonly AgentEvent[]) => {
        if (connected) controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`))
      }
      send('snapshot', events.snapshot)
      events.start(async (batch) => {
        send('batch', batch)
        await Promise.resolve()
      })
      void events.closed
        .then(() => {
          clearInterval(heartbeat)
          if (connected) controller.close()
        })
        .catch((error: Error) => {
          clearInterval(heartbeat)
          if (connected) controller.error(error)
        })
    },
    async cancel() {
      connected = false
      clearInterval(heartbeat)
      await events.stop()
    },
  })
  return new Response(body, {
    headers: { 'cache-control': 'no-cache', 'content-type': 'text/event-stream' },
  })
}
