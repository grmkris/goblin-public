// Servers we suggest, on a shelf in groups (ADR 0052): OAuth discovery is checked from a Worker, or the endpoint needs
// no sign-in. Credential-backed acceptance is separate. Descriptions are ours, not the servers'. The shelf only adds
// them; grants still start empty. A server that needs no sign-in is on it only for what Mercator does not already sell
// as a paid job (web search and scraping are Mercator's).
import type { ServerGroup, ServerSuggestion } from '@goblin/contracts'

export type Stage = 'local' | 'dev' | 'prod' | 'test'

type Suggested = {
  readonly id: string
  readonly title: string
  readonly description: string
  /** The endpoint per stage; one string for every stage. */
  readonly endpoint: string | Readonly<Record<Stage, string>>
  readonly group: ServerGroup
  readonly signIn: boolean
}

/**
 * Reviewed 2026-10-12: stage endpoints follow their service decisions; every server that needs no sign-in answered an
 * `initialize` without credentials that day. Live acceptance is recorded separately.
 */
const SUGGESTED: readonly Suggested[] = [
  {
    // One OAuth for all of the owner's my* apps; `codemode=off` keeps every app's tools listed by name
    // (`<service>_<tool>`), under the same OAuth resource as plain /mcp.
    id: 'mysi',
    title: 'mysi',
    description: 'Your my* apps in one connection: notes, browsers, Telegram, email, skills and terminals.',
    endpoint: {
      local: 'https://dev.mysi.lol/mcp?codemode=off',
      dev: 'https://dev.mysi.lol/mcp?codemode=off',
      test: 'https://mysi.lol/mcp?codemode=off',
      prod: 'https://mysi.lol/mcp?codemode=off',
    },
    group: 'yours',
    signIn: true,
  },
  {
    // Goblin's own wallet service (OAuth); its first-class profile is in first-class.ts.
    id: 'wallet',
    title: 'Goblin Wallet',
    description: 'Balances, limits you set and receipts, and a wallet your agent pays for search and services from.',
    endpoint: {
      local: 'https://wallet-dev.goblin.surf/mcp',
      dev: 'https://wallet-dev.goblin.surf/mcp',
      test: 'https://wallet-dev.goblin.surf/mcp',
      prod: 'https://wallet.goblin.surf/mcp',
    },
    group: 'goblin',
    signIn: true,
  },
  {
    // OAuth with dynamic registration, checked 2026-10-12; goblin's profile adds the Workers scopes (first-class.ts).
    id: 'cloudflare',
    title: 'Cloudflare',
    description: 'Publish a page or a small app as a Worker on your Cloudflare account. Every change asks you first.',
    endpoint: 'https://mcp.cloudflare.com/mcp',
    group: 'goblin',
    signIn: true,
  },
  {
    id: 'kiwi',
    title: 'Kiwi.com',
    description: 'Flight search across airlines, with prices and a booking link for each option.',
    endpoint: 'https://mcp.kiwi.com',
    group: 'travel',
    signIn: false,
  },
  {
    // Its replies carry a `system_message` meant for the model: like every remote result, it is data, never instructions.
    id: 'trivago',
    title: 'trivago',
    description: 'Hotels and their prices across booking sites, in a view you can browse.',
    endpoint: 'https://mcp.trivago.com/mcp',
    group: 'travel',
    signIn: false,
  },
  {
    id: 'ferryhopper',
    title: 'Ferryhopper',
    description: 'Ferry routes, times and prices, mostly around Europe, in a view you can browse.',
    endpoint: 'https://mcp.ferryhopper.com/mcp',
    group: 'travel',
    signIn: false,
  },
  {
    id: 'wikidata',
    title: 'Wikidata',
    description: 'Facts about people, places and works, and how they connect, from Wikidata.',
    endpoint: 'https://wd-mcp.wmcloud.org/mcp',
    group: 'knowledge',
    signIn: false,
  },
  {
    id: 'microsoft-learn',
    title: 'Microsoft Learn',
    description: "Microsoft's documentation and code samples: Azure, .NET, Microsoft 365 and the rest.",
    endpoint: 'https://learn.microsoft.com/api/mcp',
    group: 'knowledge',
    signIn: false,
  },
  {
    id: 'aws-knowledge',
    title: 'AWS Knowledge',
    description: 'AWS documentation and guidance, and which services each region offers.',
    endpoint: 'https://knowledge-mcp.global.api.aws',
    group: 'knowledge',
    signIn: false,
  },
  {
    id: 'huggingface',
    title: 'Hugging Face',
    description: 'Search models, datasets and Spaces on Hugging Face, and read their files.',
    endpoint: 'https://huggingface.co/mcp',
    group: 'knowledge',
    signIn: false,
  },
  {
    id: 'coingecko',
    title: 'CoinGecko',
    description: "Crypto prices, market caps and coin details from CoinGecko's public data.",
    endpoint: 'https://mcp.api.coingecko.com/mcp',
    group: 'crypto',
    signIn: false,
  },
  {
    id: 'etherscan',
    title: 'Etherscan',
    description: 'Balances, transactions and contracts on Ethereum and other EVM chains, on its keyless tier.',
    endpoint: 'https://mcp-keyless.etherscan.io/mcp',
    group: 'crypto',
    signIn: false,
  },
  {
    id: 'excalidraw',
    title: 'Excalidraw',
    description: 'Hand-drawn diagrams your agent sketches, live in the chat.',
    endpoint: 'https://mcp.excalidraw.com/mcp',
    group: 'apps',
    signIn: false,
  },
  {
    id: 'subwayinfo',
    title: 'SubwayInfo.nyc',
    description: 'New York transit: live subway, bus, ferry and rail arrivals, alerts and trip plans.',
    endpoint: 'https://subwayinfo.nyc/mcp',
    group: 'apps',
    signIn: false,
  },
  {
    id: 'deepwiki',
    title: 'DeepWiki',
    description: 'Questions about any public GitHub repository, answered from its generated wiki.',
    endpoint: 'https://mcp.deepwiki.com/mcp',
    group: 'code',
    signIn: false,
  },
  {
    id: 'context7',
    title: 'Context7',
    description: 'Current documentation and code examples for programming libraries.',
    endpoint: 'https://mcp.context7.com/mcp',
    group: 'code',
    signIn: false,
  },
  {
    id: 'cloudflare-docs',
    title: 'Cloudflare Docs',
    description: "Search Cloudflare's developer documentation.",
    endpoint: 'https://docs.mcp.cloudflare.com/mcp',
    group: 'code',
    signIn: false,
  },
  {
    id: 'svelte',
    title: 'Svelte',
    description: 'Svelte and SvelteKit documentation, and a checker that fixes Svelte code.',
    endpoint: 'https://mcp.svelte.dev/mcp',
    group: 'code',
    signIn: false,
  },
]

