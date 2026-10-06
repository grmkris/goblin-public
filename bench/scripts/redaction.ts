import { createHash } from 'node:crypto'

const patterns = [
  /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/gu,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu,
  /(?<=Bearer )[A-Za-z0-9._~+/-]{16,}/giu,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/gu,
  /(?<=(?:api_key|apiKey|password|secret|access_token|refresh_token)["']?\s*[:=]\s*["'])[A-Za-z0-9._~+/-]{16,}/giu,
]
const privateIdentifiers = [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/gu, /\/home\/kristjan\b/gu]

/** Tooling exception: the caller supplies environment credentials for literal matching, never for logging. */
export function redactor(credentials: readonly string[], identities: readonly string[] = []) {
  const mapping = new Map<string, string>()
  const replace = (value: string, kind: string) => {
    const pseudonym = `<${kind}:${createHash('sha256').update(value).digest('hex').slice(0, 12)}>`
    mapping.set(value, pseudonym)
    return pseudonym
  }
  const redact = (source: string) => {
    let text = source
    for (const secret of credentials.filter((value) => value.length >= 8).toSorted((a, b) => b.length - a.length))
      if (text.includes(secret)) text = text.replaceAll(secret, replace(secret, 'secret'))
    for (const pattern of patterns) text = text.replace(pattern, (value) => replace(value, 'secret'))
    for (const identity of identities.filter((value) => value.length >= 3).toSorted((a, b) => b.length - a.length))
      if (text.includes(identity)) text = text.replaceAll(identity, replace(identity, 'private'))
    for (const pattern of privateIdentifiers) text = text.replace(pattern, (value) => replace(value, 'private'))
    return text
  }
  return { redact, mapping: () => [...mapping].map(([original, pseudonym]) => ({ original, pseudonym })) }
}
