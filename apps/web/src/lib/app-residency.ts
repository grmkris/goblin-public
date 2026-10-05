/** A live App instance as residency sees it: when it was last on screen, and whether it is on screen now. */
export type Resident = { readonly id: string; readonly seenAt: number; readonly visible: boolean }

/** How many App iframes stay loaded at once before the least recently seen ones unload. */
export const LIVE_APPS = 6

/**
 * The instances to unload so that at most `cap` stay live, least recently seen first. An App on screen never unloads,
 * so the cap is soft: more than `cap` stay live while more than `cap` are in view.
 */
export function evictions(residents: readonly Resident[], cap = LIVE_APPS): string[] {
  const excess = residents.length - cap
  if (excess <= 0) return []
  return residents
    .filter((resident) => !resident.visible)
    .toSorted((a, b) => a.seenAt - b.seenAt)
    .slice(0, excess)
    .map((resident) => resident.id)
}
