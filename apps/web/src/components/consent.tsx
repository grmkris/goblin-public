import { useEffect, useState } from 'react'
import {
  Alert,
  AlertDescription,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@purrable/ui'
import { isString, record } from '../lib/boundary.ts'
import { authClient, redirectOf } from '../lib/auth-client.ts'

type ClientInfo = { readonly name: string; readonly uri?: string }

/** Ask the owner whether an MCP client may use Purrable. Client-supplied names and URLs are shown as untrusted. */
export function Consent() {
  const clientId = new URLSearchParams(window.location.search).get('client_id') ?? ''
  const [client, setClient] = useState<ClientInfo>()
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)
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
    setPending(true)
    setError('')
    const { data, error: failure } = await authClient.$fetch('/oauth2/consent', { method: 'POST', body: { accept } })
    const next = redirectOf(data)
    if (failure || next === undefined) {
      setError(failure?.message ?? 'The authorization could not be completed.')
      setPending(false)
      return
    }
    window.location.assign(next)
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>Allow this app to use Purrable?</CardTitle>
        <CardDescription>
          “{client?.name ?? '…'}”{client?.uri ? ` (${client.uri})` : ''} wants to connect to your resident agent. The
          name and address are supplied by the app itself and are not verified.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-3">
          <p>If you allow it, the app can:</p>
          <ul className="list">
            <li>ask your agent questions and give it tasks, in a separate conversation of its own;</li>
            <li>have your agent use the tools you enabled under Connections while resident authority is on.</li>
          </ul>
          <p className="text-muted-foreground text-sm">
            It cannot read your main conversation. Revoke it any time in Settings.
          </p>
        </div>
      </CardContent>
      <CardFooter>
        <div className="flex flex-col items-stretch gap-3">
          <div className="flex gap-2">
            <Button disabled={pending || !clientId} onClick={() => void decide(true)}>
              Allow
            </Button>
            <Button variant="outline" disabled={pending} onClick={() => void decide(false)}>
              Deny
            </Button>
          </div>
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </div>
      </CardFooter>
    </Card>
  )
}
