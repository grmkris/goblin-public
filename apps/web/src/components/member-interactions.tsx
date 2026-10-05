import { useEffect, useState } from 'react'
import { Schema } from 'effect'
import { Button, Card, CardHeader, CardTitle, CardContent, Input } from '@purrable/ui'
import { request, failureText } from '../lib/boundary.ts'
const Items = Schema.Array(
  Schema.Struct({
    id: Schema.String,
    session: Schema.String,
    kind: Schema.String,
    requesterUserId: Schema.String,
    requestHash: Schema.String,
    expiresAt: Schema.Number,
    intent: Schema.Unknown,
  }),
)
type Item = (typeof Items.Type)[number]
function Decision({ item, refresh }: { readonly item: Item; readonly refresh: () => void }) {
  const [answer, setAnswer] = useState('')
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)
  const [operationId] = useState(() => crypto.randomUUID())
  async function send(input: string) {
    setPending(true)
    try {
      await request(`/api/interactions/${encodeURIComponent(item.id)}/answer`, {
        body: { operationId, requestHash: item.requestHash, input },
      })
      refresh()
    } catch (cause) {
      setError(failureText(cause))
    } finally {
      setPending(false)
    }
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>{item.kind === 'question' ? 'Question for you' : 'Member approval request'}</CardTitle>
      </CardHeader>
      <CardContent>
        <p>
          From member {item.requesterUserId} · conversation {item.session}
        </p>
        <pre className="whitespace-pre-wrap break-words text-sm">{JSON.stringify(item.intent, null, 2)}</pre>
        {error && <p role="alert">{error}</p>}
        {item.kind === 'question' ? (
          <form
            onSubmit={(event) => {
              event.preventDefault()
              void send(answer)
            }}
          >
            <Input
              aria-label="Your answer"
              value={answer}
              onChange={(event) => setAnswer(event.target.value)}
              required
              maxLength={20000}
            />
            <Button disabled={pending}>Answer</Button>
          </form>
        ) : (
          <div className="flex gap-2">
            <Button variant="outline" disabled={pending} onClick={() => void send('deny')}>
              Deny
            </Button>
            <Button disabled={pending} onClick={() => void send('allow_once')}>
              Allow once
            </Button>
            <p>
              Existing grants and current member permissions must allow this exact action. Change permissions in
              Settings first if needed.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
/** Durable inbox comes only from the designated-answerer endpoint, never model-authored labels. */
export function MemberInteractionCards() {
  const [items, setItems] = useState<typeof Items.Type>([])
  const [error, setError] = useState('')
  const refresh = () => {
    void request('/api/interactions')
      .then((value) => setItems(Schema.decodeUnknownSync(Items)(value)))
      .catch((cause: unknown) => setError(failureText(cause)))
  }
  useEffect(() => {
    refresh()
    const timer = setInterval(refresh, 5000)
    return () => clearInterval(timer)
  }, [])
  return (
    <div className="flex flex-col gap-3">
      {error && <p role="alert">{error}</p>}
      {items.map((item) => (
        <Decision key={item.id} item={item} refresh={refresh} />
      ))}
    </div>
  )
}
