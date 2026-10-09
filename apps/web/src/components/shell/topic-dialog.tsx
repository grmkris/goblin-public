import { useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import type { TopicView } from '@goblin/contracts'
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
  Field,
  FieldError,
  FieldLabel,
  Input,
} from '@goblin/ui'
import { Conflict, NotFound } from '@goblin/contracts/api'
import { messageOf } from '../../lib/query/app-error.ts'
import { withRef } from '../../lib/refusal.ts'
import { reportUnexpected } from '../../lib/unexpected.ts'
import { useOrganize } from './organize.ts'

/** What the owner reads when a Topic could not be named so. */
function refusal(failure: unknown, action: string): string {
  if (failure instanceof Conflict && failure.reason === 'topic_name_taken')
    return withRef('A topic already has that name.', failure)
  if (failure instanceof NotFound) return withRef('There is no such Topic.', failure)
  return messageOf(failure, action)
}

/**
 * A Topic's name: a new Topic (which then opens its channel), or a new name for `topic`. One operation id per opening,
 * so a retry finds the Topic the first try made.
 */
export function TopicDialog({
  open,
  onOpenChange,
  topic,
}: {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  /** The Topic to rename; without one, a new Topic. */
  readonly topic?: TopicView
}) {
  const organize = useOrganize()
  const navigate = useNavigate()
  const [name, setName] = useState(topic?.name ?? '')
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)
  const [operation] = useState(() => crypto.randomUUID())
  async function submit(): Promise<void> {
    const trimmed = name.trim()
    if (trimmed === '' || pending) return
    setPending(true)
    setError('')
    try {
      if (topic === undefined) {
        const created = await organize.createTopic(trimmed, operation)
        onOpenChange(false)
        navigate({ to: '/c/$chatId', params: { chatId: created.conversation } }).catch(reportUnexpected)
      } else {
        await organize.updateTopic(topic.id, { name: trimmed })
        onOpenChange(false)
      }
    } catch (failure) {
      // expected: the dialog stays open and shows the refusal (a name in use) under the name
      setError(refusal(failure, topic === undefined ? 'create the topic' : 'rename the topic'))
    } finally {
      setPending(false)
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(26rem,calc(100vw-2rem))]">
        <DialogTitle>{topic === undefined ? 'New topic' : 'Rename topic'}</DialogTitle>
        <form
          className="mt-4 flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            submit().catch(reportUnexpected)
          }}
        >
          <Field data-invalid={error !== '' || undefined}>
            <FieldLabel htmlFor="topic-name">Name</FieldLabel>
            <Input
              id="topic-name"
              value={name}
              maxLength={80}
              autoComplete="off"
              autoFocus
              placeholder="e.g. Japan trip"
              aria-invalid={error !== '' || undefined}
              onChange={(event) => setName(event.target.value)}
            />
            {error !== '' && <FieldError>{error}</FieldError>}
          </Field>
          <div className="flex justify-end gap-2">
            <DialogClose render={<Button type="button" variant="ghost" />}>Cancel</DialogClose>
            <Button type="submit" pending={pending} disabled={name.trim() === ''}>
              {topic === undefined ? 'Create' : 'Rename'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
