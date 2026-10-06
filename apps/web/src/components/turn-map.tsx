import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
  useMediaQuery,
  useMessageScroller,
} from '@goblin/ui'
import { HistoryIcon, ListIcon } from 'lucide-react'
import { type RefObject, useCallback, useEffect, useRef, useState } from 'react'
import { currentTurn, markPositions, viewportBand } from '../lib/turn-map.ts'

/** One turn the owner took, as the map lists it. */
export type Turn = { readonly id: string; readonly label: string; readonly telegram: boolean }

/** The scroller keeps this much of the previous turn above a turn it pins (`scrollPreviousItemPeek`). */
const PEEK = 64
/** A mark's thickness and the rail's width, in px. */
const MARK = 2
const WIDTH = 20
/** The rail and its hover list, for a fine pointer with room in the gutter; otherwise an edge tab and a sheet. */
const RAIL_QUERY = '(hover: hover) and (pointer: fine) and (min-width: 48rem)'

/** Where the turns are in the transcript: tops and content height without the tail spacer, and the reading line. */
type Layout = { readonly offsets: readonly number[]; readonly height: number; readonly line: number }
type Geometry = Layout & { readonly shown: boolean; readonly current: number }
const NOWHERE: Geometry = { offsets: [], height: 0, line: 0, shown: false, current: -1 }

function measure(viewport: HTMLElement, ids: ReadonlySet<string>): Layout | undefined {
  const content = viewport.querySelector<HTMLElement>('[data-slot="message-scroller-content"]')
  if (content === null) return undefined
  const origin = viewport.getBoundingClientRect().top - viewport.scrollTop
  const offsets: number[] = []
  let bottom = 0
  for (const child of content.children) {
    if (!(child instanceof HTMLElement) || child.hasAttribute('data-message-scroller-spacer')) continue
    const box = child.getBoundingClientRect()
    bottom = Math.max(bottom, box.bottom - origin)
    if (ids.has(child.dataset.messageId ?? '')) offsets.push(Math.round(box.top - origin))
  }
  const style = getComputedStyle(content)
  // A turn the scroller jumps to sits at the content's top padding; one it pins as it arrives, a peek lower.
  const line = Number.parseFloat(style.paddingTop) + PEEK + 0.5
  return { offsets, height: Math.round(bottom + Number.parseFloat(style.paddingBottom)), line }
}

const sameLayout = (a: Geometry, b: Layout, shown: boolean): boolean =>
  a.shown === shown &&
  a.height === b.height &&
  a.line === b.line &&
  a.offsets.length === b.offsets.length &&
  a.offsets.every((offset, index) => offset === b.offsets[index])

/**
 * Follows the transcript in `viewport`: where the turns `ids` are (re-measured when its content changes size or rows),
 * which is being read (on scroll), and the band for what is on screen, written to `band` without a render.
 */
function useTurnGeometry(
  viewport: RefObject<HTMLDivElement | null>,
  ids: string,
  band: RefObject<SVGRectElement | null>,
  track: number,
): Geometry {
  const [geometry, setGeometry] = useState(NOWHERE)
  const layout = useRef<Layout | undefined>(undefined)
  const trackRef = useRef(track)
  const scrolled = useCallback(() => {
    const element = viewport.current
    const current = layout.current
    if (element === null || current === undefined) return
    const { scrollTop, clientHeight } = element
    const turn = currentTurn(current.offsets, scrollTop + current.line, scrollTop + clientHeight >= current.height - 2)
    setGeometry((shown) => (shown.current === turn ? shown : { ...shown, current: turn }))
    const { top, size } = viewportBand(scrollTop, clientHeight, current.height, trackRef.current)
    band.current?.setAttribute('y', String(top))
    band.current?.setAttribute('height', String(size))
  }, [viewport, band])
  useEffect(() => {
    trackRef.current = track
    scrolled()
  }, [track, scrolled])
  useEffect(() => {
    const element = viewport.current
    const content = element?.querySelector('[data-slot="message-scroller-content"]')
    if (element === null || element === undefined || content === null || content === undefined) return
    const turns = new Set(ids === '' ? [] : ids.split('\n'))
    let frame = 0
    let scrollFrame = 0
    const remeasure = () => {
      frame = 0
      const next = measure(element, turns)
      layout.current = next
      if (next === undefined) return
      const shown = turns.size >= 2 && next.height > element.clientHeight + 1
      setGeometry((previous) =>
        sameLayout(previous, next, shown) ? previous : { ...next, shown, current: previous.current },
      )
      scrolled()
    }
    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(remeasure)
    }
    const onScroll = () => {
      if (scrollFrame === 0)
        scrollFrame = requestAnimationFrame(() => {
          scrollFrame = 0
          scrolled()
        })
    }
    schedule()
    element.addEventListener('scroll', onScroll, { passive: true })
    const resize = new ResizeObserver(schedule)
    resize.observe(element)
    resize.observe(content)
    const rows = new MutationObserver(schedule)
    rows.observe(content, { childList: true })
    return () => {
      cancelAnimationFrame(frame)
      cancelAnimationFrame(scrollFrame)
      element.removeEventListener('scroll', onScroll)
      resize.disconnect()
      rows.disconnect()
    }
  }, [viewport, ids, scrolled])
  return geometry
}

