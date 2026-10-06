import { useEffect, useRef, useState } from 'react'
import type { HomeTile } from '@goblin/contracts'
import { Button, useMessageScroller } from '@goblin/ui'
import { ArrowUpRightIcon, MessageSquareIcon } from 'lucide-react'
import { appKey, conversationKey } from '../../lib/workspace.ts'
import { ToolMarkdown } from '../parts/tool-markdown.tsx'
import { useWorkspace } from '../workspace.tsx'
import { useWorkspaceFeed } from '../workspace-feed.tsx'
import { HomeAppTile } from './app-tile.tsx'

const STARTERS = ['Build me a reading list', 'Put my recent conversations on Home', 'Keep a note for today']

function RecentConversations() {
  const { conversations } = useWorkspaceFeed()
  const workspace = useWorkspace()
  const recent = conversations
    .filter((view) => view.kind !== 'main' && view.closedAt === undefined)
    .toSorted((a, b) => (b.lastReplyAt ?? b.createdAt) - (a.lastReplyAt ?? a.createdAt))
    .slice(0, 4)
  return (
    <div className="home-recent">
      {recent.length === 0 ? (
        <p>No conversations yet.</p>
      ) : (
        recent.map((view) => (
          <button
            key={view.id}
            type="button"
            onClick={() => workspace.open(conversationKey(view.id), 'beside', conversationKey('1'))}
          >
            <MessageSquareIcon aria-hidden />
            <span>{view.title ?? (view.kind === 'thread' ? 'Thread' : 'Helper')}</span>
            <ArrowUpRightIcon aria-hidden />
          </button>
        ))
      )}
    </div>
  )
}

function Tile({ tile }: { readonly tile: HomeTile }) {
  const { apps } = useWorkspaceFeed()
  const workspace = useWorkspace()
  const app = tile.kind === 'app' ? apps.find((each) => each.id === tile.appId) : undefined
  const title =
    tile.kind === 'note' ? tile.title : tile.kind === 'conversations' ? 'Recent conversations' : (app?.title ?? 'App')
  return (
    <article
      className="home-tile"
      data-home-tile={tile.id}
      data-size={tile.size}
      data-kind={tile.kind}
      aria-label={title}
    >
      <div className="home-tile-label">
        {app === undefined ? (
          title
        ) : (
          <button type="button" onClick={() => workspace.open(appKey(app.id), 'beside', conversationKey('1'))}>
            {title}
            <ArrowUpRightIcon aria-hidden />
          </button>
        )}
      </div>
      <div className="home-tile-body">
        {tile.kind === 'note' ? (
          <ToolMarkdown text={tile.markdown} />
        ) : tile.kind === 'conversations' ? (
          <RecentConversations />
        ) : app === undefined ? (
          <p className="text-muted-foreground">App unavailable</p>
        ) : (
          <HomeAppTile app={app} />
        )}
      </div>
    </article>
  )
}

/** Main's fixed-geometry glance surface, after the newest transcript row and before the dock. */
export function HomeSurface({ onDraft }: { readonly onDraft: (text: string) => void }) {
  const { home } = useWorkspaceFeed()
  const root = useRef<HTMLElement>(null)
  const { scrollToEnd } = useMessageScroller()
  const [editing, setEditing] = useState(false)
  useEffect(() => {
    const show = (event: Event) => {
      scrollToEnd({
        behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
      })
      if (!(event instanceof CustomEvent) || !Array.isArray(event.detail)) return
      const ids: unknown[] = event.detail
      for (const tile of root.current?.querySelectorAll<HTMLElement>('[data-home-tile]') ?? []) {
        if (ids.includes(tile.dataset.homeTile))
          tile.animate([{ boxShadow: '0 0 0 2px var(--ring)' }, { boxShadow: '0 0 0 0px transparent' }], {
            duration: 900,
          })
      }
    }
    window.addEventListener('goblin-home-show', show)
    return () => window.removeEventListener('goblin-home-show', show)
  }, [scrollToEnd])
  const tiles = home?.tiles ?? []
  const today = new Date()
  const date = new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long' }).format(today)
  const narrowDate = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short' }).format(
    today,
  )
  return (
    <section className="home-surface" aria-label="Home" ref={root} data-editing={editing || undefined}>
      <header className="home-header">
        <h2>
          Home <span className="home-date-wide">· {date}</span>
          <span className="home-date-narrow">· {narrowDate}</span>
        </h2>
        <Button
          variant="ghost"
          size="sm"
          aria-label="Edit Home"
          aria-pressed={editing}
          onClick={() => setEditing(!editing)}
        >
          {editing ? 'Done' : 'Edit'}
        </Button>
      </header>
      {tiles.length === 0 ? (
        <div className="home-starters">
          {STARTERS.map((text) => (
            <button key={text} type="button" onClick={() => onDraft(text)}>
              {text}
              <ArrowUpRightIcon aria-hidden />
            </button>
          ))}
        </div>
      ) : (
        <div className="home-grid">
          {tiles.map((tile) => (
            <Tile key={tile.id} tile={tile} />
          ))}
        </div>
      )}
    </section>
  )
}
