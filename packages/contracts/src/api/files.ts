import * as Schema from 'effect/Schema'
import * as HttpApiEndpoint from 'effect/http-api/HttpApiEndpoint'
import * as HttpApiGroup from 'effect/http-api/HttpApiGroup'
import * as HttpApiSchema from 'effect/http-api/HttpApiSchema'
import { FileEntry, FileListing } from '../files.ts'
import { ApiErrors } from './errors.ts'
import { RenewsResident } from './resident.ts'
import { Bytes } from './stream.ts'

/** `?path=`: the file, as the owner's files name it (`FILE_PATH`); the agent refuses any other. */
const PathQuery = { path: Schema.String }

/**
 * The owner's files (ADR 0022): `/uploads` holds what the owner uploaded or attached, `/agent` what the agent wrote.
 * Paths are relative to the API's `/api` prefix; none of them renews resident authority.
 *
 * - `list`: `GET /api/files?dir=` (default `/uploads`), a directory's entries, newest first, and the storage in use.
 * - `read`: `GET /api/files/content?path=`, the file's bytes as stored. Only a plain image opens in place; anything
 *   else downloads, so an uploaded page never runs on the app's origin.
 * - `write`: `PUT /api/files/content?path=`, 201 with the file's entry: the request's body, streamed into the store
 *   as it arrives (no payload schema, so it is never buffered). It must say how long it is (`content-length`).
 * - `remove`: `DELETE /api/files/content?path=`.
 */
export class FilesGroup extends HttpApiGroup.make('files')
  .add(
    HttpApiEndpoint.get('list', '/files', {
      query: { dir: Schema.optional(Schema.String) },
      success: FileListing,
      error: [ApiErrors.invalidInput],
    }),
    HttpApiEndpoint.get('read', '/files/content', {
      query: PathQuery,
      success: Bytes,
      error: [ApiErrors.notFound, ApiErrors.invalidInput],
    }),
    HttpApiEndpoint.put('write', '/files/content', {
      query: PathQuery,
      success: FileEntry.pipe(HttpApiSchema.status(201)),
      error: [ApiErrors.invalidInput, ApiErrors.forbidden, ApiErrors.payloadTooLarge],
    }),
    HttpApiEndpoint.delete('remove', '/files/content', {
      query: PathQuery,
      success: Schema.Struct({ deleted: Schema.Literal(true) }),
      error: [ApiErrors.notFound, ApiErrors.invalidInput, ApiErrors.forbidden],
    }),
  )
  .annotateEndpoints(RenewsResident, false) {}
