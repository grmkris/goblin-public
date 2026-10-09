const KEY = 'goblin:recent-threads'
/** How many recently opened threads the browser remembers. */
const KEPT = 20

/** The threads this browser opened recently, newest first (a convenience: without storage there are none). */
export function recentThreads(): readonly string[] {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]')
    return Array.isArray(stored)
      ? stored.filter((id): id is string => typeof id === 'string' && /^\d{1,12}$/u.test(id))
      : []
  } catch {
    // expected: storage is off or holds something else, so the browser remembers no recent threads
    return []
  }
}

/** Remembers that a thread was opened now, ahead of the others. */
export function rememberThread(thread: string): void {
  try {
    const next = [thread, ...recentThreads().filter((id) => id !== thread)].slice(0, KEPT)
    localStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    // expected: storage is off or full, so only the sidebar's recent list is lost
  }
}
