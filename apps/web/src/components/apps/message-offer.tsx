import { useRef, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { MessageCircleIcon } from 'lucide-react'
import { Button } from '@goblin/ui'
import { type QuestionAnswerReceipt, answerContinuation, receiptOperationId } from '../../lib/app-message.ts'
import { messageOf } from '../../lib/query/app-error.ts'
import { submitMutation } from '../../conversations/queries.ts'
import { messageBody } from '../use-conversation.ts'

/** The host's own Continue click starts the conversation; saving in MyPlan is already complete. */
export function MessageOffer({
  app,
  conversation,
  connectionId,
  resourceUri,
  receipt,
  onDone,
}: {
  readonly app: string
  readonly conversation: string
  readonly connectionId: string
  readonly resourceUri: string
  readonly receipt: QuestionAnswerReceipt
  readonly onDone: () => void
}) {
  const submit = useMutation(submitMutation).mutateAsync
  const sending = useRef(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function continueConversation(): Promise<void> {
    if (sending.current) return
    sending.current = true
    setBusy(true)
    setError('')
    try {
      const operationId = await receiptOperationId(app, receipt)
      const { input, appContext } = answerContinuation(app, connectionId, resourceUri, receipt)
      await submit({ id: conversation, message: messageBody(input, operationId, { appContext }) })
      onDone()
    } catch (cause) {
      setError(messageOf(cause, 'continue the conversation'))
    } finally {
      sending.current = false
      setBusy(false)
    }
  }
  return (
    <div className="app-offer" role="status" aria-label="Continue after MyPlan answer">
      <MessageCircleIcon aria-hidden />
      <span className="truncate">
        {connectionId} reports a saved answer. Continue in this app's conversation?
        {error && <span role="alert"> {error}</span>}
      </span>
      <Button size="app-action" disabled={busy} onClick={() => void continueConversation()}>
        Continue
      </Button>
      <Button variant="ghost" size="app-action" disabled={busy} onClick={onDone}>
        Dismiss
      </Button>
    </div>
  )
}
