import { isString, record, records } from './values.ts'

/** A file an App offers the owner to save: its name, type and bytes (ADR 0021). */
export type DownloadFile = { readonly name: string; readonly type: string; readonly bytes: Uint8Array }

/** The largest file an App may offer. */
const MAX_BYTES = 5 * 1024 * 1024
const SAFE_NAME = /[^\w.() -]+/gu

/** The file's name from its URI's last segment, kept to safe characters. */
function nameOf(uri: string): string {
  const last = uri.split(/[/\\]/u).at(-1) ?? ''
  const name = decodeURIComponent(last).replaceAll(SAFE_NAME, '_').replace(/^\.+/u, '').slice(0, 100)
  return name === '' ? 'download' : name
}

function bytesOf(resource: Record<string, unknown>): Uint8Array | undefined {
  if (isString(resource.text)) return new TextEncoder().encode(resource.text)
  if (!isString(resource.blob)) return undefined
  try {
    return Uint8Array.from(atob(resource.blob), (char) => char.charCodeAt(0))
  } catch {
    // expected: an App's blob that is not base64 is no file to offer
    return undefined
  }
}

/**
 * The file an App's `ui/download-file` request carries: its first embedded resource with text or base64 bytes, at most
 * 5 MiB. Linked resources are not fetched: the host offers only what the App itself holds.
 */
export function downloadOf(contents: unknown): DownloadFile | undefined {
  for (const content of records(contents)) {
    const resource = record(content.resource)
    if (content.type !== 'resource' || resource === undefined || !isString(resource.uri)) continue
    const bytes = bytesOf(resource)
    if (bytes === undefined || bytes.byteLength > MAX_BYTES) return undefined
    const type =
      isString(resource.mimeType) && /^[\w.+-]+\/[\w.+-]+$/u.test(resource.mimeType)
        ? resource.mimeType
        : 'application/octet-stream'
    return { name: nameOf(resource.uri), type, bytes }
  }
  return undefined
}
