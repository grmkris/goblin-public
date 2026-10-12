// `/setup?return=<url>`: where a client that sent the owner here wants them back. The page asks the Worker whether the
// URL is on one of the owner's own clients (`GET /api/return-check`) and ignores it otherwise; these checks only spare
// the Worker a question it would refuse anyway.
import type { ReturnTarget } from '../../api/types.ts'

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])

/** The `return` worth asking about: an absolute HTTPS URL, or HTTP on localhost for development, without credentials. */
export function returnParam(search: URLSearchParams): string | undefined {
  const value = search.get('return') ?? ''
  if (value === '' || value.length > 2048 || !URL.canParse(value)) return undefined
  const url = new URL(value)
  const secure = url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK.has(url.hostname))
  return secure && url.username === '' && url.password === '' ? url.href : undefined
}

/** Where Done sends the owner: the client the Worker vouched for, or the wallet itself. */
export function doneTarget(checked: ReturnTarget | undefined): { readonly href: string; readonly label: string } {
  if (checked?.url !== undefined && checked.host !== undefined)
    return { href: checked.url, label: `Back to ${checked.host}` }
  return { href: '/', label: 'Go to your wallet' }
}
