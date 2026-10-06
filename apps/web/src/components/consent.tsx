import { useEffect, useState } from 'react'
import { Alert, AlertDescription, Button } from '@purrable/ui'
import { isString, record } from '../lib/boundary.ts'
import { authClient, redirectOf } from '../lib/auth-client.ts'
import { AuthShell } from './auth-shell.tsx'

type ClientInfo = { readonly name: string; readonly uri?: string }

/** Ask the owner whether an MCP client may use Purrable. Client-supplied names and URLs are shown as untrusted. */
export function Consent() {
  const clientId = new URLSearchParams(window.location.search).get('client_id') ?? ''
  const [client, setClient] = useState<ClientInfo>()
  const [error, setError] = useState('')
  const [pending, setPending] = useState<'allow' | 'deny'>()
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
      title={`Allow “${client?.name ?? '…'}” to use Purrable?`}
      description={
        <>
          {client?.uri ? `It says it is ${client.uri}. ` : ''}The app supplies its own name and address; they are not
          verified.
        </>
      }
      footer={<p>It cannot read your main conversation. Revoke it any time in Settings.</p>}
    >
      <div className="auth-body">
        <p>If you allow it, the app can:</p>
        <ul className="plan-points">
          <li>ask your agent questions and give it tasks, in a separate conversation of its own;</li>
          <li>have your agent use the tools you allowed under Connections, while Work while you're away is on.</li>
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
