import { useState } from 'react'
import type { TopicView } from '@goblin/contracts'
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@goblin/ui'
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  ChevronDownIcon,
  EyeOffIcon,
  HashIcon,
  PencilIcon,
  SearchIcon,
} from 'lucide-react'
import { failureText } from '../../lib/boundary.ts'
import { isArchived } from '../../lib/topics.ts'
import { useWorkspaceFeed } from '../workspace-feed.tsx'
import { useOrganize } from './organize.ts'
import { TopicDialog } from './topic-dialog.tsx'

/** The channel's name as its bar shows it: `#` and the Topic's name, with a pulse while its agent works. */
function ChannelName({ name, working }: { readonly name: string; readonly working: boolean }) {
  return (
    <span className="channel-title">
      <HashIcon aria-hidden />
      <span className="truncate">{name}</span>
      {working && <span className="thread-busy" aria-label="Working" />}
    </span>
  )
}

/**
 * The channel's name, and on a server with Topics its menu, as Slack's channel header has: rename, keep the Topic out of
 * automatic search or let it back in, and archive it or restore it (never Personal). A failure shows under the bar.
 */
export function ChannelMenu({
  topic,
  name,
  working,
  onFailure,
}: {
  readonly topic: TopicView | undefined
  readonly name: string
  readonly working: boolean
  readonly onFailure: (text: string) => void
}) {
  const feed = useWorkspaceFeed()
  const organize = useOrganize()
  const [renaming, setRenaming] = useState(false)
  if (topic === undefined || feed.topics === undefined) return <ChannelName name={name} working={working} />
  const change = (patch: Parameters<typeof organize.updateTopic>[1]) =>
    void organize.updateTopic(topic.id, patch).catch((failure: unknown) => onFailure(failureText(failure)))
  const archived = isArchived(topic)
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="ghost" aria-label={`#${name}: topic actions`} />}>
          <ChannelName name={name} working={working} />
          <ChevronDownIcon data-icon="inline-end" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuItem onClick={() => setRenaming(true)}>
            <PencilIcon aria-hidden />
            Rename
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => change({ searchExcluded: !topic.searchExcluded })}>
            {topic.searchExcluded ? <SearchIcon aria-hidden /> : <EyeOffIcon aria-hidden />}
            {topic.searchExcluded ? 'Include in search' : 'Exclude from search'}
          </DropdownMenuItem>
          {topic.personal !== true && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => change({ archived: !archived })}>
                {archived ? <ArchiveRestoreIcon aria-hidden /> : <ArchiveIcon aria-hidden />}
                {archived ? 'Restore topic' : 'Archive topic'}
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {renaming && <TopicDialog open onOpenChange={setRenaming} topic={topic} />}
    </>
  )
}

/**
 * In place of an archived Topic's composer: it is archived, and Restore brings it back to the sidebar and to search.
 * Nothing that was stopped starts again on its own.
 */
export function ArchivedBanner({
  topic,
  onFailure,
}: {
  readonly topic: TopicView
  readonly onFailure: (text: string) => void
}) {
  const organize = useOrganize()
  const [pending, setPending] = useState(false)
  return (
    <div className="chat-dock">
      <div className="chat-closed" role="status">
        <span>#{topic.name} is archived.</span>
        <Button
          variant="outline"
          size="sm"
          pending={pending}
          onClick={() => {
            setPending(true)
            organize
              .updateTopic(topic.id, { archived: false })
              .catch((failure: unknown) => onFailure(failureText(failure)))
              .finally(() => setPending(false))
          }}
        >
          <ArchiveRestoreIcon data-icon="inline-start" />
          Restore
        </Button>
      </div>
    </div>
  )
}
