import type { CSSProperties } from 'react'
import { AppWindowIcon } from 'lucide-react'
import { appHue } from '../../lib/app-names.ts'

/** An App's tile: its window icon on a square of its origin's own hue, so Apps tell apart at a glance. */
export function AppTile({ origin }: { readonly origin: string }) {
  const hue: CSSProperties & Record<'--hue', number> = { '--hue': appHue(origin) }
  return (
    <span className="app-tile" style={hue} aria-hidden>
      <AppWindowIcon />
    </span>
  )
}
