// A QR code drawn as one SVG path from uqr's module matrix, as the Goblin Wallet draws its own (apps/wallet-web): no
// canvas and no injected markup. Black on white in every theme, not themed: that is the contrast every scanner reads.
import { encode } from 'uqr'

/** One `M x y h1 v1 h-1 z` square per dark module, in module units. */
const pathOf = (modules: readonly (readonly boolean[])[]): string =>
  modules.flatMap((row, y) => row.flatMap((dark, x) => (dark ? [`M${x} ${y}h1v1h-1z`] : []))).join('')

export function QrCode({ value, label }: { readonly value: string; readonly label: string }) {
  const { data, size } = encode(value, { ecc: 'M', border: 2 })
  return (
    <svg className="start-qr" role="img" aria-label={label} viewBox={`0 0 ${size} ${size}`} shapeRendering="crispEdges">
      <path d={pathOf(data)} fill="currentColor" />
    </svg>
  )
}
