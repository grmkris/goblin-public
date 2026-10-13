// `/` for someone not signed in: what Goblin Wallet is, why its limits hold, and Sign in. The hero is the wallet at
// work (an agent's payments meeting the owner's limits); the sections under it are quiet and specific, each with the
// fact it rests on. Built from the marketing parts goblin's own landing shares; Sign in is the same Privy sign-in as
// the sign-in page's.
import { GoblinMark, MossFrame, Section, SiteBar, SiteButton, SiteFooter } from '@goblin/ui'
import { useEffect } from 'react'
import { useAuth } from '../../app/auth.tsx'
import { HeroStream } from './hero-stream.tsx'
import { LayersVisual } from './layers.tsx'
import { goblinSite, mcpEndpoint } from './origins.ts'
import { ConnectVisual, GasVisual, KeysVisual, SubscriptionVisual } from './sections.tsx'

/** The public source: linked once the repository is public, never before (a dead link never ships). */
const SOURCE = { href: 'https://github.com/grmkris/goblin-public', public: false } as const

/** The moss field at the top of the page, light and dark (`--shell`, and `--shell-rail` in dark), for Safari's bars. */
const MOSS = { light: '#233e27', dark: '#0e1b11' } as const

/**
 * While the landing shows, Safari's bars and the status bar continue its moss field instead of the console's page
 * colour; leaving it (signing in) puts index.html's colours back.
 */
function useMossThemeColor(): void {
  useEffect(() => {
    const metas = [...document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')]
    const before = metas.map((meta) => meta.content)
    for (const meta of metas) meta.content = meta.media.includes('dark') ? MOSS.dark : MOSS.light
    return () => {
      metas.forEach((meta, index) => {
        meta.content = before[index] ?? meta.content
      })
    }
  }, [])
}

/** The five things under the hero, each a claim and the fact it rests on, alternating sides. */
function Sections({ origin, goblin }: { readonly origin: string; readonly goblin: string }) {
  return (
    <>
      <Section id="limits" title="Every limit says who enforces it." visual={<LayersVisual />}>
        <p>
          A limit is only as strong as whoever keeps it. Each one in your wallet names its layer, from the chain to your
          MCP client, and each layer can only narrow the one around it.
        </p>
      </Section>
      <Section
        id="gas"
        title={
          <>
            Gas in USDC.
            <br />
            No ETH, anywhere.
          </>
        }
        visual={<GasVisual />}
        flip
      >
        <p>
          Every send is a UserOperation whose gas the paymaster takes in USDC, capped at $0.10 a send on Base. Neither
          you nor your agent ever needs to hold ETH.
        </p>
      </Section>
      <Section id="subscriptions" title="Subscriptions you sign once." visual={<SubscriptionVisual />}>
        <p>
          A service asks once. You sign four terms the chain holds it to: what may move, to whom, how much and until
          when. Cancel any time with your own transaction.
        </p>
        <p>goblin Pro is paid this way.</p>
      </Section>
      <Section
        id="connect"
        title={
          <>
            Made for goblin.
            <br />
            Works with any MCP client.
          </>
        }
        visual={<ConnectVisual endpoint={mcpEndpoint(origin)} />}
        flip
      >
        <p>
          goblin connects your wallet when you start, and pays for its model, its services and Pro from it. Any other
          MCP client can connect too: it signs in with OAuth, and you approve it here.
        </p>
        <p>
          <a className="font-medium text-moss underline underline-offset-4" href={goblin}>
            Meet goblin
          </a>
        </p>
      </Section>
      <Section id="keys" title="Your keys stay yours." visual={<KeysVisual />}>
        <p>The wallet keeps your limits, not your keys. What it may sign is fixed before your agent asks.</p>
      </Section>
    </>
  )
}

function Footer({ goblin }: { readonly goblin: string }) {
  return (
    <div className="bg-background">
      <SiteFooter
        name="Goblin Wallet"
        mark={<GoblinMark />}
        note="The wallet your agent pays from, with limits you set. Open source, MIT."
        groups={[
          {
            title: 'Wallet',
            links: [
              { label: 'How limits hold', href: '#limits' },
              { label: 'Connect a client', href: '#connect' },
            ],
          },
          { title: 'goblin', links: [{ label: 'Meet goblin', href: goblin }] },
          {
            title: 'Legal',
            links: [
              { label: 'Terms', href: `${goblin}/terms` },
              { label: 'Privacy', href: `${goblin}/privacy` },
              { label: 'Refunds', href: `${goblin}/refunds` },
            ],
          },
        ]}
        source={SOURCE.href}
        showSource={SOURCE.public}
      />
    </div>
  )
}

export function WalletLanding() {
  const auth = useAuth()
  const origin = window.location.origin
  const goblin = goblinSite(origin)
  const signIn = (label: string) => ({ label, onClick: auth.login, pending: auth.status === 'loading' })
  useMossThemeColor()
  return (
    // The moss behind the page shows only under the translucent top bar, so it reads as the hero's own field.
    <div className="wallet-landing flex min-h-dvh flex-col bg-shell text-foreground dark:bg-(--shell-rail)">
      <SiteBar
        name="Goblin Wallet"
        mark={<GoblinMark />}
        tone="moss"
        links={[
          { label: 'Limits', href: '#limits' },
          { label: 'Connect', href: '#connect' },
        ]}
        signIn={signIn('Sign in')}
      />
      <main className="flex-1 bg-background">
        <MossFrame
          title="Your agent can pay. Within limits you set."
          lede="Goblin Wallet pays for your AI agent's searches, services and transfers in USDC, inside limits the chain and the signer enforce. Anyone new waits for your yes."
          actions={<SiteButton action={signIn('Sign in with email or X')} />}
          note="Your wallet is created when you first sign in. Nothing is spent until you allow it."
          panelLabel="Your agent's payments"
          panel={<HeroStream />}
        />
        <Sections origin={origin} goblin={goblin} />
      </main>
      <Footer goblin={goblin} />
    </div>
  )
}
