/** How often `until` reads again. */
const EVERY_MS = 20

/**
 * Reads every 20 ms until `done` holds, `ms / 20` times at most (5 s of pauses by default), and answers the last read
 * either way: background work settles late, and the caller's assertions show what it found.
 */
export async function until<A>(read: () => A | Promise<A>, done: (value: A) => boolean, ms = 5000): Promise<A> {
  let value = await read()
  for (let attempt = 0; attempt < ms / EVERY_MS && !done(value); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, EVERY_MS))
    value = await read()
  }
  return value
}

/** As `until`, for a state the case cannot go on without: it rejects, naming `what`, if `done` never holds. */
export async function waitFor<A>(
  read: () => A | Promise<A>,
  done: (value: A) => boolean,
  what: string,
  ms = 5000,
): Promise<A> {
  const value = await until(read, done, ms)
  if (!done(value)) throw new Error(`gave up waiting for ${what}`)
  return value
}
