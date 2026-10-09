import type { CSSProperties } from 'react'
import type { PersonaAvatar as Avatar } from '@goblin/contracts'

/** A Persona's mark: its glyph on a disc of its hue, so who answered reads at a glance. */
export function PersonaAvatar({
  avatar,
  size = 'md',
}: {
  readonly avatar: Avatar
  readonly size?: 'sm' | 'md' | 'lg'
}) {
  const hue: CSSProperties & Record<'--hue', number> = { '--hue': avatar.hue }
  return (
    <span className="persona-avatar" data-size={size} style={hue} aria-hidden>
      {avatar.glyph}
    </span>
  )
}
