import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
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
import { messageOf, withRef } from '../../lib/query/app-error.ts'
import { reportUnexpected } from '../../lib/unexpected.ts'
import { createWorkspaceTopicMutation, updateWorkspaceTopicMutation } from '../../lib/workspace/mutations.ts'

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
  const navigate = useNavigate()
  const create = useMutation(createWorkspaceTopicMutation)
  const rename = useMutation(updateWorkspaceTopicMutation)
  const [name, setName] = useState(topic?.name ?? '')
  const [operation] = useState(() => crypto.randomUUID())
  const pending = create.isPending || rename.isPending
  // expected: the dialog stays open and shows the refusal (a name in use) under the name
  const failure = topic === undefined ? create.error : rename.error
  const error = failure === null ? '' : refusal(failure, topic === undefined ? 'create the topic' : 'rename the topic')
  function submit(): void {
    const trimmed = name.trim()
    if (trimmed === '' || pending) return
    if (topic === undefined)
      create.mutate(
        { name: trimmed, operationId: operation },
        {
          onSuccess: (created) => {
            onOpenChange(false)
            navigate({ to: '/c/$chatId', params: { chatId: created.conversation } }).catch(reportUnexpected)
          },
        },
      )
    else rename.mutate({ id: topic.id, change: { name: trimmed } }, { onSuccess: () => onOpenChange(false) })
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(26rem,calc(100vw-2rem))]">
        <DialogTitle>{topic === undefined ? 'New topic' : 'Rename topic'}</DialogTitle>
        <form
          className="mt-4 flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            submit()
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
