type ViewportGeometry = { readonly height: number; readonly offsetTop: number; readonly scale: number }

/** Pinch zoom changes viewport dimensions too; only focused editing at scale one identifies keyboard space. */
export function viewportKeyboardInset(
  viewport: ViewportGeometry | null,
  layoutHeight: number,
  editable: boolean,
): number {
  if (viewport === null || viewport.scale !== 1 || !editable) return 0
  return Math.max(0, Math.round(layoutHeight - viewport.height - viewport.offsetTop))
}
