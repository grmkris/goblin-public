import { type RefObject, useLayoutEffect, useRef } from 'react'
import { MessageScrollerButton, useMessageScroller } from '@goblin/ui'
import { ArrowDownIcon } from 'lucide-react'
import { HOME_MARK, homeLanding } from '../../lib/home.ts'
import type { Part } from '../../lib/parts.ts'
import { isOwnTurn } from '../../lib/parts.ts'
import { glide } from '../../lib/motion.ts'

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

/**
 * Main's way back down: to the latest own turn ("now"), not the bottom, which is Home. It is the threads' jump button,
 * so it fades in and out the same way, and scrolls on its own target instead of the end.
 */
export function NowButton({ parts }: { readonly parts: readonly Part[] }) {
  const { scrollToMessage } = useMessageScroller()
  const target = parts.filter(isOwnTurn).at(-1)?.id ?? HOME_MARK
  return (
    <MessageScrollerButton
      direction="end"
      onClick={(event) => {
        event.preventDefault()
        scrollToMessage(target, { align: 'start', scrollMargin: 64, behavior: glide() })
      }}
    >
      <ArrowDownIcon aria-hidden />
      <span className="sr-only">Back to now</span>
    </MessageScrollerButton>
  )
}
