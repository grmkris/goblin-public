// goblin's public front door at `/` for a visitor who is signed out (a signed-in owner goes straight to their chat):
// what goblin does differently, in ten seconds, that it is real (live on Base mainnet, open source), and the way in,
// Meet your goblin. The hero is goblin's own shell at large scale with a short session playing in it; everything after
// it is quiet: a heading, a little copy and one real visual per section. Built from the shared marketing parts in
// @goblin/ui (also Goblin Wallet's front door), which links back here.
import { type ReactNode, useEffect, useState, useSyncExternalStore } from 'react'
import { CheckIcon, CopyIcon } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import {
  GoblinMark,
  MossFrame,
  PermissionCard,
  Section,
  SiteBar,
  SiteButton,
  SiteFooter,
  type SiteLink,
} from '@goblin/ui'
import type { PublicPlan } from '@goblin/contracts'
import { healthQuery } from '../../auth/queries.ts'
import { useSession } from '../../auth/hooks.ts'
import { lastChannel } from '../../lib/last-channel.ts'
import { reportUnexpected } from '../../lib/unexpected.ts'
import { choiceOf, pricesOf } from '../../lib/pro.ts'
import { HeroComposer, HeroSession, HeroStatus, useHeroSession } from './hero-session.tsx'
import { ServerList } from './server-list.tsx'
import lisbonDark from '../../assets/landing/lisbon-dark.webp'
import lisbonLight from '../../assets/landing/lisbon-light.webp'
import lisbonPhoneDark from '../../assets/landing/lisbon-phone-dark.webp'
import trivagoApp from '../../assets/landing/trivago-app.webp'

/** goblin's public source, public since 13 Oct 2026. */
const SOURCE = { href: 'https://github.com/grmkris/goblin-public', public: true } as const
/** Production, which every stage's page names until its own `/health` says otherwise. */
const PRODUCTION = 'https://goblin.surf'
const WALLET = 'https://wallet.goblin.surf'
/** Pro's prices before `/health` answers: the defaults in apps/runtime/src/billing/plans.ts. */
const DEFAULT_PLANS: readonly PublicPlan[] = [
  { id: 'day', amountUsd: '1.00', periodDays: 1 },
  { id: 'month', amountUsd: '15.00', periodDays: 30 },
]
/** Payments goblin made on mainnet on 12 October 2026 (README, evidence/wallet/beats-mainnet-20261012.json). */
const TX = {
  search: 'https://basescan.org/tx/0xc09ca95d5ff071d45e83d09504a4dfa1d367a289d6beabc1ba878029b39cb0fd',
  approved: 'https://basescan.org/tx/0xe4219e53ec87f363181090b28a2e008f0bc02221dc689fb75068cb8dbab8e3dc',
  bridge: 'https://basescan.org/tx/0x2dce04899f917d6c3e7aab58ba25ff663fe176d9ab34484b130622a6712f3e7b',
} as const

const MEET = { label: 'Meet your goblin', href: '/login?new=1' } as const satisfies SiteLink
const SIGN_IN = { label: 'Sign in', href: '/login' } as const satisfies SiteLink

/** This page's own origin once it runs in a browser (the dev stage's on dev); production's while rendered on the server. */
const useOrigin = (): string =>
  useSyncExternalStore(
    () => () => undefined,
    () => window.location.origin,
    () => PRODUCTION,
  )

/** What `/health` tells anyone: Pro's prices and the Goblin Wallet's address, with production's until it answers. */
function usePublic(): { readonly plans: readonly PublicPlan[]; readonly wallet: string } {
  const health = useQuery(healthQuery).data
  return {
    plans: health === undefined || health.plans.length === 0 ? DEFAULT_PLANS : health.plans,
    wallet: health?.walletOrigin ?? WALLET,
  }
}

/** A session that turns out to be signed in (a check still under way when Home opened) leaves for its channel. */
function useLeaveWhenSignedIn() {
  const { state } = useSession()
  const navigate = useNavigate()
  useEffect(() => {
    if (state === 'signed-in')
      navigate({ to: '/c/$chatId', params: { chatId: lastChannel() }, replace: true }).catch(reportUnexpected)
  }, [state, navigate])
}

