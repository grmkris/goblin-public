import * as Schema from 'effect/Schema'
import { NonEmptyString } from './ids.ts'

const MIB = 1024 * 1024

/** The owner's storage limits (ADR 0022): per file, in total, and how many files. */
export const FILE_LIMITS = { fileBytes: 25 * MIB, totalBytes: 512 * MIB, files: 2000 } as const

/**
 * A path in the owner's files (ADR 0022): under `/uploads` (what the owner uploaded) or `/agent` (what the agent wrote),
 * at most eight plain segments of letters, digits, spaces and `_ . ( ) -`, none of them only dots.
 */
export const FILE_PATH = /^\/(?:uploads|agent)(?:\/(?!\.+(?:\/|$))[\p{L}\p{N}_ .()-]{1,80}){1,8}$/u

export const FilePath = Schema.String.check(Schema.isMaxLength(512), Schema.isPattern(FILE_PATH))
export type FilePath = typeof FilePath.Type

/** The directory a listing starts from: a file path, or one of the two areas itself. */
export const FileDirectory = Schema.Union([Schema.Literals(['/uploads', '/agent']), FilePath])

export const FileEntry = Schema.Struct({
  path: Schema.String,
  name: Schema.String,
  kind: Schema.Literals(['file', 'directory']),
  size: Schema.Number,
  mimeType: Schema.String,
  updatedAt: Schema.Number,
})
export type FileEntry = typeof FileEntry.Type

/** A directory's entries, and how much of the owner's storage is in use. */
export const FileListing = Schema.Struct({
  entries: Schema.Array(FileEntry),
  usedBytes: Schema.Number,
  limitBytes: Schema.Number,
})
export type FileListing = typeof FileListing.Type

/** A file the owner attached to a message: shown on the message, read by the agent with `files_read`. */
export const Attachment = Schema.Struct({
  path: FilePath,
  name: NonEmptyString(80),
  size: Schema.Number,
  mimeType: Schema.String.check(Schema.isMaxLength(128)),
})
export type Attachment = typeof Attachment.Type
