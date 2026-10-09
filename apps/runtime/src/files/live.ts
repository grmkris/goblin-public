import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { toAppError } from '../http/errors.ts'
import { AgentInput } from '../runtime/input.ts'
import { Files } from './service.ts'
import type { FileCaller } from './store.ts'

const step = <A>(work: () => Promise<A>) => Effect.tryPromise({ try: work, catch: toAppError })

/**
 * `Files` over the owner's file store the apps engine holds (the one `code_run` uses), so the owner's routes, the
 * agent's file tools and its scripts share one store.
 */
export const FilesLive = Layer.effect(
  Files,
  AgentInput.useSync(({ agentApps: { ownerFiles: store } }) =>
    Files.of({
      list: Effect.fn('Files.list')(function* (dir: string) {
        return yield* step(() => store.list(dir))
      }),
      stat: Effect.fn('Files.stat')(function* (path: string) {
        return yield* step(() => store.stat(path))
      }),
      read: Effect.fn('Files.read')(function* (path: string) {
        return yield* step(() => store.read(path))
      }),
      text: Effect.fn('Files.text')(function* (path: string, offset: number, maxBytes: number) {
        return yield* step(() => store.text(path, offset, maxBytes))
      }),
      write: Effect.fn('Files.write')(function* (
        caller: FileCaller,
        path: string,
        body: string | Uint8Array | ReadableStream<Uint8Array>,
        mimeType: string,
        size: number,
      ) {
        return yield* step(() => store.write(caller, path, body, mimeType, size))
      }),
      remove: Effect.fn('Files.remove')(function* (caller: FileCaller, path: string) {
        return yield* step(() => store.remove(caller, path))
      }),
    }),
  ),
)
