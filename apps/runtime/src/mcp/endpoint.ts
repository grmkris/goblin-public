// What the owner may add as an MCP server, and what the server may say about itself. An added endpoint is a public
// https URL; a server card (`/.well-known/mcp/server-card.json`) is the publisher's claim, bounded and decoded, used
// only to label the server for the owner. It never reaches the model and never grants anything. Its fetch follows
// no redirect (`manual`; workerd has no `error` mode): a 3xx is not `ok`, so it reads as no card.
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import { InvalidInput } from '../http/errors.ts'

/** Hosts an added server may not use: names that only mean something on a private network. */
const PRIVATE_SUFFIXES = ['.local', '.internal', '.localhost', '.lan', '.home.arpa'] as const

const ipLiteral = (host: string): boolean => /^\d{1,3}(?:\.\d{1,3}){3}$/u.test(host) || host.startsWith('[')

/** The endpoint as a URL, or InvalidInput naming what is wrong with it. */
export function userEndpoint(raw: string): URL {
  if (raw.length > 2048) throw new InvalidInput({ reason: 'endpoint_too_long' })
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    throw new InvalidInput({ reason: 'endpoint_not_a_url' })
  }
  if (url.protocol !== 'https:') throw new InvalidInput({ reason: 'endpoint_not_https' })
  if (url.username !== '' || url.password !== '' || url.hash !== '')
    throw new InvalidInput({ reason: 'endpoint_invalid' })
  const host = url.hostname.toLowerCase()
  const local =
    ipLiteral(host) ||
    host === 'localhost' ||
    !host.includes('.') ||
    PRIVATE_SUFFIXES.some((suffix) => host.endsWith(suffix))
  if (local) throw new InvalidInput({ reason: 'endpoint_not_public' })
  return url
}

/** A server id for an added endpoint: its host as a slug plus a random suffix, never one the deployment configures. */
export function addedConnectionId(endpoint: URL, taken: ReadonlySet<string>, random: () => string): string {
  const slug = endpoint.hostname
    .toLowerCase()
    .replace(/^www\./u, '')
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-|-$/gu, '')
    .slice(0, 48)
  for (;;) {
    const id = `${slug || 'server'}-${random().slice(0, 6)}`
    if (!taken.has(id)) return id
  }
}

const Bounded = (max: number) => Schema.String.check(Schema.isMaxLength(max))

const ServerCard = Schema.Struct({
  name: Schema.optional(Bounded(200)),
  title: Schema.optional(Bounded(200)),
  description: Schema.optional(Bounded(2000)),
  icons: Schema.optional(Schema.Array(Schema.Struct({ src: Bounded(2048) }))),
})
const decodeCard = Schema.decodeUnknownOption(ServerCard)

/** How a server describes itself, as shown to the owner: always labelled as the server's own claim. */
export type ServerClaims = { readonly title?: string; readonly description?: string; readonly icon?: string }

const MAX_CARD_BYTES = 64 * 1024

/** The https icon a card names, if any. */
function cardIcon(icons: readonly { readonly src: string }[] | undefined): string | undefined {
  const src = icons?.find((icon) => icon.src.startsWith('https://'))?.src
  return src === undefined ? undefined : new URL(src).href
}

/** Read the server card next to `endpoint`; nothing when it is absent, slow, too large or not a card. */
export async function serverClaims(endpoint: URL, fetcher: typeof fetch): Promise<ServerClaims> {
  try {
    const response = await fetcher(new URL('/.well-known/mcp/server-card.json', endpoint.origin), {
      redirect: 'manual',
      signal: AbortSignal.timeout(5000),
    })
    if (!response.ok) return {}
    const body = await response.text()
    if (body.length > MAX_CARD_BYTES) return {}
    const card = Option.getOrUndefined(decodeCard(JSON.parse(body)))
    if (card === undefined) return {}
    const { title, name, description, icons } = card
    const label = (title ?? name)?.trim()
    const icon = cardIcon(icons)
    return {
      ...(label ? { title: label.slice(0, 120) } : {}),
      ...(description?.trim() ? { description: description.trim().slice(0, 500) } : {}),
      ...(icon === undefined ? {} : { icon }),
    }
  } catch {
    // expected: a missing, slow, oversized or malformed card only leaves the server unlabelled.
    return {}
  }
}
