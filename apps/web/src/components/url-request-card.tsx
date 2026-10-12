import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { AskCard, AskCardActions, AskCardDescription, AskCardHeader, Button, Receipt } from '@goblin/ui'
import type { UrlRequestView } from '@goblin/contracts'
import { CircleAlertIcon, ExternalLinkIcon, LoaderCircleIcon, TriangleAlertIcon } from 'lucide-react'
import { answerUrlRequestMutation, urlRequestQuery } from '../approvals/queries.ts'
import type { Interaction } from '../lib/interactions.ts'
import { messageOf } from '../lib/query/app-error.ts'
import { useConnectionLabels } from '../mcp/hooks.ts'

type UrlRequest = Extract<Interaction, { kind: 'url' }>

/** The link the card may open: https only, as goblin kept it; anything else is not offered. */
const openable = (url: string): string | undefined =>
  URL.canParse(url) && new URL(url).protocol === 'https:' ? url : undefined

/** How a URL request that no longer waits on the owner stands, as the card says it until it leaves the dock. */
const ENDED: Partial<Record<UrlRequestView['state'], string>> = {
  expired: 'This request ran out of time. Ask again if you still want it.',
  failed: 'The call could not be sent again.',
  uncertain: 'Your answer was cut off. The call may have run: check on the server before trying again.',
}

const clock = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })
const day = new Intl.DateTimeFormat(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })

/** When the request stops waiting: a time today, else its day and time. */
const until = (expiresAt: number): string =>
  new Date(expiresAt).toDateString() === new Date().toDateString() ? clock.format(expiresAt) : day.format(expiresAt)

/** The link as the owner checks it: its host, then the whole address, and how long the request waits. */
function UrlLink({ view, pending }: { readonly view: UrlRequestView; readonly pending: boolean }) {
  return (
    <AskCardDescription>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="font-medium text-foreground">{view.host}</span>
        <span className="text-xs break-all">{view.url}</span>
        {pending && <span className="text-xs tabular-nums">Open until {until(view.expiresAt)}</span>}
      </span>
    </AskCardDescription>
  )
}

/** One line under the request: a warning or what went wrong (red icon), or what goblin is doing now. */
function Note({ tone, children }: { readonly tone: 'warning' | 'error' | 'working'; readonly children: string }) {
  return (
    <Receipt tone={tone === 'working' ? 'neutral' : 'error'}>
      {tone === 'warning' ? (
        <TriangleAlertIcon aria-hidden />
      ) : tone === 'error' ? (
        <CircleAlertIcon aria-hidden />
      ) : (
        <LoaderCircleIcon aria-hidden className="animate-spin motion-reduce:animate-none" />
      )}
      <span>{children}</span>
    </Receipt>
  )
}

/** The request could not be read: why, and Try again. */
function ReadFailed({ error, onRetry }: { readonly error: unknown; readonly onRetry: () => void }) {
  return (
    <Receipt tone="error">
      <CircleAlertIcon aria-hidden />
      <span>
        {messageOf(error, 'read the request')}{' '}
        <Button variant="link" size="xs" onClick={onRetry}>
          Try again
        </Button>
      </span>
    </Receipt>
  )
}

/** What the card says under the request, given where it stands and what the owner did. */
function UrlNotes({
  view,
  connection,
  link,
  waiting,
  failure,
}: {
  readonly view: UrlRequestView
  readonly connection: string
  readonly link: string | undefined
  readonly waiting: boolean
  readonly failure: string | undefined
}) {
  const ended = ENDED[view.state]
  return (
    <>
      {!view.ownHost && (
        <Note tone="warning">{`This link goes to ${view.host}, not to ${connection}’s own server. Open it only if you expected that.`}</Note>
      )}
      {link === undefined && (
        <Note tone="warning">{`goblin opens only secure (https) links, so this one is not offered. Ask ${connection} for another.`}</Note>
      )}
      {waiting && (
        <Note tone="working">{`${connection} is still waiting. Finish the step there, then press Done again.`}</Note>
      )}
      {view.state === 'retrying' && <Note tone="working">{`Checking with ${connection}…`}</Note>}
      {ended !== undefined && <Note tone="error">{ended}</Note>}
      {failure !== undefined && <Note tone="error">{failure}</Note>}
    </>
  )
}

/**
 * Who asks, by connection label and tool: the request's own call once it is read, since a job's top-up asks through
 * the wallet rather than the job's server (ADR 0049); the card's call until then.
 */
function useAsker(interaction: UrlRequest, view: UrlRequestView | undefined) {
  const labels = useConnectionLabels()
  return {
    connection: labels(view?.connectionId ?? interaction.connectionId),
    name: view?.name ?? interaction.name,
  }
}

/**
 * A server asks the owner to finish a step on its site before the call can complete (ADR 0042): its message, framed
 * as its own words; the link's host, then the full link; and a warning when the host is not the connection's own.
 * The owner opens the link themselves, in a new tab (Open leads until they have), then Done sends the call again so
 * the server can answer; Cancel declines it.
 */
export function UrlRequestCard({ interaction }: { readonly interaction: UrlRequest }) {
  const read = useQuery(urlRequestQuery(interaction.requestId))
  const { connection, name } = useAsker(interaction, read.data)
  const answer = useMutation(answerUrlRequestMutation(interaction.requestId))
  const [opened, setOpened] = useState(false)
  const view = read.data
  const busy = answer.isPending
  if (view?.state === 'completed' || view?.state === 'declined') return null
  const pending = view?.state === 'pending'
  const link = view === undefined ? undefined : openable(view.url)
  return (
    <AskCard aria-label={`Finish a step on ${connection}’s site`}>
      <AskCardHeader>
        <ExternalLinkIcon aria-hidden />
        <p>
          <strong className="font-medium">
            {connection} · {name}
          </strong>{' '}
          asks you to finish a step on its site
        </p>
      </AskCardHeader>
      {view === undefined && read.error === null && (
        <AskCardDescription role="status">Reading the request…</AskCardDescription>
      )}
      {read.error !== null && <ReadFailed error={read.error} onRetry={() => void read.refetch()} />}
      {view !== undefined && view.message !== '' && (
        <AskCardDescription>
          {connection} says: <span className="whitespace-pre-wrap text-foreground">{view.message}</span>
        </AskCardDescription>
      )}
      {view !== undefined && <UrlLink view={view} pending={pending} />}
      {view !== undefined && (
        <UrlNotes
          view={view}
          connection={connection}
          link={link}
          // Done was pressed and the server answered that it still waits.
          waiting={pending && answer.data?.state === 'pending'}
          failure={answer.error === null ? undefined : messageOf(answer.error, 'send your answer')}
        />
      )}
      {pending && (
        <AskCardActions>
          <Button
            variant="ghost"
            disabled={busy}
            pending={busy && answer.variables === 'decline'}
            onClick={() => answer.mutate('decline')}
          >
            Cancel
          </Button>
          {link !== undefined && (
            <Button
              variant={opened ? 'outline' : 'default'}
              nativeButton={false}
              render={<a href={link} target="_blank" rel="noopener noreferrer" />}
              onClick={() => setOpened(true)}
            >
              Open
            </Button>
          )}
          <Button
            variant={opened || link === undefined ? 'default' : 'outline'}
            disabled={busy}
            pending={busy && answer.variables === 'accept'}
            onClick={() => answer.mutate('accept')}
          >
            Done, continue
          </Button>
        </AskCardActions>
      )}
    </AskCard>
  )
}