export function Landing() {
  useLeaveWhenSignedIn()
  const { plans, wallet } = usePublic()
  const session = useHeroSession()
  return (
    <>
      <SiteBar
        name="goblin"
        mark={<GoblinMark />}
        tone="moss"
        links={[{ label: 'Goblin Wallet', href: wallet }]}
        signIn={SIGN_IN}
        cta={MEET}
      />
      <MossFrame
        title="Your own goblin, always on."
        lede="A personal agent that keeps working while you're away, uses only the tools you allow, and asks before it spends."
        actions={<SiteButton action={MEET} />}
        note={`goblin Pro is ${pricesOf(plans)}, in USDC.`}
        panelLabel="# Islands"
        panelStatus={<HeroStatus stage={session.stage} />}
        panel={<HeroSession session={session} />}
        panelFooter={<HeroComposer />}
      />
      <Away />
      <Spends plans={plans} />
      <Connect />
      <Open />
      <Wallet wallet={wallet} />
      <Pricing plans={plans} />
      <Close />
      <SiteFooter
        name="goblin"
        mark={<GoblinMark />}
        note="Your own resident agent on Cloudflare, always on. Open source, MIT."
        groups={[
          {
            title: 'goblin',
            links: [MEET, SIGN_IN, { label: 'Pricing', href: '#pricing' }],
          },
          { title: 'Goblin Wallet', links: [{ label: 'Open Goblin Wallet', href: wallet }] },
          {
            title: 'Policies',
            links: [
              { label: 'Terms', href: '/terms' },
              { label: 'Privacy', href: '/privacy' },
              { label: 'Refunds', href: '/refunds' },
            ],
          },
        ]}
        source={SOURCE.href}
        showSource={SOURCE.public}
      />
    </>
  )
}

/** A screenshot of goblin, outlined so its edge holds on any surface. */
function Shot({ caption, children }: { readonly caption: string; readonly children: ReactNode }) {
  return (
    <figure className="landing-shot">
      {children}
      <figcaption>{caption}</figcaption>
    </figure>
  )
}

function Away() {
  return (
    <Section
      id="away"
      title="It keeps working while you're away"
      visual={
        <Shot caption="Lisbon long weekend, an app goblin built and checks against trivago each morning.">
          <picture>
            <source
              media="(max-width: 40rem) and (prefers-color-scheme: dark)"
              srcSet={lisbonPhoneDark}
              width={780}
              height={1147}
            />
            <source media="(prefers-color-scheme: dark)" srcSet={lisbonDark} width={1600} height={947} />
            <img
              src={lisbonLight}
              width={1600}
              height={947}
              loading="lazy"
              decoding="async"
              alt="An app goblin built: a price target of €120 a night, a map of Alfama with three hotels pinned, and the three hotels with their prices, the cheapest under the target."
            />
          </picture>
        </Shot>
      }
    >
      <p>Ask once and goblin keeps at it, long after you close the tab.</p>
      <dl className="landing-points">
        <div>
          <dt>Routines</dt>
          <dd>It checks trivago at 07:30 every day, or wakes when a service you connected sends an event.</dd>
        </div>
        <div>
          <dt>Telegram</dt>
          <dd>It tells you when the price drops, and your reply comes straight back to it.</dd>
        </div>
        <div>
          <dt>Apps it builds</dt>
          <dd>The hotels, the map and the plan for your weekend stay on a page of their own.</dd>
        </div>
      </dl>
    </Section>
  )
}

function Spends({ plans }: { readonly plans: readonly PublicPlan[] }) {
  const month = plans.find((plan) => plan.id === 'month') ?? DEFAULT_PLANS[1]
  const amount = Number(month?.amountUsd ?? '15').toFixed(2)
  const days = String(month?.periodDays ?? 30)
  return (
    <Section
      id="spends"
      flip
      title="It asks before it spends"
      visual={
        <div className="landing-permission">
          <PermissionCard
            title="goblin Pro, monthly"
            asker="Asked by goblin.surf"
            amountUsd={amount}
            per={`every ${days} days`}
            terms={[
              { title: 'USDC transfers only', detail: 'Nothing else can move from your account.' },
              { title: 'Only to goblin', detail: 'The recipient is fixed; it cannot be changed.' },
              { title: `At most $${amount} every ${days} days`, detail: 'The first payment right after you sign.' },
              { title: 'For 12 payments', detail: 'A year, or until you cancel.' },
            ]}
            footer="You sign it once in your Goblin Wallet, and cancel it there whenever you like."
          />
        </div>
      }
    >
      <p>
        goblin pays from a Goblin Wallet you own, in USDC on Base. You set the limits, and the chain enforces them. A
        new recipient or a bigger amount waits for your yes.
      </p>
      <p>
        <a className="landing-link" href={TX.approved} rel="noopener">
          Live on Base mainnet
        </a>
        : a first payment to a new address, held until its owner approved it.
      </p>
    </Section>
  )
}

