import { type RefObject, useLayoutEffect, useRef } from 'react'
import { Button, useMessageScroller, useMessageScrollerScrollable } from '@goblin/ui'
import { ArrowDownIcon } from 'lucide-react'
import { HOME_MARK, homeLanding } from '../../lib/home.ts'
import type { Part } from '../../lib/parts.ts'
import { isOwnTurn } from '../../lib/parts.ts'

export function HomeLanding({
  parts,
  loading,
  viewport,
}: {
  readonly parts: readonly Part[]
  readonly loading: boolean
  readonly viewport: RefObject<HTMLDivElement | null>
}) {
  const landed = useRef(false)
  const { scrollToMessage, scrollToEnd } = useMessageScroller()
  useLayoutEffect(() => {
    if (landed.current || loading) return
    const target = homeLanding(parts)
    // The scroller's child-list observer must finish classifying the initial rows before this explicit landing.
    const frame = requestAnimationFrame(() => {
      if (target === HOME_MARK) scrollToEnd({ behavior: 'auto' })
      else scrollToMessage(target, { align: 'start', behavior: 'auto', scrollMargin: 64 })
      landed.current = true
      if (viewport.current !== null) viewport.current.dataset.homeLanded = ''
    })
    return () => cancelAnimationFrame(frame)
  }, [parts, loading, scrollToMessage, scrollToEnd, viewport])
  return null
}

/** Now is the latest own turn; the desk's bottom is reached by its separate Home mark. */
export function NowButton({ parts }: { readonly parts: readonly Part[] }) {
  const { scrollToMessage } = useMessageScroller()
  const { end } = useMessageScrollerScrollable()
  const target = parts.filter(isOwnTurn).at(-1)?.id ?? HOME_MARK
  if (!end) return null
  return (
    <span className="home-now">
      <Button
        variant="secondary"
        size="icon-sm"
        aria-label="Back to now"
        onClick={() =>
          scrollToMessage(target, {
            align: 'start',
            scrollMargin: 64,
            behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
          })
        }
      >
        <ArrowDownIcon aria-hidden />
      </Button>
    </span>
  )
}
