/** A `T` with only `members`: a test's fake, given every member the code under test reaches on it. */
export const fake = <T>(members: Partial<T>): T =>
  // SAFETY: each test gives a fake every member its code under test reaches; that code reads no other.
  members as T

/**
 * A dependency the code under test takes but never reads, in its place. It is `undefined`, typed `never` so it fits
 * any place.
 */
// SAFETY: the code under test never reads it, so nothing can tell it is `undefined`.
export const unread = undefined as never
