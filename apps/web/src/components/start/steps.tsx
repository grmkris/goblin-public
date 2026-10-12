// Start's steps (ADR 0048), one task each. Each says what the step is for in one line, offers the one action that does
// it, and shows when it is done. The wallet's setup and funds are the wallet's own: Start shows what it says is left and
// sends the owner to its setup page; what goblin cannot read from the servers (the welcome, services, the kickoff) the
// owner tells it.
import { useMutation, useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import type { OnboardingStep, OnboardingView, ServerSuggestion, ServerView } from '@goblin/contracts'
import { Badge, Button, GoblinMark, Receipt, Textarea } from '@goblin/ui'
import { CircleAlertIcon, CircleCheckIcon, PlusIcon, WalletIcon } from 'lucide-react'
import { useId, useState } from 'react'
import { payQuery } from '../../agent/queries.ts'
import { useBilling } from '../../account/hooks.ts'
import { QueryBoundary } from '../../lib/query/query-boundary.tsx'
import { serverStatusQuery, serversQuery } from '../../mcp/queries.ts'
import { startAddMutation } from '../../onboarding/queries.ts'
import { SuggestedServers } from '../server-add.tsx'
import { PrepaidLine } from '../first-class.tsx'
import { PayModeChoices, payModeTitle, waysOf } from '../inference-card.tsx'
import { ConnectServer } from './connect-server.tsx'

/** Each step's name on the panel, its title, and the one line of why. */
export const STEP_TEXT: Readonly<Record<OnboardingStep, { label: string; title: string; why: string }>> = {
  welcome: {
    label: 'Welcome',
    title: 'goblin is your own agent',
    why: 'It works through MCP servers: services you connect and allow, tool by tool. It pays for its own model and services from your Goblin Wallet, within limits you set.',
  },
  wallet: {
    label: 'Goblin Wallet',
    title: 'Set up your Goblin Wallet',
    why: 'goblin pays for its model and outside services from it, within the limits you set there.',
  },
  services: {
    label: 'Services',
    title: 'How goblin reaches the outside world',
    why: 'Each service is an MCP server you connect. goblin uses only the tools you allow, and asks before anything that costs money.',
  },
  goblin: {
    label: 'Your goblin',
    title: 'What do you want goblin for?',
    why: 'Say it in your own words. goblin suggests a few Topics and Personas to start with.',
  },
}

/** The owner's connection `connectionId`, once the list is read (`loading` until then). */
function useServer(connectionId: string | undefined): ServerView | 'loading' | undefined {
  const servers = useQuery(serversQuery).data
  if (servers === undefined) return 'loading'
  return servers.find((server) => server.connectionId === connectionId)
}

/** Dollars as Start shows them: `$24.50`. */
const dollars = (amount: string): string => `$${Number(amount).toFixed(2)}`

/** A chain as people name it. */
const CHAINS: Readonly<Record<string, string>> = {
  tempo: 'Tempo',
  base: 'Base',
  arbitrum: 'Arbitrum',
  ethereum: 'Ethereum',
}

/** What goblin is, in three pieces: the wallet that pays for it, goblin itself, and what comes later. */
export function WelcomeStep({ onContinue }: { readonly onContinue: () => void }) {
  return (
    <div className="start-action">
      <ul className="start-pieces">
        <li>
          <span className="start-piece-mark" aria-hidden>
            <WalletIcon />
          </span>
          <span className="start-piece-name">Goblin Wallet</span>
          <span className="start-piece-about">Pays for goblin, within your limits</span>
        </li>
        <li>
          <span className="start-piece-mark" aria-hidden>
            <GoblinMark />
          </span>
          <span className="start-piece-name">goblin</span>
          <span className="start-piece-about">Your agent, right here</span>
        </li>
        <li data-soon>
          <span className="start-piece-mark" aria-hidden>
            <PlusIcon />
          </span>
          <span className="start-piece-name">More coming soon</span>
        </li>
      </ul>
      <p className="start-note">Outside services such as Mercator and myapps come next.</p>
      <Button size="cta" onClick={onContinue}>
        Set up my wallet
      </Button>
    </div>
  )
}

/** A gap the wallet reports, as a line of the checklist: its own words, first letter capitalised, plain text only. */
const sentence = (gap: string): string => gap.charAt(0).toUpperCase() + gap.slice(1)

/** The wallet's own setup page, in this tab: it comes back to this step when the owner is done there. */
function SetupLink({ href, children }: { readonly href: string; readonly children: string }) {
  return (
    <Button size="cta" nativeButton={false} render={<a href={href} />}>
      <WalletIcon aria-hidden />
      {children}
    </Button>
  )
}

/** Connected and allowed, but the wallet is not set up to pay yet: what it says is left, and the way to finish. */
function WalletSetup({ wallet }: { readonly wallet: OnboardingView['wallet'] }) {
  const why =
    wallet.gaps.length > 0
      ? undefined
      : wallet.dollars === undefined
        ? 'goblin could not read your wallet just now. It tries again by itself.'
        : 'Your wallet has no address for goblin to pay from yet.'
  return (
    <div className="start-action">
      {wallet.gaps.length > 0 && (
        <div className="start-todo">
          <p className="start-todo-head">Your wallet still needs:</p>
          <ul className="start-gaps">
            {wallet.gaps.map((gap) => (
              <li key={gap}>
                <span className="start-gap-mark" aria-hidden />
                {sentence(gap)}
              </li>
            ))}
          </ul>
        </div>
      )}
      {why !== undefined && <p className="start-state">{why}</p>}
      {wallet.setupUrl !== undefined && <SetupLink href={wallet.setupUrl}>Finish setup in your wallet</SetupLink>}
      <p className="start-note" role="status">
        <span className="start-pulse" aria-hidden />
        This page updates by itself once the wallet is set up.
      </p>
    </div>
  )
}

/** How goblin pays for its model now, in words, with Change opening the same choices as Settings in place. */
function PayLine() {
  const pay = useQuery(payQuery).data
  const [open, setOpen] = useState(false)
  if (pay === undefined) return null
  const choices = waysOf(pay).length > 1
  return (
    <div className="start-pay">
      <p className="start-pay-line">
        <span>goblin pays: {payModeTitle(pay.mode)}</span>
        {choices && (
          <button type="button" className="start-link" aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? 'Done' : 'Change'}
          </button>
        )}
      </p>
      {open && <PayModeChoices />}
    </div>
  )
}

