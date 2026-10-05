import { useState } from 'react'
import { Button, Input } from '@purrable/ui'
import { request, failureText } from '../lib/boundary.ts'

/** A viewer can ask the owner for permission without starting an agent turn. */
export function MemberAccessRequest() {
  const [message, setMessage] = useState('')
  const [pending, setPending] = useState(false)
  const [notice, setNotice] = useState('')
  const [operationId, setOperationId] = useState(() => crypto.randomUUID())
  async function send() {
    setPending(true)
    try {
      await request('/api/access-requests', { body: { message, operationId } })
      setNotice('Your request was sent to the owner.')
      setMessage('')
      setOperationId(crypto.randomUUID())
    } catch (cause) {
      setNotice(failureText(cause))
    } finally {
      setPending(false)
    }
  }
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        void send()
      }}
      className="flex flex-col gap-2"
    >
      <Input
        aria-label="Access request"
        placeholder="What permission do you need?"
        required
        maxLength={2000}
        value={message}
        disabled={pending}
        onChange={(event) => {
          setMessage(event.target.value)
          setOperationId(crypto.randomUUID())
        }}
      />
      <Button variant="outline" disabled={pending}>
        Request access
      </Button>
      {notice && <p role="status">{notice}</p>}
    </form>
  )
}
