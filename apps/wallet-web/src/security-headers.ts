import { CHAINS } from '@goblin/wallet/chains'

// Privy's recommended policy for its React SDK (docs.privy.io, Content Security Policy): its iframe and API, its RPC
// provider, WalletConnect and Coinbase Wallet, and Cloudflare Turnstile should the app turn its captcha on.
const PRIVY_FRAMES = ['https://auth.privy.io', 'https://verify.walletconnect.com', 'https://verify.walletconnect.org']
const PRIVY_CONNECT = [
  'https://auth.privy.io',
  'https://*.rpc.privy.systems',
  'wss://relay.walletconnect.com',
  'wss://relay.walletconnect.org',
  'wss://www.walletlink.org',
  'https://explorer-api.walletconnect.com',
]
const TURNSTILE = 'https://challenges.cloudflare.com'

/** The bodies of the page's inline scripts (those without `src`), exactly as written: what a CSP hash covers. */
export const inlineScripts = (html: string): string[] =>
  [...html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/gu)].map((match) => match[1] ?? '')

/**
 * The owner console's Content-Security-Policy. Scripts are its own bundle and the inline scripts named by their
 * `sha256-…` hashes; the page connects to itself, Privy and the chains' public RPCs (viem reads nonces in the browser);
 * nothing may frame it.
 */
export const contentSecurityPolicy = (scriptHashes: readonly string[]): string => {
  const rpcs = [...new Set(CHAINS.map((chain) => new URL(chain.rpcUrl).origin))]
  return [
    "default-src 'self'",
    ["script-src 'self'", ...scriptHashes.map((hash) => `'${hash}'`), TURNSTILE].join(' '),
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ['child-src', ...PRIVY_FRAMES].join(' '),
    ['frame-src', ...PRIVY_FRAMES, TURNSTILE].join(' '),
    ["connect-src 'self'", ...PRIVY_CONNECT, ...rpcs].join(' '),
    "worker-src 'self'",
    "manifest-src 'self'",
  ].join('; ')
}

/**
 * The `_headers` file the assets layer applies to every static response: the CSP and `X-Frame-Options: DENY`, the
 * older browsers' form of `frame-ancestors 'none'`.
 */
export const headersFile = (scriptHashes: readonly string[]): string =>
  `/*\n  Content-Security-Policy: ${contentSecurityPolicy(scriptHashes)}\n  X-Frame-Options: DENY\n`