/** Set up in the wallet: what it holds and where it pays from, how goblin pays, and Add funds while it holds too little. */
function WalletReady({ wallet }: { readonly wallet: OnboardingView['wallet'] }) {
  const billing = useBilling().state
  const free = billing?.source === 'free' && Number(wallet.needs) > 0
  const held = wallet.payFrom?.held
  return (
    <div className="start-action">
      <div className="start-wallet" {...(wallet.funded ? { 'data-funded': true } : {})}>
        <p className="start-state" {...(wallet.funded ? { 'data-done': true } : {})}>
          {wallet.funded ? <CircleCheckIcon aria-hidden /> : <span className="start-pulse" aria-hidden />}
          {wallet.funded ? 'Ready to pay' : 'Set up. Add funds to start'}
        </p>
        <p className="start-wallet-amount">
          <span className="start-wallet-dollars">{wallet.dollars === undefined ? '…' : dollars(wallet.dollars)}</span>
          <span> in your wallet</span>
        </p>
        {held !== undefined && wallet.payFrom !== undefined && (
          <p className="start-note">
            {dollars(held)} ready to pay on {CHAINS[wallet.payFrom.chain] ?? wallet.payFrom.chain}
          </p>
        )}
        {!wallet.funded && free && (
          <p className="start-note">
            Your {billing.dailyCredits} free Credits a day start once it holds {dollars(wallet.needs)}.
          </p>
        )}
        <PayLine />
      </div>
      {!wallet.funded && wallet.setupUrl !== undefined && (
        <SetupLink href={wallet.setupUrl}>Add funds in your wallet</SetupLink>
      )}
    </div>
  )
}

/** The Goblin Wallet: connect it, finish its setup in the wallet, then what it holds and how goblin pays. */
export function WalletStep({ view }: { readonly view: OnboardingView }) {
  const server = useServer(view.wallet.connectionId)
  const { wallet } = view
  if (!wallet.allowed)
    return (
      <div className="start-action">
        <p className="start-lede">You set it up and add funds in your wallet, then come back here.</p>
        <ConnectServer server={server} step="wallet" title="Goblin Wallet" allowed={false} />
      </div>
    )
  return wallet.ready ? <WalletReady wallet={wallet} /> : <WalletSetup wallet={wallet} />
}