function Connect() {
  return (
    <Section
      id="connect"
      title="Connect anything by address"
      visual={
        <Shot caption="trivago's own view, running in the chat.">
          <img
            src={trivagoApp}
            width={1200}
            height={478}
            loading="lazy"
            decoding="async"
            alt="trivago's hotel list inside a goblin chat: Áurea Museum at 154 euros a night and My Story Hotel Figueira at 167, each with its rating and a View deal button."
          />
        </Shot>
      }
    >
      <p>
        goblin speaks MCP. Add a server by its address or take one from the shelf, allow the tools you want, and its
        apps open right in the chat.
      </p>
      <ServerList />
    </Section>
  )
}

/** Copies the command, and says so for a moment; a clipboard that refuses leaves it as it was. */
function CopyCommand({ command }: { readonly command: string }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return undefined
    const timer = window.setTimeout(() => setCopied(false), 1600)
    return () => window.clearTimeout(timer)
  }, [copied])
  return (
    <button
      type="button"
      className="landing-copy"
      onClick={() => {
        navigator.clipboard.writeText(command).then(
          () => setCopied(true),
          // expected: a refused clipboard leaves the button as it was; the command stays selectable
          () => undefined,
        )
      }}
    >
      {copied ? <CheckIcon aria-hidden /> : <CopyIcon aria-hidden />}
      <span role="status">{copied ? 'Copied' : 'Copy'}</span>
    </button>
  )
}

function Open() {
  const command = `claude mcp add --transport http goblin ${useOrigin()}/mcp`
  return (
    <Section
      id="open"
      flip
      title="Yours, and open"
      visual={
        <figure className="landing-command">
          <div className="landing-command-head">
            <figcaption>Add your goblin to Claude Code</figcaption>
            <CopyCommand command={command} />
          </div>
          <pre>
            <code>{command}</code>
          </pre>
          <p>Then sign in and approve it in your browser. Any MCP client works the same way.</p>
        </figure>
      }
    >
      <p>
        Everyone gets their own agent on Cloudflare, with its own memory and its own keys to the services they connect.
        Reach yours from the web, from Telegram, or from Claude Code and any other MCP client.
      </p>
      <p>Open source, MIT.</p>
    </Section>
  )
}

function Wallet({ wallet }: { readonly wallet: string }) {
  return (
    <Section
      id="wallet"
      title="Goblin Wallet, the wallet your goblin pays from"
      visual={
        <figure className="landing-shot">
          <ul className="landing-receipts">
            <li>
              <b>$0.007</b>
              <span>A web search, paid to Exa over x402 from the allowance.</span>
              <a href={TX.search} rel="noopener">
                Basescan
              </a>
            </li>
            <li>
              <b>$1.00</b>
              <span>To a new address, after its owner approved it.</span>
              <a href={TX.approved} rel="noopener">
                Basescan
              </a>
            </li>
            <li>
              <b>$2.00</b>
              <span>Moved from Base to Tempo, to top up Mercator.</span>
              <a href={TX.bridge} rel="noopener">
                Basescan
              </a>
            </li>
          </ul>
          <figcaption>Paid by goblin on Base mainnet, 12 October 2026.</figcaption>
        </figure>
      }
    >
      <p>
        Its own app, where you fund your account with USDC, set what your agent may spend, and approve anything new. Gas
        is paid in USDC too, so you never need ETH. Any MCP client can pay with it, within your limits.
      </p>
      <p>
        <a className="landing-link" href={wallet}>
          Open Goblin Wallet
        </a>
      </p>
    </Section>
  )
}

function Pricing({ plans }: { readonly plans: readonly PublicPlan[] }) {
  return (
    <Section
      id="pricing"
      flip
      title="One plan, two ways to pay"
      visual={
        <ul className="sub-choices landing-plans">
          {plans.map((plan) => {
            const choice = choiceOf(plan)
            return (
              <li key={plan.id} className="sub-choice">
                <div className="sub-choice-head">
                  <h3 className="sub-choice-name">{choice.name}</h3>
                </div>
                <p className="sub-choice-price">
                  <span className="sub-choice-figure">{choice.price}</span>
                  <span className="sub-choice-per">{choice.per}</span>
                </p>
                <p className="sub-choice-suits">{choice.suits}</p>
              </li>
            )
          })}
        </ul>
      }
    >
      <p>
        goblin Pro includes 800 Credits of models a day, routines, hand-overs and subagents. You pay in USDC from your
        Goblin Wallet, and cancel there.
      </p>
    </Section>
  )
}

function Close() {
  return (
    <section className="landing-close" data-tone="moss" aria-labelledby="landing-close-title">
      <div className="site-width landing-close-row">
        <h2 id="landing-close-title" className="site-heading">
          Your agent. Your apps. Your money. Your rules.
        </h2>
        <SiteButton action={MEET} />
      </div>
    </section>
  )
}