/** The turns as a list to jump from, with "Earlier messages" ahead of them while there is more history. */
function TurnList({
  turns,
  current,
  onJump,
  onEarlier,
}: {
  readonly turns: readonly Turn[]
  readonly current: number
  readonly onJump: (id: string) => void
  readonly onEarlier: (() => void) | undefined
}) {
  const list = useRef<HTMLOListElement>(null)
  useEffect(() => {
    const frame = requestAnimationFrame(() =>
      list.current?.querySelector('[aria-current="location"]')?.scrollIntoView({ block: 'nearest' }),
    )
    return () => cancelAnimationFrame(frame)
  }, [])
  return (
    <nav aria-label="Conversation turns" className="turn-map-list">
      <ol ref={list}>
        {onEarlier !== undefined && (
          <li>
            <button type="button" className="turn-map-row turn-map-earlier" onClick={onEarlier}>
              <HistoryIcon aria-hidden />
              Earlier messages
            </button>
          </li>
        )}
        {turns.map((turn, index) => (
          <li key={turn.id}>
            <button
              type="button"
              className="turn-map-row"
              aria-current={index === current ? 'location' : undefined}
              title={turn.label}
              onClick={() => onJump(turn.id)}
            >
              <span className="turn-map-number">{index + 1}</span>
              <span className="turn-map-label">{turn.label === '' ? 'Message' : turn.label}</span>
              {turn.telegram && <span className="turn-map-via">Telegram</span>}
            </button>
          </li>
        ))}
      </ol>
    </nav>
  )
}

type Variant = {
  readonly turns: readonly Turn[]
  readonly geometry: Geometry
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly onJump: (id: string) => void
  readonly onEarlier: (() => void) | undefined
}

/** The marks on their track, the band on screen, and the list on hover. */
function TurnMapRail({
  band,
  track,
  onTrack,
  ...variant
}: Variant & {
  readonly band: RefObject<SVGRectElement | null>
  readonly track: number
  readonly onTrack: (height: number) => void
}) {
  const { turns, geometry, open, onOpenChange } = variant
  const svg = useRef<SVGSVGElement>(null)
  const popup = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const element = svg.current
    if (element === null) return
    const observer = new ResizeObserver(([entry]) => onTrack(Math.round(entry?.contentRect.height ?? 0)))
    observer.observe(element)
    return () => observer.disconnect()
  }, [onTrack])
  const marks = markPositions(geometry.offsets, geometry.height, Math.max(0, track - MARK))
  return (
    <div className="turn-map" data-app-cover>
      <Popover open={open} onOpenChange={onOpenChange}>
        <PopoverTrigger
          openOnHover
          delay={300}
          closeDelay={200}
          render={<button type="button" className="turn-map-trigger" aria-label="Conversation turns" />}
        >
          <svg ref={svg} className="turn-map-track" width={WIDTH} aria-hidden>
            <rect ref={band} className="turn-map-band" x={0.5} y={0} width={WIDTH - 1} height={0} rx={3} />
            {marks.map((y, index) => (
              <rect
                key={turns[index]?.id ?? index}
                className="turn-map-mark"
                data-current={index === geometry.current || undefined}
                x={2}
                y={y}
                width={WIDTH - 2}
                height={MARK}
                rx={MARK / 2}
              />
            ))}
          </svg>
        </PopoverTrigger>
        <PopoverContent
          ref={popup}
          side="left"
          sideOffset={6}
          initialFocus={(interaction) =>
            interaction === 'keyboard' &&
            (popup.current?.querySelector<HTMLElement>('[aria-current="location"]') ?? true)
          }
        >
          <PopoverTitle className="mx-2 mt-1">In this conversation</PopoverTitle>
          <TurnList turns={turns} current={geometry.current} onJump={variant.onJump} onEarlier={variant.onEarlier} />
        </PopoverContent>
      </Popover>
    </div>
  )
}

/** A tab on the pane's edge that opens the list as a bottom sheet: phones, tablets and narrow windows. */
function TurnMapTab({ turns, geometry, open, onOpenChange, onJump, onEarlier }: Variant) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetTrigger
        render={
          <button
            type="button"
            className="turn-map-tab material-chrome"
            aria-label="Conversation turns"
            data-app-cover
          />
        }
      >
        <ListIcon aria-hidden />
      </SheetTrigger>
      <SheetContent side="bottom" initialFocus={false}>
        <SheetHeader>
          <SheetTitle>In this conversation</SheetTitle>
        </SheetHeader>
        <div className="turn-map-sheet">
          <TurnList turns={turns} current={geometry.current} onJump={onJump} onEarlier={onEarlier} />
        </div>
      </SheetContent>
    </Sheet>
  )
}

/**
 * The conversation's turn map (inside the transcript's MessageScroller): a mark for each of the owner's turns where it
 * sits in the transcript and a band for what is on screen; hovering lists the turns and a click jumps to one. It shows
 * once there are two turns and the transcript scrolls.
 */
export function TurnMap({
  viewport,
  turns,
  onEarlier,
}: {
  readonly viewport: RefObject<HTMLDivElement | null>
  readonly turns: readonly Turn[]
  readonly onEarlier: (() => void) | undefined
}) {
  const rail = useMediaQuery(RAIL_QUERY)
  const band = useRef<SVGRectElement>(null)
  const [track, setTrack] = useState(0)
  const [open, setOpen] = useState(false)
  const geometry = useTurnGeometry(viewport, turns.map((turn) => turn.id).join('\n'), band, track)
  const { scrollToMessage, scrollToEnd } = useMessageScroller()
  if (!geometry.shown) return null
  const variant: Variant = {
    turns,
    geometry,
    open,
    onOpenChange: setOpen,
    onEarlier,
    onJump: (id) => {
      const instant = matchMedia('(prefers-reduced-motion: reduce)').matches
      if (id === 'home-surface') scrollToEnd({ behavior: instant ? 'auto' : 'smooth' })
      else scrollToMessage(id, { align: 'start', behavior: instant ? 'auto' : 'smooth' })
      setOpen(false)
    },
  }
  return rail ? <TurnMapRail band={band} track={track} onTrack={setTrack} {...variant} /> : <TurnMapTab {...variant} />
}