/** Mercator's own balance and how goblin keeps it topped up from the wallet (ADR 0049), once it is connected. */
function MercatorBalance({ server }: { readonly server: ServerView }) {
  const status = useQuery(serverStatusQuery(server.connectionId, true)).data
  if (server.profile === undefined) return null
  return <PrepaidLine connectionId={server.connectionId} profile={server.profile} wallet={status} />
}

/** Mercator first and on its own (optional), then the other services we suggest, and what is still to come. */
export function ServicesStep({ view }: { readonly view: OnboardingView }) {
  const mercator = useServer(view.mercator.connectionId)
  const add = useMutation(startAddMutation).mutateAsync
  const [message, setMessage] = useState('')
  const heading = useId()
  // A suggestion's sign-in comes back here; one that needs none is connected at once, and its tools are chosen later.
  const connectWith = async (item: ServerSuggestion): Promise<string> => {
    const { authorizationUrl } = await add(item.endpoint)
    if (authorizationUrl !== undefined) window.location.assign(authorizationUrl)
    return `Added ${item.title}. Choose its tools on Connections whenever you like.`
  }
  return (
    <div className="start-action">
      <section className="start-feature" aria-labelledby={`${heading}-mercator`}>
        <div className="start-feature-head">
          <h2 id={`${heading}-mercator`}>Mercator</h2>
          <Badge variant="secondary">Optional</Badge>
        </div>
        <p className="start-feature-about">
          Searches the web, quotes outside work for free, and runs paid jobs from its own balance, which goblin tops up
          from your wallet.
        </p>
        <ConnectServer server={mercator} step="services" title="Mercator" allowed={view.mercator.allowed}>
          {mercator !== undefined && mercator !== 'loading' && <MercatorBalance server={mercator} />}
        </ConnectServer>
      </section>
      <section className="start-more" aria-labelledby={`${heading}-more`}>
        <h2 id={`${heading}-more`} className="start-subhead">
          Other services
        </h2>
        <QueryBoundary action="show suggested services">
          <SuggestedServers
            exclude={['wallet', 'mercator']}
            connectWith={connectWith}
            onChanged={setMessage}
            onMessage={setMessage}
          />
        </QueryBoundary>
        {message !== '' && <p className="start-note">{message}</p>}
        <p className="start-note">More coming soon.</p>
      </section>
    </div>
  )
}

/** Ideas to start from: tapping one fills the field. */
const IDEAS = [
  'Plan a trip and keep every booking in one place',
  'Research a topic and write up what I should know',
  'Track my training and nudge me when I slack',
]

export function GoblinStep({
  view,
  pending,
  onStart,
}: {
  readonly view: OnboardingView
  readonly pending: boolean
  readonly onStart: (text: string) => void
}) {
  const billing = useBilling().state
  const [text, setText] = useState('')
  const field = useId()
  const canAnswer =
    (billing !== undefined && billing.source !== 'free') ||
    view.wallet.funded ||
    Number(view.wallet.payFrom?.held ?? '0') >= 0.05
  return (
    <div className="start-action">
      <label className="sr-only" htmlFor={field}>
        What do you want goblin for?
      </label>
      <div className="start-kickoff">
        <Textarea
          id={field}
          rows={4}
          maxLength={2000}
          placeholder="I'm moving to Lisbon in March and…"
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
      </div>
      <div className="start-ideas">
        {IDEAS.map((idea) => (
          <button key={idea} type="button" className="start-idea" onClick={() => setText(idea)}>
            {idea}
          </button>
        ))}
      </div>
      {canAnswer ? (
        <Button size="cta" disabled={text.trim() === ''} pending={pending} onClick={() => onStart(text.trim())}>
          Start with this
        </Button>
      ) : (
        <Receipt tone="neutral">
          <CircleAlertIcon aria-hidden />
          <span>
            goblin needs a funded wallet to answer.{' '}
            <Link className="cause-link" to="/start/$step" params={{ step: 'wallet' }}>
              Set up your wallet
            </Link>
          </span>
        </Receipt>
      )}
    </div>
  )
}
