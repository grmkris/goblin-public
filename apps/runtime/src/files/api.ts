import { FILE_LIMITS } from '@goblin/contracts'
import { OwnerApi } from '@goblin/contracts/api'
import * as Effect from 'effect/Effect'
import type * as HttpServerRequest from 'effect/http/HttpServerRequest'
import * as HttpServerResponse from 'effect/http/HttpServerResponse'
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder'
import { InvalidInput, PayloadTooLarge } from '../http/errors.ts'
import { Files } from './service.ts'

/** Images the browser may show in place; anything else downloads, so an uploaded page never runs on the app's origin. */
const INLINE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

/** A download of a stored file: its bytes as stored, an attachment unless it is a plain image. */
function download(name: string, mimeType: string, body: ReadableStream<Uint8Array>): Response {
  const inline = INLINE.has(mimeType)
  return new Response(body, {
    headers: {
      'content-type': inline ? mimeType : 'application/octet-stream',
      'content-disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(name)}`,
      'content-security-policy': "default-src 'none'; sandbox",
      'x-content-type-options': 'nosniff',
      'cache-control': 'private, no-store',
    },
  })
}

/**
 * The request's body written to `path` as it arrives: the request must say how long it is (`content-length`), and be
 * within the per-file limit. The store refuses a body longer than it said.
 */
const upload = (request: HttpServerRequest.HttpServerRequest, path: string) =>
  Effect.gen(function* () {
    const declared = request.headers['content-length']
    const size = declared === undefined ? Number.NaN : Number(declared)
    const body = request.source instanceof Request ? request.source.body : null
    if (!Number.isSafeInteger(size) || body === null) return yield* new InvalidInput({ reason: 'file size' })
    if (size > FILE_LIMITS.fileBytes) return yield* new PayloadTooLarge({ limit: FILE_LIMITS.fileBytes })
    const mimeType = (request.headers['content-type'] ?? 'application/octet-stream').slice(0, 128)
    return yield* Files.use((files) => files.write('owner', path, body, mimeType, size))
  })

/**
 * The `files` group (ADR 0022). The owner gate has already admitted the request. The bytes go through unbuffered both
 * ways: an upload streams into the store, a download streams out of it.
 */
export const FilesHandlers = HttpApiBuilder.group(OwnerApi, 'files', (handlers) =>
  handlers
    .handle('list', ({ query }) => Files.use((files) => files.list(query.dir ?? '/uploads')))
    .handleRaw('read', ({ query }) =>
      Effect.map(
        Files.use((files) => files.read(query.path)),
        ({ entry, body }) => HttpServerResponse.raw(download(entry.name, entry.mimeType, body)),
      ),
    )
    .handleRaw('write', ({ request, query }) => upload(request, query.path))
    .handle('remove', ({ query }) =>
      Effect.as(
        Files.use((files) => files.remove('owner', query.path)),
        { deleted: true as const },
      ),
    ),
)
