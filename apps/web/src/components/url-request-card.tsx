import { useMutation, useQuery } from '@tanstack/react-query'
import { AskCard, AskCardActions, AskCardDescription, AskCardHeader, Button, Receipt } from '@goblin/ui'
import type { UrlRequestView } from '@goblin/contracts'
import { ExternalLinkIcon, TriangleAlertIcon } from 'lucide-react'
import { answerUrlRequestMutation, urlRequestQuery } from '../approvals/queries.ts'
import type { Interaction } from '../lib/interactions.ts'
import { messageOf } from '../lib/query/app-error.ts'
import { useConnectionLabels } from '../mcp/hooks.ts'

type UrlRequest = Extract<Interaction, { kind: 'url' }>

/** The link the card may open: https only, as goblin kept it; anything else is not offered. */
const openable = (url: string): string | undefined =>
  URL.canParse(url) && new URL(url).protocol === 'https:' ? url : undefined

/** How a URL request that no longer waits on the owner ended, as the card says it. */
const ENDED: Partial<Record<UrlRequestView['state'], string>> = {
  retrying: 'Checking with the server…',
  expired: 'This request expired. Ask again if you still want it.',
  failed: 'The call could not be sent again. Nothing is known to have happened.',
  uncertain: 'The answer was interrupted. The call may have taken effect; check the service before trying again.',
}

/**
 * A server asks the owner to finish a step on its site before the call can complete (ADR 0042): its message as text,
 * the full link and its host, and a warning when the host is not the connection's own. The owner opens the link
 * themselves, in a new tab; Done sends the call again so the server can answer, and Cancel declines it.
 */
export function UrlRequestCard({ interaction }: { readonly interaction: UrlRequest }) {
  const read = useQuery(urlRequestQuery(interaction.requestId))
  const connection = useConnectionLabels()(interaction.connectionId)
  const answer = useMutation(answerUrlRequestMutation(interaction.requestId))
  const view = read.data
  const busy = answer.isPending
  const error =
    answer.error !== null
      ? messageOf(answer.error, 'send your answer')
      : read.error !== null
        ? messageOf(read.error, 'read the request')
        : ''
  if (view?.state === 'completed' || view?.state === 'declined') return null
  const pending = view?.state === 'pending'
  const link = view === undefined ? undefined : openable(view.url)
  // Done was pressed and the server answered that it still waits.
  const waiting = pending && answer.data?.state === 'pending'
  const ended = view === undefined ? undefined : ENDED[view.state]
  return (
    <AskCard aria-label="Finish a step on the server's site">
      <AskCardHeader>
        <ExternalLinkIcon aria-hidden />
        <p>
          <strong className="font-medium">
            {connection} · {interaction.name}
          </strong>{' '}
          asks you to finish a step on its site
        </p>
      </AskCardHeader>
      {view !== undefined && view.message !== '' && (
        <AskCardDescription className="whitespace-pre-wrap">{view.message}</AskCardDescription>
      )}
      {view !== undefined && (
        <AskCardDescription>
          <span className="font-medium text-foreground">{view.host}</span>
          <code className="block break-all">{view.url}</code>
        </AskCardDescription>
      )}
      {view !== undefined && !view.ownHost && (
        <Receipt tone="error">
          <TriangleAlertIcon aria-hidden />
          <span>
            This link goes to {view.host}, not to {connection}’s own server. Open it only if you expected that.
          </span>
        </Receipt>
      )}
      {waiting && <Receipt>The server is still waiting. Finish the step there, then press Done again.</Receipt>}
      {ended !== undefined && <Receipt tone={view?.state === 'retrying' ? 'neutral' : 'error'}>{ended}</Receipt>}
      {error && <Receipt tone="error">{error}</Receipt>}
      <AskCardActions>
        <Button variant="ghost" disabled={busy || !pending} onClick={() => answer.mutate('decline')}>
          Cancel
        </Button>
        {link !== undefined && pending && (
          <Button
            variant="outline"
            nativeButton={false}
            render={<a href={link} target="_blank" rel="noopener noreferrer" />}
          >
            Open
          </Button>
        )}
        <Button disabled={busy || !pending} pending={busy} onClick={() => answer.mutate('accept')}>
          Done, continue
        </Button>
      </AskCardActions>
    </AskCard>
  )
}
