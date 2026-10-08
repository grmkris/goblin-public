/** A key press, as much of it as decides whether the composer sends. */
export type KeyPress = {
  readonly key: string
  readonly shiftKey: boolean
  readonly metaKey: boolean
  readonly ctrlKey: boolean
  readonly isComposing: boolean
}

/**
 * Whether a key press sends the message. At a keyboard and mouse, Enter sends and Shift+Enter breaks the line. On a
 * touch screen Return breaks the line, as in any phone's messaging app, and the Send button sends; a hardware keyboard
 * there still sends with ⌘ or Ctrl+Enter. An input method's Enter only composes.
 */
export function sendsMessage(press: KeyPress, touch: boolean): boolean {
  if (press.key !== 'Enter' || press.isComposing) return false
  if (press.metaKey || press.ctrlKey) return true
  return !touch && !press.shiftKey
}
