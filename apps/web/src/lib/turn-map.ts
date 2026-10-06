/**
 * The geometry of a conversation's turn map: one mark per turn the owner took, placed where the turn sits in the
 * transcript (so a long reply shows as a gap), and a band for the part of the transcript on screen. Heights are the
 * transcript's content without the scroller's tail spacer, so neither moves when a sent turn reserves room below it.
 */

/**
 * Where each turn's mark sits on a track `track` px long: in proportion to its `offsets` in content `height` px, then
 * at least `gap` apart and inside the track. When the gaps alone do not fit, the marks are spaced evenly instead.
 */
export function markPositions(offsets: readonly number[], height: number, track: number, gap = 4): number[] {
  const count = offsets.length
  if (count === 0 || height <= 0 || track <= 0) return []
  if (count === 1) return [Math.min(track, Math.max(0, ((offsets[0] ?? 0) / height) * track))]
  if ((count - 1) * gap > track) return offsets.map((_, index) => (index * track) / (count - 1))
  const positions = offsets.map((offset) => Math.min(track, Math.max(0, (offset / height) * track)))
  for (let index = 1; index < count; index++)
    positions[index] = Math.max(positions[index] ?? 0, (positions[index - 1] ?? 0) + gap)
  positions[count - 1] = Math.min(positions[count - 1] ?? 0, track)
  for (let index = count - 2; index >= 0; index--)
    positions[index] = Math.min(positions[index] ?? 0, (positions[index + 1] ?? 0) - gap)
  return positions
}

/** The band for what is on screen: its top and size on the track, at least `minimum` px so it stays visible. */
export function viewportBand(
  scrollTop: number,
  clientHeight: number,
  height: number,
  track: number,
  minimum = 6,
): { readonly top: number; readonly size: number } {
  if (height <= 0 || track <= 0) return { top: 0, size: 0 }
  const size = Math.min(track, Math.max(minimum, (clientHeight / height) * track))
  const top = Math.min(track - size, Math.max(0, (scrollTop / height) * track))
  return { top, size }
}

/**
 * The turn being read: the last whose top has passed the reading line, or the last of all once the reader is at the
 * end (a short final turn never reaches the line). Before the first turn, the first.
 */
export function currentTurn(offsets: readonly number[], readingLine: number, atEnd: boolean): number {
  if (offsets.length === 0) return -1
  if (atEnd) return offsets.length - 1
  let current = 0
  offsets.forEach((offset, index) => {
    if (offset <= readingLine) current = index
  })
  return current
}

/** A turn's label: its first non-blank line, whitespace collapsed. */
export function turnLabel(text: string): string {
  const line = text.split('\n').find((candidate) => candidate.trim() !== '') ?? ''
  return line.replaceAll(/\s+/gu, ' ').trim()
}
