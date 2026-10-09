/** Same head/tail character policy as memory/log.ts; JSON credential-shaped keys are scrubbed first. */
export function boundedExcerpt(text: string, cap = 12000): string {
  if (text.length <= cap) return text
  const half = Math.floor(cap / 2)
  return `${text.slice(0, half)}\n[… ${text.length - cap} characters cut …]\n${text.slice(-half)}`
}

const SECRET_KEY =
  /^(?:(?:access|refresh|id|bearer|api|session)[_-]?token|(?:client[_-]?)?secret|password|authorization|cookie|private[_-]?key|api[_-]?key)$/iu
const scrub = (value: unknown, key = ''): unknown => {
  if (SECRET_KEY.test(key)) return '[redacted]'
  if (Array.isArray(value)) return value.map((item) => scrub(item))
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, scrub(item, name)]))
  return value
}
export function redactedExcerpt(text: string): string {
  let safe = text
  try {
    safe = JSON.stringify(scrub(JSON.parse(text)))
  } catch {
    // expected: plain transcript text remains text
  }
  safe = safe
    .replace(/\b(?:Bearer\s+)[A-Za-z0-9._~+/=-]+/giu, 'Bearer [redacted]')
    .replace(
      /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|password|client[_-]?secret)\s*[:=]\s*[^\s,;]+/giu,
      '$1=[redacted]',
    )
  return boundedExcerpt(safe)
}
