import { useEffect, useRef, useState } from 'react'
import type { HomeTile, HomeOperation } from '@goblin/contracts'
import { Button, useMessageScroller } from '@goblin/ui'
import { ArrowUpRightIcon, MessageSquareIcon, GripVerticalIcon, XIcon } from 'lucide-react'
import { appKey, conversationKey } from '../../lib/workspace.ts'
import { MessageText } from '../parts/text-part.tsx'
import { useWorkspace } from '../workspace.tsx'
import { useWorkspaceFeed } from '../workspace-feed.tsx'
import { HomeAppTile } from './app-tile.tsx'
import { useAppHost } from '../apps/host.tsx'
import { useHomeEdit } from './edit.ts'
import { HomeTileMenu } from './tile-menu.tsx'
import { useHomeDrag } from './drag.ts'
import { useHomeMotion } from './motion.ts'

const STARTERS = ['Track my reading on Home', 'Chart my spending this month on Home', 'Put my inbox on Home']
const TILE_DRAFT = 'Add a tile to Home that '

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

type TileControls = {
  readonly editing: boolean
  readonly index: number
  readonly count: number
  readonly owner: ReturnType<typeof useHomeEdit>
  readonly drag: ReturnType<typeof useHomeDrag>
}
function Tile({ tile, controls }: { readonly tile: HomeTile; readonly controls: TileControls }) {
  const { apps } = useWorkspaceFeed()
  const workspace = useWorkspace()
  const host = useAppHost()
  const app = tile.kind === 'app' ? apps.find((each) => each.id === tile.appId) : undefined
  const title =
    tile.kind === 'note' ? tile.title : tile.kind === 'conversations' ? 'Recent conversations' : (app?.title ?? 'App')
  const open = () =>
    app === undefined
      ? document.querySelector<HTMLElement>(`[data-home-tile="${tile.id}"]`)?.focus()
      : workspace.open(appKey(app.id), 'beside', conversationKey('1'))
  return (
    <article
      className="home-tile"
      data-home-tile={tile.id}
      data-size={tile.size}
      data-kind={tile.kind}
      aria-label={title}
      tabIndex={-1}
    >
      <div className="home-tile-label">
        {controls.editing && (
          <span className="home-drag-handle">
            <Button
              variant="ghost"
              size="icon-xs"

              aria-label={`Move ${title}`}
              disabled={controls.owner.pending}
              onPointerDown={(event) => controls.drag.start(event, tile.id)}
              onPointerMove={controls.drag.move}
              onPointerUp={controls.drag.end}
              onPointerCancel={controls.drag.end}
            >
              <GripVerticalIcon aria-hidden />
            </Button>
          </span>
        )}
        {app === undefined ? (
          title
        ) : (
          <button type="button" onClick={open}>
            {title}
            <ArrowUpRightIcon aria-hidden />
          </button>
        )}
        <span className="home-tile-actions">
          <HomeTileMenu
            tile={tile}
            index={controls.index}
            count={controls.count}
            pending={controls.owner.pending}
            edit={controls.owner.edit}
            open={open}
            {...(app === undefined ? {} : { close: () => host.close(app.id) })}
          />
          {controls.editing && (
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={`Remove ${title}`}
              disabled={controls.owner.pending}
              onClick={() => void controls.owner.edit([{ kind: 'remove', id: tile.id }])}
            >
              <XIcon aria-hidden />
            </Button>
          )}
        </span>
      </div>
      <div className="home-tile-body">
        <TileBody tile={tile} app={app} />
      </div>
    </article>
  )
}

function TileBody({
  tile,
  app,
}: {
  readonly tile: HomeTile
  readonly app: import('@goblin/contracts').AppView | undefined
}) {
  if (tile.kind === 'note') return <MessageText text={tile.markdown} figures />
  if (tile.kind === 'conversations') return <RecentConversations />
  if (app === undefined) return <p className="text-muted-foreground">App unavailable</p>
  return <HomeAppTile app={app} />
}

function useShowHome(root: import('react').RefObject<HTMLElement | null>) {
  const { scrollToEnd } = useMessageScroller()
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
}

function HomeHeader({
  editing,
  onEdit,
  onDraft,
}: {
  readonly editing: boolean
  readonly onEdit: () => void
  readonly onDraft: (text: string) => void
}) {
  const today = new Date()
  const date = new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long' }).format(today)
  const narrowDate = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short' }).format(
    today,
  )
  return (
    <header className="home-header">
      <h2>
        Home <span className="home-date-wide">· {date}</span>
        <span className="home-date-narrow">· {narrowDate}</span>
      </h2>
      <div className="home-header-actions">
        <Button variant="ghost" size="sm" onClick={() => onDraft(TILE_DRAFT)}>
          Ask for a tile
        </Button>
        <Button variant="ghost" size="sm" aria-label="Edit Home" aria-pressed={editing} onClick={onEdit}>
          {editing ? 'Done' : 'Edit'}
        </Button>
      </div>
    </header>
  )
}

function HomeStarters({ onDraft }: { readonly onDraft: (text: string) => void }) {
  return (
    <div className="home-empty">
      <p>Your agent can build tiles: trackers, charts, your inbox. Ask it.</p>
      <div className="home-starters">
        {STARTERS.map((text) => (
          <button key={text} type="button" onClick={() => onDraft(text)}>
            {text}
            <ArrowUpRightIcon aria-hidden />
          </button>
        ))}
      </div>
    </div>
  )
}

/** Main's fixed-geometry glance surface, after the newest transcript row and before the dock. */
export function HomeSurface({ onDraft }: { readonly onDraft: (text: string) => void }) {
  const { home } = useWorkspaceFeed()
  const host = useAppHost()
  const owner = useHomeEdit()
  const root = useRef<HTMLElement>(null)
  const [editing, setEditing] = useState(false)
  useShowHome(root)
  const tiles = home?.tiles ?? []
  const motion = useHomeMotion(root, tiles)
  const edit = (ops: readonly HomeOperation[]) => {
    motion.remember()
    return owner.edit(ops)
  }
  const drag = useHomeDrag(root, edit, home?.revision)
  useEffect(host.kick, [editing, host.kick])
  return (
    <section className="home-surface" aria-label="Home" ref={root} data-editing={editing || undefined}>
      <HomeHeader editing={editing} onEdit={() => setEditing(!editing)} onDraft={onDraft} />
      {owner.notice && (
        <p role="status" className="text-sm text-destructive">
          {owner.notice}
        </p>
      )}
      {tiles.length === 0 ? (
        <HomeStarters onDraft={onDraft} />
      ) : (
        <div className="home-grid">
          {tiles.map((tile, index) => (
            <Tile
              key={tile.id}
              tile={tile}
              controls={{
                editing,
                index,
                count: tiles.length,
                owner: { ...owner, edit },
                drag: {
                  ...drag,
                  start: (event, id) => {
                    motion.cancel(id)
                    drag.start(event, id)
                  },
                },
              }}
            />
          ))}
          {editing && (
            <button
              type="button"
              className="home-tile home-tile-request"
              data-size="medium"
              onClick={() => onDraft(TILE_DRAFT)}
            >
              Ask for a tile
              <span>Your agent can build it for you.</span>
            </button>
          )}
        </div>
      )}
    </section>
  )
}
