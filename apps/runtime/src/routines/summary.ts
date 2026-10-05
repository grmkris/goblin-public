/** Bounded plain text for passive reports; credentials and terminal controls never belong in a summary. */
export function routineSummary(text: string): string {
  return (
    text
      .replaceAll(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gu, '[redacted]')
      .replaceAll(/\bBearer\s+[^\s"'<>]+/giu, 'Bearer [redacted]')
      .replaceAll(/\b(?:whsec_|sk-)[A-Za-z0-9_+/=.-]+/gu, '[redacted]')
      .replaceAll(/\b(?:token|secret|password|api[_ -]?key|authorization)\s*[=:]\s*["']?[^\s"'<>;,]+/giu, '[redacted]')
      .replaceAll(/https?:\/\/[^\s<>]+/gu, (value) => {
        try {
          const url = new URL(value)
          url.username = ''
          url.password = ''
          url.search = ''
          url.hash = ''
          return url.toString()
        } catch {
          return '[link]'
        }
      })
      // oxlint-disable-next-line no-control-regex -- passive report text must strip terminal and bidi controls.
      .replaceAll(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, '')
      .trim()
      .slice(0, 1600)
  )
}
