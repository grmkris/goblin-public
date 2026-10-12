import { Config } from '@goblin/wallet/contract'
import { PrivyProvider } from '@privy-io/react-auth'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import { type ReactNode, useEffect, useState } from 'react'
import { ARBITRUM, BASE, type Chain, ETHEREUM } from '@goblin/wallet/chains'

const decodeConfig = Schema.decodeUnknownOption(Config)

type Loaded =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly appId: string }
  | { readonly status: 'failed' }

/** `GET /api/config`: the public Privy app id. It is never a build variable. */
const loadConfig = async (): Promise<Loaded> => {
  const response = await fetch('/api/config', { headers: { accept: 'application/json' } })
  const config = response.ok ? Option.getOrUndefined(decodeConfig(await response.json())) : undefined
  return config === undefined ? { status: 'failed' } : { status: 'ready', appId: config.privyAppId }
}

/** A chain in Privy's shape (its type is stricter than viem's about optional fields). */
const privyChain = (chain: Chain) => ({
  id: chain.id,
  name: chain.name,
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [chain.rpcUrl] } },
  blockExplorers: { default: { name: chain.name, url: chain.explorerUrl } },
})

const prefersDark = (): boolean => window.matchMedia('(prefers-color-scheme: dark)').matches

/**
 * Privy for the whole app: whatever sign-in methods the Privy dashboard enables (email codes, Google), and an EVM
 * embedded wallet created at the first sign-in, which becomes the owner wallet. The children wait for the app id; a
 * failed config load says so instead of showing a sign-in that cannot work.
 */
export function PrivyRoot({ children }: { readonly children: ReactNode }): ReactNode {
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' })
  useEffect(() => {
    let current = true
    const settle = (next: Loaded) => {
      if (current) setLoaded(next)
    }
    // expected: a network failure shows the reload message below; there is nothing more to report in the browser.
    loadConfig().then(settle, () => settle({ status: 'failed' }))
    return () => {
      current = false
    }
  }, [])
  if (loaded.status === 'loading') return null
  if (loaded.status === 'failed')
    return (
      <main className="flex min-h-dvh items-center justify-center p-6 text-center">
        <p className="text-muted-foreground">The wallet could not load its sign-in. Reload the page to try again.</p>
      </main>
    )
  return (
    <PrivyProvider
      appId={loaded.appId}
      config={{
        appearance: { theme: prefersDark() ? 'dark' : 'light', walletChainType: 'ethereum-only' },
        embeddedWallets: { ethereum: { createOnLogin: 'all-users' }, showWalletUIs: true },
        defaultChain: privyChain(BASE),
        supportedChains: [BASE, ETHEREUM, ARBITRUM].map(privyChain),
      }}
    >
      {children}
    </PrivyProvider>
  )
}
