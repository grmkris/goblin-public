import { type ReactNode, useState } from 'react'
import type { ConversationView } from '@purrable/contracts'
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Input,
  SidebarTrigger,
  TopBar,
  TopBarTitle,
} from '@purrable/ui'
import { EllipsisIcon, PencilIcon, RotateCcwIcon, XIcon } from 'lucide-react'
import { isClosed, threadTitle } from '../lib/threads.ts'
import { useWorkspaceFeed } from './workspace-feed.tsx'

function RenameForm({ view, onDone }: { readonly view: ConversationView; readonly onDone: () => void }) {
  const { update } = useWorkspaceFeed()
  return (
    <form
      className="thread-rename"
      onSubmit={(event) => {
        event.preventDefault()
        const value = new FormData(event.currentTarget).get('title')
        const title = typeof value === 'string' ? value.trim() : ''
        if (title !== '') void update(view.id, { title }).then(onDone)
        else onDone()
      }}
    >
      <Input
        name="title"
        defaultValue={view.title ?? ''}
        maxLength={120}
        aria-label="Thread name"
        autoFocus
        onBlur={onDone}
        onKeyDown={(event) => event.key === 'Escape' && onDone()}
      />
    </form>
  )
}

/**
 * Rename and Close for a thread or subagent (main keeps its name and never closes). Close stops it and everything under
 * it; a closed one stays readable and reopens.
 */
function ThreadMenu({ view, onRename }: { readonly view: ConversationView; readonly onRename: () => void }) {
  const { update } = useWorkspaceFeed()
  const closed = isClosed(view)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Thread actions" />}>
        <EllipsisIcon />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={onRename}>
          <PencilIcon aria-hidden />
          Rename
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => void update(view.id, { closed: !closed })}>
          {closed ? <RotateCcwIcon aria-hidden /> : <XIcon aria-hidden />}
          {closed ? 'Reopen' : 'Close'}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * The chat's top bar, floating over the transcript: the sidebar toggle, the conversation's name (or the rename field),
 * `actions` (sharing with main), and the thread's menu.
 */
export function ChatBar({ thread, actions }: { readonly thread: string; readonly actions?: ReactNode }) {
  const { conversations } = useWorkspaceFeed()
  const view = conversations.find((candidate) => candidate.id === thread)
  const [renaming, setRenaming] = useState(false)
  return (
    <TopBar floating>
      <SidebarTrigger />
      {renaming && view !== undefined ? (
        <RenameForm view={view} onDone={() => setRenaming(false)} />
      ) : (
        <TopBarTitle>{threadTitle(view)}</TopBarTitle>
      )}
      {actions}
      {view !== undefined && view.kind !== 'main' && <ThreadMenu view={view} onRename={() => setRenaming(true)} />}
    </TopBar>
  )
}
