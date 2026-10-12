// A QR code drawn as one SVG path from uqr's module matrix: no canvas and no injected markup, so it renders the same in
// the owner's site and inside an App's sandboxed frame. It is black on white in every theme, not themed: that is the
// contrast every scanner reads.
import { encode } from 'uqr'
import { cn } from './cn.ts'

/** One `M x y h1 v1 h-1 z` square per dark module, in module units. */
function pathOf(modules: readonly (readonly boolean[])[]): string {
  return modules.flatMap((row, y) => row.flatMap((dark, x) => (dark ? [`M${x} ${y}h1v1h-1z`] : []))).join('')
}

export function QrCode({
  value,
  label,
  className,
}: {
  readonly value: string
  /** What the code holds, said for a screen reader. */
  readonly label: string
  readonly className?: string
}) {
  const { data, size } = encode(value, { ecc: 'M', border: 2 })
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${size} ${size}`}
      shapeRendering="crispEdges"
      className={cn('size-36 shrink-0 rounded-md bg-white p-1 text-black', className)}
    >
      <path d={pathOf(data)} fill="currentColor" />
    </svg>
  )
}
