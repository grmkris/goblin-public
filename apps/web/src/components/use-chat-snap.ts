import { useEffect, useRef, useState } from 'react'
import { useKeyboardInset } from './use-keyboard.ts'

export const HALF_CHAT = 0.55
export const FULL_CHAT = 1
export const CHAT_SNAPS = [HALF_CHAT, FULL_CHAT]

/** Save the owner's snap while keyboard space calls for a full-height chat; restore it on dismissal. */
export function useChatSnap(open: boolean) {
  const [snap, setSnap] = useState<number | string | null>(HALF_CHAT)
  const keyboardInset = useKeyboardInset()
  const saved = useRef<number | string | null>(null)
  useEffect(() => {
    if (open && keyboardInset > 0) {
      if (saved.current === null) saved.current = snap ?? HALF_CHAT
      setSnap(FULL_CHAT)
    } else if (saved.current !== null) {
      setSnap(saved.current)
      saved.current = null
    }
  }, [keyboardInset, open, snap])
  return { snap, setSnap, keyboardInset }
}
