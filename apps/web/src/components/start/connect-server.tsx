// Connecting a first-class server from Start (ADR 0048): one action that signs in and comes back to the step, allowing
// the server's recommended tools on the way unless the owner unticks it. What that allows is listed before they leave.
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { OnboardingStep, ServerView } from '@goblin/contracts'
import { Button, Receipt } from '@goblin/ui'
import { CircleAlertIcon, CircleCheckIcon } from 'lucide-react'
import { type ReactNode, useId, useState } from 'react'
import { messageOf } from '../../lib/query/app-error.ts'
import { reportUnexpected } from '../../lib/unexpected.ts'
import { allowRecommendedMutation } from '../../mcp/queries.ts'
import { onboardingKeys, startConnectMutation } from '../../onboarding/queries.ts'

/** A tool's name as people read it: `get_connection_status` → "get connection status". */
const spoken = (name: string): string => name.replaceAll('_', ' ')

/** What allowing the recommended tools means, listed exactly, under a disclosure. */
function RecommendedList({ server }: { readonly server: ServerView }) {
  const [open, setOpen] = useState(false)
  const recommended = server.profile?.recommended
  if (recommended === undefined) return null
  const { run, ask } = recommended
  return (
    <div className="start-review">
      <button type="button" className="start-link" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? 'Hide the list' : `Review: ${String(run.length)} run when needed, ${String(ask.length)} ask you first`}
      </button>
      {open && (
        <div className="start-review-lists">
          <div>
            <p className="start-review-head">Run when needed</p>
            <ul>
              {run.map((name) => (
                <li key={name}>{spoken(name)}</li>
              ))}
            </ul>
          </div>
          <div>
            <p className="start-review-head">Ask you first, every time</p>
            <ul>
              {ask.map((name) => (
                <li key={name}>{spoken(name)}</li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </div>
  )
}

function Failure({ text }: { readonly text: string }) {
  return (
    <Receipt tone="error">
      <CircleAlertIcon aria-hidden />
      <span>{text}</span>
    </Receipt>
  )
}

/** Signed out: Connect, with "Allow its recommended tools" ticked. Off to the sign-in, or connected at once. */
function SignIn({
  server,
  step,
  title,
}: {
  readonly server: ServerView
  readonly step: OnboardingStep
  readonly title: string
}) {
  const connect = useMutation(startConnectMutation)
  const [recommend, setRecommend] = useState(true)
  const checkbox = useId()
  const start = () =>
    connect.mutate(
      { connectionId: server.connectionId, step, recommend },
      {
        onSuccess: ({ authorizationUrl }) => {
          if (authorizationUrl !== undefined) window.location.assign(authorizationUrl)
        },
      },
    )
  return (
    <div className="start-action">
      <Button size="cta" pending={connect.isPending || connect.data?.authorizationUrl !== undefined} onClick={start}>
        Connect {title}
      </Button>
      <label className="start-check" htmlFor={checkbox}>
        <input
          id={checkbox}
          type="checkbox"
          checked={recommend}
          onChange={(event) => setRecommend(event.target.checked)}
        />
        <span>Allow its recommended tools</span>
      </label>
      <RecommendedList server={server} />
      {connect.error !== null && <Failure text={messageOf(connect.error, `connect ${title}`)} />}
    </div>
  )
}

/** Connected, its tools not allowed yet: allow the recommended ones here. */
function AllowHere({ server, title }: { readonly server: ServerView; readonly title: string }) {
  const client = useQueryClient()
  const allow = useMutation(allowRecommendedMutation)
  const onClick = () =>
    allow.mutate(server.connectionId, {
      onSuccess: () => {
        client.invalidateQueries({ queryKey: onboardingKeys.view }).catch(reportUnexpected)
      },
    })
  return (
    <div className="start-action">
      <p className="start-state">
        <CircleCheckIcon aria-hidden /> {title} is connected. Allow its recommended tools so goblin can use it.
      </p>
      <Button size="cta" pending={allow.isPending} onClick={onClick}>
        Allow recommended tools
      </Button>
      <RecommendedList server={server} />
      {allow.error !== null && <Failure text={messageOf(allow.error, 'allow the recommended tools')} />}
    </div>
  )
}

/**
 * Connect `server` from step `step`. Signed out: the action. Signed in but not allowed: Allow on its own. Signed in and
 * allowed: done, with what it is now (`children`).
 */
export function ConnectServer({
  server,
  step,
  title,
  allowed,
  children,
}: {
  readonly server: ServerView | 'loading' | undefined
  readonly step: OnboardingStep
  readonly title: string
  readonly allowed: boolean
  readonly children?: ReactNode
}) {
  if (server === 'loading')
    return (
      <p role="status" className="start-note">
        Reading your connections…
      </p>
    )
  if (server === undefined)
    return (
      <Failure
        text={`${title} is not offered on this goblin yet. Skip this step; you can add it later on Connections.`}
      />
    )
  if (server.status !== 'connected') return <SignIn server={server} step={step} title={title} />
  if (!allowed) return <AllowHere server={server} title={title} />
  return (
    <div className="start-action">
      <p className="start-state" data-done>
        <CircleCheckIcon aria-hidden /> {title} is connected, and its recommended tools are allowed.
      </p>
      {children}
    </div>
  )
}
