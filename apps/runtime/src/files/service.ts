import type { FileEntry, FileListing } from '@goblin/contracts'
import * as Context from 'effect/Context'
import type * as Effect from 'effect/Effect'
import type { AppError } from '../http/errors.ts'
import type { FileCaller } from './store.ts'

/** A part of a text file, and where the next part starts when there is more. */
export type FileText = { readonly entry: FileEntry; readonly text: string; readonly next?: number }

/**
 * The owner's files (ADR 0022): `/uploads` holds what the owner uploaded or attached, `/agent` what the agent wrote.
 * The owner reads and writes everything, the agent reads uploads and writes only under `/agent`; quotas are checked
 * before every write.
 */
export class Files extends Context.Service<
  Files,
  {
    /** A directory's entries, newest first, and the storage in use. */
    readonly list: (dir: string) => Effect.Effect<FileListing, AppError>
    /** A file's entry; `NotFound` for a directory or nothing. */
    readonly stat: (path: string) => Effect.Effect<FileEntry, AppError>
    /** A file's bytes as a stream, with its entry. */
    readonly read: (
      path: string,
    ) => Effect.Effect<{ readonly entry: FileEntry; readonly body: ReadableStream<Uint8Array> }, AppError>
    /** At most `maxBytes` of a file's text from byte `offset`. */
    readonly text: (path: string, offset: number, maxBytes: number) => Effect.Effect<FileText, AppError>
    /** Writes `body` (`size` bytes, as declared) to `path` as `caller`, once the quotas allow it. */
    readonly write: (
      caller: FileCaller,
      path: string,
      body: string | Uint8Array | ReadableStream<Uint8Array>,
      mimeType: string,
      size: number,
    ) => Effect.Effect<FileEntry, AppError>
    /** Deletes the file at `path` as `caller`. */
    readonly remove: (caller: FileCaller, path: string) => Effect.Effect<void, AppError>
  }
>()('goblin/files/Files') {}
