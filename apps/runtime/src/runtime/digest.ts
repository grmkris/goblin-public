/** `bytes` as lowercase hex, two digits a byte. */
export const hex = (bytes: ArrayBuffer | Uint8Array): string =>
  Array.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')

/** The SHA-256 of `input` (a string as its UTF-8 bytes) as 64 lowercase hex digits. */
export const sha256Hex = async (input: string | Uint8Array<ArrayBuffer>): Promise<string> =>
  hex(await crypto.subtle.digest('SHA-256', typeof input === 'string' ? new TextEncoder().encode(input) : input))

/** Whether `value` is an object of named fields: not null and not an array. */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
