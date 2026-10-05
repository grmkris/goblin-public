import { useEffect, useState } from 'react'
import { Schema } from 'effect'
import { Button, Card, CardHeader, CardTitle, CardContent } from '@purrable/ui'
import { QuestionSpec } from '@purrable/contracts'
import { QuestionCard } from './interaction-cards.tsx'
import { request, failureText } from '../lib/boundary.ts'
const Items = Schema.Array(
  Schema.Struct({
    id: Schema.String,
    session: Schema.String,
    kind: Schema.Literals(['question', 'approval', 'access']),
    requesterUserId: Schema.String,
    requestHash: Schema.String,
    expiresAt: Schema.Number,
    intent: Schema.Struct({
      questions: Schema.optional(Schema.Array(QuestionSpec)),
      message: Schema.optional(Schema.String),
      tool: Schema.optional(Schema.Struct({ serverId: Schema.String, name: Schema.String, arguments: Schema.Unknown })),
    }),
  }),
)
type Item = (typeof Items.Type)[number]
function Decision({ item, refresh }: { readonly item: Item; readonly refresh: () => void }) {
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)
  const [operationId] = useState(() => crypto.randomUUID())
  async function send(input: string): Promise<boolean> {
    setPending(true)
    try {
      await request(`/api/interactions/${encodeURIComponent(item.id)}/answer`, {
        body: { operationId, requestHash: item.requestHash, input },
      })
      refresh()
      return true
    } catch (cause) {
      setError(failureText(cause))
      return false
    } finally {
      setPending(false)
    }
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          {item.kind === 'question'
            ? 'Question for you'
            : item.kind === 'access'
              ? 'Access request'
              : 'Member approval request'}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p>
          From member {item.requesterUserId} · conversation {item.session}
        </p>
        {error && <p role="alert">{error}</p>}
        {item.kind === 'question' ? (
          <fieldset disabled={pending}>
            <QuestionCard
              interaction={{ kind: 'question', callId: item.id, questions: item.intent.questions ?? [] }}
              onAnswer={send}
            />
          </fieldset>
        ) : (
          <div className="flex flex-col gap-2">
            {item.intent.message && <p>{item.intent.message}</p>}
            {item.intent.tool && (
              <div>
                <p>
                  {item.intent.tool.serverId} · {item.intent.tool.name}
                </p>
                <pre className="whitespace-pre-wrap break-words text-sm">
                  {JSON.stringify(item.intent.tool.arguments, null, 2)}
                </pre>
              </div>
            )}
            <div className="flex gap-2">
              <Button variant="outline" disabled={pending} onClick={() => void send('deny')}>
                Deny
              </Button>
              <Button
                disabled={pending}
                onClick={() => void send(item.kind === 'access' ? 'acknowledge' : 'allow_once')}
              >
                {item.kind === 'access' ? 'Acknowledge' : 'Allow once'}
              </Button>
            </div>
            <p>
              {item.kind === 'access'
                ? 'Acknowledging records your response. Change their role or permissions in Members settings.'
                : 'Existing grants and current member permissions must allow this exact action. Change permissions in Settings first if needed.'}
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
