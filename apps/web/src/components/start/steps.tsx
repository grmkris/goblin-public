// Start's steps (ADR 0048), one task each. Each says what the step is for in one line, offers the one action that does
// it, and shows when it is done; what goblin cannot read from the servers (how it pays, the kickoff) the owner tells it.
import { useMutation, useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import type { OnboardingStep, OnboardingView, ServerSuggestion, ServerView } from '@goblin/contracts'
import { Button, Receipt, Textarea } from '@goblin/ui'
import { CircleAlertIcon, CircleCheckIcon, CopyIcon, WalletIcon } from 'lucide-react'
import { useId, useState } from 'react'
import { useBilling } from '../../account/hooks.ts'
import { QueryBoundary } from '../../lib/query/query-boundary.tsx'
import { serversQuery } from '../../mcp/queries.ts'
import { startAddMutation } from '../../onboarding/queries.ts'
import { SuggestedServers } from '../server-add.tsx'
import { ConnectServer } from './connect-server.tsx'
import { QrCode } from './qr-code.tsx'

/** Each step's name on the panel, its title, and the one line of why. */
export const STEP_TEXT: Readonly<Record<OnboardingStep, { label: string; title: string; why: string }>> = {
  wallet: {
    label: 'Goblin Wallet',
    title: 'Connect your Goblin Wallet',
    why: 'goblin pays for its model, web search and outside services from it, within limits you set.',
  },
  funds: {
    label: 'Add funds',
    title: 'Add funds',
    why: 'goblin pays from this address. Send stablecoins to it, from any chain.',
  },
  pay: {
    label: 'How goblin pays',
    title: 'How goblin pays for its model',
    why: 'Your daily Credits come first. When they run out, goblin can pay for each call from your wallet.',
  },
  mercator: {
    label: 'Mercator',
    title: 'Connect Mercator',
    why: 'It searches the web, quotes outside work for free, and runs paid jobs from its own balance.',
  },
  more: {
    label: 'More services',
    title: 'Add more services',
    why: 'Your notes, a real browser, your own sites. goblin uses only the tools you allow.',
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

export function WalletStep({ view }: { readonly view: OnboardingView }) {
  return (
    <ConnectServer
      server={useServer(view.wallet.connectionId)}
      step="wallet"
      title="Goblin Wallet"
      allowed={view.wallet.allowed}
    />
  )
}

/** A chain as people name it. */
const CHAINS: Readonly<Record<string, string>> = {
  tempo: 'Tempo',
  base: 'Base',
  arbitrum: 'Arbitrum',
  ethereum: 'Ethereum',
}

/** An address in groups of four, so it can be read aloud and checked by eye. */
const grouped = (address: string): string =>
  address
    .replace(/^0x/u, '0x ')
    .replace(/(.{4})(?=.)/gu, '$1 ')
    .trim()

/** Copy `text`, saying so for a moment. */
function CopyButton({ text }: { readonly text: string }) {
  const [copied, setCopied] = useState(false)
  async function copy(): Promise<void> {
    await navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 1600)
  }
  return (
    <Button variant="outline" size="sm" onClick={() => void copy()}>
      {copied ? <CircleCheckIcon aria-hidden /> : <CopyIcon aria-hidden />}
      {copied ? 'Copied' : 'Copy address'}
    </Button>
  )
}

export function FundsStep({ view }: { readonly view: OnboardingView }) {
  const { wallet } = view
  const billing = useBilling().state
  if (!wallet.allowed || wallet.connectionId === undefined)
    return (
      <div className="start-action">
        <p className="start-state">Connect your Goblin Wallet first; its address shows here.</p>
        <Button variant="outline" nativeButton={false} render={<Link to="/start/$step" params={{ step: 'wallet' }} />}>
          Go to Goblin Wallet
        </Button>
      </div>
    )
  const app = (
    <Button
      variant="outline"
      nativeButton={false}
      render={
        <Link
          to="/connections/$connectionId/app"
          params={{ connectionId: wallet.connectionId }}
          search={{ focus: 'add_funds' }}
        />
      }
    >
      <WalletIcon aria-hidden />
      Add funds from any chain
    </Button>
  )
  if (wallet.payFrom === undefined)
    return (
      <div className="start-action">
        <p className="start-state">Your wallet has no address for goblin yet. Open it once to finish setting it up.</p>
        {app}
      </div>
    )
  const { address, chain, token, held } = wallet.payFrom
  const needs = Number(wallet.needs)
  const free = billing?.source === 'free' && needs > 0
  return (
    <div className="start-action">
      <div className="start-fund">
        <QrCode value={address} label={`The address goblin pays from, on ${CHAINS[chain] ?? chain}`} />
        <div className="start-fund-text">
          <p className="start-fund-what">
            {token} on {CHAINS[chain] ?? chain}
          </p>
          <p className="start-address">{grouped(address)}</p>
          <CopyButton text={address} />
        </div>
      </div>
      <dl className="start-balance">
        <div>
          <dt>In your wallet</dt>
          <dd>${wallet.dollars ?? '…'}</dd>
        </div>
        {free && (
          <div>
            <dt>For {billing.dailyCredits} free Credits a day</dt>
            <dd>${wallet.needs}</dd>
          </div>
        )}
        {held !== undefined && (
          <div>
            <dt>Ready to pay on {CHAINS[chain] ?? chain}</dt>
            <dd>${held}</dd>
          </div>
        )}
      </dl>
      <p className="start-state" {...(wallet.funded ? { 'data-done': true } : {})} role="status">
        {wallet.funded ? <CircleCheckIcon aria-hidden /> : <span className="start-pulse" aria-hidden />}
        {wallet.funded
          ? 'Funded. goblin can answer and pay for what you allow.'
          : `Waiting for funds. This updates by itself${free ? `; keep $${wallet.needs} here for your free Credits` : ''}.`}
      </p>
      {app}
    </div>
  )
}

export function MercatorStep({ view }: { readonly view: OnboardingView }) {
  return (
    <ConnectServer
      server={useServer(view.mercator.connectionId)}
      step="mercator"
      title="Mercator"
      allowed={view.mercator.allowed}
    >
      <p className="start-note">
        Mercator pays for jobs from its own balance. goblin tops it up from your Goblin Wallet when a job needs it.
      </p>
    </ConnectServer>
  )
}

export function MoreStep() {
  const add = useMutation(startAddMutation).mutateAsync
  const [message, setMessage] = useState('')
  // A suggestion's sign-in comes back here; one that needs none is connected at once, and its tools are chosen later.
  const connectWith = async (item: ServerSuggestion): Promise<string> => {
    const { authorizationUrl } = await add(item.endpoint)
    if (authorizationUrl !== undefined) window.location.assign(authorizationUrl)
    return `Added ${item.title}. Choose its tools on Connections whenever you like.`
  }
  return (
    <div className="start-action">
      <QueryBoundary action="show suggested services">
        <SuggestedServers
          exclude={['wallet', 'mercator']}
          connectWith={connectWith}
          onChanged={setMessage}
          onMessage={setMessage}
        />
      </QueryBoundary>
      {message !== '' && <p className="start-note">{message}</p>}
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
            goblin needs funds to answer.{' '}
            <Link className="cause-link" to="/start/$step" params={{ step: 'funds' }}>
              Add funds
            </Link>
          </span>
        </Receipt>
      )}
    </div>
  )
}

/** How goblin pays: Credits first, then the wallet, per call (ADR 0047); the choice itself lives in Settings. */
export function PayStep() {
  const billing = useBilling().state
  return (
    <div className="start-action">
      <ol className="start-ways">
        <li>
          <span className="start-way-name">Credits first</span>
          <span className="start-way-about">
            {billing === undefined
              ? 'Your plan’s daily Credits'
              : `${String(billing.dailyCredits)} Credits a day on your plan`}
            , used before anything is paid.
          </span>
        </li>
        <li>
          <span className="start-way-name">Then your wallet</span>
          <span className="start-way-about">
            About $0.02 a call, paid from the address you funded, only after they run out.
          </span>
        </li>
      </ol>
      <p className="start-note">You can change this any time in Settings, under How goblin pays for its model.</p>
    </div>
  )
}