/**
 * An endpoint as the shelf compares it: its origin and path, without a query or a trailing slash. A connection made
 * before a suggestion gained a query (mysi's `?codemode=off`) reaches the same server, so it counts as added.
 */
const served = (endpoint: string): string => {
  try {
    const url = new URL(endpoint)
    return `${url.origin}${url.pathname.replace(/\/+$/u, '')}`
  } catch {
    // expected: an endpoint the URL parser refuses is compared as it was stored
    return endpoint
  }
}

/** The shelf for `stage`, each entry marked added when one of `endpoints` already serves it. */
export function suggestions(stage: Stage | undefined, endpoints: ReadonlySet<string>): readonly ServerSuggestion[] {
  const offered = new Set([...endpoints].map(served))
  return SUGGESTED.map(({ endpoint, ...rest }) => {
    const url = typeof endpoint === 'string' ? endpoint : endpoint[stage ?? 'test']
    return { ...rest, endpoint: url, added: offered.has(served(url)) }
  })
}

/**
 * goblin's title for the server a suggestion reaches at `endpoint`, on any stage: the name a connection added from the
 * shelf starts from, where the server's own card or host would read as an address ("mcp.kiwi.com").
 */
export function suggestedTitle(endpoint: string): string | undefined {
  const wanted = served(endpoint)
  return SUGGESTED.find((item) =>
    (typeof item.endpoint === 'string' ? [item.endpoint] : Object.values(item.endpoint)).some(
      (url) => served(url) === wanted,
    ),
  )?.title
}
