import { useEffect, useState } from 'react'
import { Alert, AlertDescription, Button } from '@goblin/ui'
import { isString, record } from '../lib/boundary.ts'
import { authClient, redirectOf } from '../lib/auth-client.ts'
import { AuthShell } from './auth-shell.tsx'

type ClientInfo = { readonly name: string; readonly uri?: string }

/** What a consent grants, by the protected resource the client asked for (ADR 0024). */
type Grant = 'ask' | 'inspect' | 'operator'
const grantOf = (resources: readonly string[]): Grant => {
  const paths = resources.map((resource) => (URL.canParse(resource) ? new URL(resource).pathname : ''))
  if (paths.includes('/mcp/operator')) return 'operator'
  if (paths.includes('/mcp/inspect')) return 'inspect'
  return 'ask'
}
const READ_ONLY = 'It cannot send messages or change anything. Revoke it any time in Settings.'
const GRANTS: Readonly<
  Record<Grant, { readonly verb: string; readonly can: readonly string[]; readonly footer: string }>
> = {
  ask: {
    verb: 'use goblin',
    can: [
      'ask your agent questions and give it tasks in your main conversation, where its messages show its name;',
      'read the recent messages of your main conversation;',
      "have your agent use the tools you allowed under Connections, while Work while you're away is on.",
    ],
    footer: 'Revoke it any time in Settings.',
  },
  inspect: {
    verb: 'inspect your agent',
    can: [
      'read all your conversations in full, including tool calls and their results;',
      'read how each turn ran: model calls, tool calls, retries, errors and timings.',
    ],
    footer: READ_ONLY,
  },
  operator: {
    verb: "inspect any user's agent as an operator",
    can: [
      "read any user's conversations and runs, if your account is on this deployment's operator list;",
      'every read is recorded in your own agent.',
    ],
    footer: READ_ONLY,
  },
}

/** The client's registered name and address: untrusted, shown as the client's own claim. */
function useClient(clientId: string): ClientInfo | undefined {
  const [client, setClient] = useState<ClientInfo>()
  useEffect(() => {
    void authClient
      .$fetch('/oauth2/public-client', { method: 'GET', query: { client_id: clientId } })
      .then(({ data }) => {
        const info = record(data)
        const name = info?.client_name
        const uri = info?.client_uri
        setClient({ name: isString(name) ? name : 'Unnamed client', ...(isString(uri) ? { uri } : {}) })
      })
      .catch(() => setClient({ name: 'Unknown client' }))
  }, [clientId])
  return client
}

/**
 * Ask the owner whether an MCP client may use goblin, saying what the requested resource grants. Client-supplied
 * names and URLs are shown as untrusted.
 */
export function Consent() {
  const query = new URLSearchParams(window.location.search)
  const clientId = query.get('client_id') ?? ''
  const grant = GRANTS[grantOf(query.getAll('resource'))]
  const client = useClient(clientId)
  const [error, setError] = useState('')
  const [pending, setPending] = useState<'allow' | 'deny'>()
  async function decide(accept: boolean): Promise<void> {
    setPending(accept ? 'allow' : 'deny')
    setError('')
    const { data, error: failure } = await authClient.$fetch('/oauth2/consent', { method: 'POST', body: { accept } })
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
      title={`Allow “${client?.name ?? '…'}” to ${grant.verb}?`}
      description={
        <>
          {client?.uri ? `It says it is ${client.uri}. ` : ''}The app supplies its own name and address; they are not
          verified.
        </>
      }
      footer={<p>{grant.footer}</p>}
    >
      <div className="auth-body">
        <p>If you allow it, the app can:</p>
        <ul className="plan-points">
          {grant.can.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <div className="card-actions">
          <Button
            size="lg"
            pending={pending === 'allow'}
            disabled={pending !== undefined || !clientId}
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
