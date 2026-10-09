// The owner's files as the browser reaches them (ADR 0022): uploads for a message go to `/uploads/<day>/`, under a
// name the runtime's path rule accepts and that replaces nothing already there.
import { type Attachment, FILE_LIMITS, FileEntry, FileListing } from '@goblin/contracts'
import * as Schema from 'effect/Schema'
import { ApiFailure, isString, record, request } from './boundary.ts'

const NAME_LIMIT = 80

/** A file name the path rule accepts: unknown characters become `-`, and a long name keeps its extension. */
export function uploadName(name: string): string {
  const cleaned = name
    .normalize('NFC')
    .replaceAll(/\s+/gu, ' ')
    .replaceAll(/[^\p{L}\p{N}_ .()-]/gu, '-')
    .trim()
  if (/^\.*$/u.test(cleaned)) return 'file'
  if (cleaned.length <= NAME_LIMIT) return cleaned
  const dot = cleaned.lastIndexOf('.')
  const extension = dot > 0 && cleaned.length - dot <= 12 ? cleaned.slice(dot) : ''
  return `${cleaned.slice(0, NAME_LIMIT - extension.length).trimEnd()}${extension}`
}

/** `name`, or `name (2)`, `name (3)`… with its extension kept, whichever is not taken yet. */
export function freeName(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name)) return name
  const dot = name.lastIndexOf('.')
  const [stem, extension] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, '']
  for (let n = 2; ; n += 1) {
    const suffix = ` (${n})${extension}`
    const candidate = `${stem.slice(0, NAME_LIMIT - suffix.length).trimEnd()}${suffix}`
    if (!taken.has(candidate)) return candidate
  }
}

const pad = (value: number) => String(value).padStart(2, '0')

/** The day's upload folder, by the owner's local date. */
export function uploadFolder(now: Date): string {
  return `/uploads/${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/** Where a stored file downloads from (only plain images open in place). */
export const fileUrl = (path: string): string => `/api/files/content?path=${encodeURIComponent(path)}`

/** A size for people: bytes, KB or MB. */
export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`
}

const decodeListing = Schema.decodeUnknownSync(FileListing)
const decodeEntry = Schema.decodeUnknownSync(FileEntry)

/**
 * Uploads `file` into today's folder under a name nobody holds there (`taken` adds the names this batch already
 * chose), and returns it as an attachment for the next message.
 */
export async function uploadAttachment(file: File, taken: Set<string>, now = new Date()): Promise<Attachment> {
  if (file.size > FILE_LIMITS.fileBytes) throw new ApiFailure('PayloadTooLarge', 413, 'over 25 MB')
  const folder = uploadFolder(now)
  const listing = decodeListing(await request(`/api/files?dir=${encodeURIComponent(folder)}`))
  const held = new Set([...taken, ...listing.entries.map((entry) => entry.name)])
  const name = freeName(uploadName(file.name), held)
  taken.add(name)
  const response = await fetch(fileUrl(`${folder}/${name}`), {
    method: 'PUT',
    credentials: 'same-origin',
    headers: { 'x-goblin-csrf': '1', 'content-type': file.type === '' ? 'application/octet-stream' : file.type },
    body: file,
  })
  // expected: a body that is not JSON leaves the status to say what happened
  const data: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const failure = record(data)
    throw new ApiFailure(
      isString(failure?.error) ? failure.error : `HTTP ${response.status}`,
      response.status,
      isString(failure?.reason) ? failure.reason : undefined,
    )
  }
  const entry = decodeEntry(data)
  return { path: entry.path, name: entry.name, size: entry.size, mimeType: entry.mimeType }
}
