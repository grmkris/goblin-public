import { type ReactNode, createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from '@tanstack/react-router'
import { Schema } from 'effect'
import { MAIN_THREAD, ThreadView } from '@purrable/contracts'
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Input,
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@purrable/ui'
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  BotIcon,
  EllipsisIcon,
  MessageCircleIcon,
  MessageSquarePlusIcon,
  PanelLeftIcon,
  PencilIcon,
  SplitIcon,
} from 'lucide-react'
import { failureText, request } from '../lib/boundary.ts'
import { type ThreadNode, threadTitle, threadTree } from '../lib/threads.ts'

const decodeThreads = Schema.decodeUnknownSync(Schema.Array(ThreadView))
const decodeThread = Schema.decodeUnknownSync(ThreadView)

type ThreadChange = { readonly title?: string; readonly archived?: boolean }
type Threads = {
  readonly views: readonly ThreadView[]
  readonly error: string
  readonly refresh: () => void
  /** A thread branched from main at `from` (an entry id), or an empty one; the page moves to it. */
  readonly create: (from?: number) => Promise<void>
  readonly update: (id: string, change: ThreadChange) => Promise<void>
}

const ThreadsContext = createContext<Threads | undefined>(undefined)

/** The agent's conversations for every view of the chat: the list, the bar and the branch action share them. */
export function ThreadsProvider({ children }: { readonly children: ReactNode }) {
  const [views, setViews] = useState<readonly ThreadView[]>([])
  const [error, setError] = useState('')
  const navigate = useNavigate()
  const refresh = useCallback(() => {
    request('/api/threads')
      .then((data) => setViews(decodeThreads(data)))
      .catch((failure: unknown) => setError(failureText(failure)))
  }, [])
  useEffect(refresh, [refresh])
  const value = useMemo<Threads>(
    () => ({
      views,
      error,
      refresh,
      create: async (from) => {
        try {
          const view = decodeThread(await request('/api/threads', { body: from === undefined ? {} : { from } }))
          refresh()
          await navigate({ to: '/t/$threadId', params: { threadId: view.id } })
        } catch (failure) {
          setError(failureText(failure))
        }
      },
      update: async (id, change) => {
        try {
          await request(`/api/threads/${id}`, { method: 'PATCH', body: change })
          refresh()
        } catch (failure) {
          setError(failureText(failure))
        }
      },
    }),
    [views, error, refresh, navigate],
  )
  return <ThreadsContext.Provider value={value}>{children}</ThreadsContext.Provider>
}

export function useThreads(): Threads {
  const threads = useContext(ThreadsContext)
  if (threads === undefined) throw new Error('useThreads outside ThreadsProvider')
  return threads
}

function ThreadLink({
  view,
  current,
  onPick,
}: {
  readonly view: ThreadView
  readonly current: string
  readonly onPick: (() => void) | undefined
}) {
  const Icon = view.kind === 'main' ? MessageCircleIcon : view.kind === 'subagent' ? BotIcon : SplitIcon
  const body = (
    <>
      <Icon aria-hidden />
      <span className="truncate">{threadTitle(view)}</span>
      {view.busy && <span className="thread-busy" aria-label="Working" />}
    </>
  )
  const props = { className: 'thread-link', 'data-active': view.id === current || undefined, onClick: onPick }
  return view.id === MAIN_THREAD ? (
    <Link to="/" {...props}>
      {body}
    </Link>
  ) : (
    <Link to="/t/$threadId" params={{ threadId: view.id }} {...props}>
      {body}
    </Link>
  )
}

function ThreadItem({
  node,
  current,
  onPick,
}: {
  readonly node: ThreadNode
  readonly current: string
  readonly onPick: (() => void) | undefined
}) {
  return (
    <li>
      <ThreadLink view={node.thread} current={current} onPick={onPick} />
      {node.subagents.length > 0 && (
        <ul className="thread-children">
          {node.subagents.map((subagent) => (
            <li key={subagent.id}>
              <ThreadLink view={subagent} current={current} onPick={onPick} />
            </li>
          ))}
        </ul>
      )}
    </li>
  )
}

/** Main, then the threads newest first with their subagents, and the archived ones behind a toggle. */
export function ThreadList({ current, onPick }: { readonly current: string; readonly onPick?: () => void }) {
  const { views, create } = useThreads()
  const tree = useMemo(() => threadTree(views), [views])
  const [showArchived, setShowArchived] = useState(false)
  return (
    <nav className="thread-list" aria-label="Conversations">
      <Button variant="outline" onClick={() => void create()}>
        <MessageSquarePlusIcon data-icon="inline-start" />
        New thread
      </Button>
      <ul>
        {tree.main !== undefined && <ThreadItem node={tree.main} current={current} onPick={onPick} />}
        {tree.threads.map((node) => (
          <ThreadItem key={node.thread.id} node={node} current={current} onPick={onPick} />
        ))}
      </ul>
      {tree.archived.length > 0 && (
        <Button variant="ghost" size="sm" onClick={() => setShowArchived(!showArchived)}>
          {showArchived ? 'Hide archived' : `Archived (${tree.archived.length})`}
        </Button>
      )}
      {showArchived && (
        <ul>
          {tree.archived.map((view) => (
            <li key={view.id}>
              <ThreadLink view={view} current={current} onPick={onPick} />
            </li>
          ))}
        </ul>
      )}
    </nav>
  )
}

function RenameForm({ view, onDone }: { readonly view: ThreadView; readonly onDone: () => void }) {
  const { update } = useThreads()
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
      <Input name="title" defaultValue={view.title ?? ''} maxLength={120} aria-label="Thread name" autoFocus />
    </form>
  )
}

/**
 * The conversation's name under the header. On phones it opens the conversation list; on a thread it holds Rename and
 * Archive, and `actions` (sharing with main).
 */
export function ThreadBar({ thread, actions }: { readonly thread: string; readonly actions?: ReactNode }) {
  const { views, update } = useThreads()
  const view = views.find((candidate) => candidate.id === thread)
  const [listOpen, setListOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)
  return (
    <div className="thread-bar">
      <Sheet open={listOpen} onOpenChange={setListOpen}>
        <SheetTrigger
          render={<Button variant="ghost" size="icon-sm" className="md:hidden" aria-label="Conversations" />}
        >
          <PanelLeftIcon />
        </SheetTrigger>
        <SheetContent side="left">
          <SheetHeader>
            <SheetTitle>Conversations</SheetTitle>
          </SheetHeader>
          <ThreadList current={thread} onPick={() => setListOpen(false)} />
        </SheetContent>
      </Sheet>
      {renaming && view !== undefined ? (
        <RenameForm view={view} onDone={() => setRenaming(false)} />
      ) : (
        <h1 className="thread-title">{threadTitle(view)}</h1>
      )}
      {actions}
      {view !== undefined && view.kind !== 'main' && (
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Thread actions" />}>
            <EllipsisIcon />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => setRenaming(true)}>
              <PencilIcon aria-hidden />
              Rename
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => void update(view.id, { archived: !view.archived })}>
              {view.archived ? <ArchiveRestoreIcon aria-hidden /> : <ArchiveIcon aria-hidden />}
              {view.archived ? 'Unarchive' : 'Archive'}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  )
}
