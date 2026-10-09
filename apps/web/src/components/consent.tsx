import { useEffect, useState } from 'react'
import { Alert, AlertDescription, Button, Switch } from '@goblin/ui'
import { isString, record } from '../lib/boundary.ts'
import { authClient, redirectOf } from '../lib/auth-client.ts'
import { INSPECT_SCOPE, consentBody, requestedScopes } from '../lib/consent-scope.ts'
import { AuthShell } from './auth-shell.tsx'

type ClientInfo = { readonly name: string; readonly uri?: string }
/** The client asking, once looked up, or why it could not be: then the owner is not asked to allow it. */
type ClientLookup =
  | { readonly kind: 'loading' }
  | { readonly kind: 'found'; readonly client: ClientInfo }
  | { readonly kind: 'failed'; readonly reason: string }

const LOOKUP_FAILED = 'Could not look up the app asking for access. Reload the page to try again.'
const UNKNOWN_CLIENT = 'goblin does not know this app. Start connecting from the app again.'

/** What every MCP client may do once allowed. */
const ASK = [
  'ask your agent questions and give it tasks in your main conversation, where its messages show its name;',
  'read the recent messages of your main conversation;',
  "have your agent use the tools you allowed under Connections, while Work while you're away is on.",
]
/** What the `goblin:inspect` scope adds (ADR 0024): read-only, it never sends or changes anything. */
const INSPECT = [
  'read all your conversations in full, including tool calls and their results, without changing anything;',
  'read how each turn ran: model calls, tool calls, retries, errors and timings.',
]

/** The client's registered name and address: untrusted, shown as the client's own claim. */
function useClient(clientId: string): ClientLookup {
  const [lookup, setLookup] = useState<ClientLookup>({ kind: 'loading' })
  useEffect(() => {
    let current = true
    void authClient
      .$fetch('/oauth2/public-client', { method: 'GET', query: { client_id: clientId } })
      .then(({ data, error }) => {
        const info = record(data)
        const name = info?.client_name
        const uri = info?.client_uri
        if (!current) return
        if (error || info === undefined)
          setLookup({ kind: 'failed', reason: error?.status === 404 ? UNKNOWN_CLIENT : LOOKUP_FAILED })
        else
          setLookup({
            kind: 'found',
            client: { name: isString(name) ? name : 'Unnamed client', ...(isString(uri) ? { uri } : {}) },
          })
      })
      .catch(() => {
        // expected: the page shows `failed` as an alert in place of the question, and Allow stays off
        if (current) setLookup({ kind: 'failed', reason: LOOKUP_FAILED })
      })
    return () => {
      current = false
    }
  }, [clientId])
  return lookup
}

/** The opt-in for inspection, with what it adds; off until the owner turns it on. */
function InspectChoice({ on, onChange }: { readonly on: boolean; readonly onChange: (on: boolean) => void }) {
  return (
    <div className="flex flex-col gap-2">
      <label className="capability-row">
        <span className="capability-name">
          <span>Also let it read your conversations and runs</span>
          <span className="capability-detail">Off unless you turn it on. With it, the app can:</span>
        </span>
        <Switch checked={on} onCheckedChange={onChange} />
      </label>
      <ul className="plan-points" data-off={on ? undefined : true}>
        {INSPECT.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </div>
  )
}

/**
 * Ask the owner whether an MCP client may use goblin, saying what the requested scopes grant. Inspection, when asked
 * for, is a separate opt-in. Client-supplied names and URLs are shown as untrusted.
 */
export function Consent() {
  const query = new URLSearchParams(window.location.search)
  const clientId = query.get('client_id') ?? ''
  const requested = requestedScopes(query.get('scope'))
  const lookup = useClient(clientId)
  const client = lookup.kind === 'found' ? lookup.client : undefined
  const [inspect, setInspect] = useState(false)
  const [error, setError] = useState('')
  const [pending, setPending] = useState<'allow' | 'deny'>()
  async function decide(accept: boolean): Promise<void> {
    setPending(accept ? 'allow' : 'deny')
    setError('')
    const body = consentBody(requested, accept, inspect)
    const { data, error: failure } = await authClient.$fetch('/oauth2/consent', { method: 'POST', body })
    const next = redirectOf(data)
    if (failure || next === undefined) {
      setError(failure?.message ?? 'The authorization could not be completed.')
      setPending(undefined)
      return
    }
    window.location.assign(next)
  }
  return (
    <AuthShell
      size="lg"
      title={`Allow “${client?.name ?? '…'}” to use goblin?`}
      description={
        <>
          {client?.uri ? `It says it is ${client.uri}. ` : ''}The app supplies its own name and address; they are not
          verified.
        </>
      }
      footer={<p>Revoke it any time in Settings.</p>}
    >
      <div className="auth-body">
        <p>If you allow it, the app can:</p>
        <ul className="plan-points">
          {ASK.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        {requested.includes(INSPECT_SCOPE) && <InspectChoice on={inspect} onChange={setInspect} />}
        {(error || lookup.kind === 'failed') && (
          <Alert variant="destructive">
            <AlertDescription>{error || (lookup.kind === 'failed' && lookup.reason)}</AlertDescription>
          </Alert>
        )}
        <div className="card-actions">
          <Button
            size="lg"
            pending={pending === 'allow'}
            disabled={pending !== undefined || client === undefined}
            onClick={() => void decide(true)}
          >
            Allow
          </Button>
          <Button
            size="lg"
            variant="outline"
            pending={pending === 'deny'}
            disabled={pending !== undefined}
            onClick={() => void decide(false)}
          >
            Deny
          </Button>
        </div>
      </div>
    </AuthShell>
  )
}
