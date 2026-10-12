// An App's HTML arrives as a resource's `text`, or as a base64 `blob` (MCP Apps, SEP-1865). Both are read the same
// way: the bytes bounded, then decoded as UTF-8 that must be valid, so a bundle is never silently mangled.

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/u

/** Why a resource's HTML cannot be used: bytes over the bound, or a blob that is not base64 of valid UTF-8. */
export type AppHtmlFailure = 'too-large' | 'malformed'

/** The base64 text length that decodes to at most `bytes`, plus the JSON framing a result carries around it. */
export const blobBound = (bytes: number): number => Math.ceil(bytes / 3) * 4 + 4096

/** The HTML in `content` (its `text`, or its `blob` decoded), or why it cannot be read. `max` bounds decoded bytes. */
export function appHtmlOf(
  content: { readonly text?: unknown; readonly blob?: unknown },
  max: number,
): { readonly html: string } | { readonly failure: AppHtmlFailure } {
  if (typeof content.text === 'string') {
    return new TextEncoder().encode(content.text).byteLength > max ? { failure: 'too-large' } : { html: content.text }
  }
  const blob = content.blob
  if (typeof blob !== 'string' || blob.length % 4 !== 0 || !BASE64.test(blob)) return { failure: 'malformed' }
  const padding = blob.endsWith('==') ? 2 : blob.endsWith('=') ? 1 : 0
  if ((blob.length / 4) * 3 - padding > max) return { failure: 'too-large' }
  try {
    const bytes = Uint8Array.from(atob(blob), (char) => char.codePointAt(0) ?? 0)
    return { html: new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes) }
  } catch {
    // expected: atob throws on bad base64 and the fatal decoder on invalid UTF-8; both are a malformed blob.
    return { failure: 'malformed' }
  }
}
