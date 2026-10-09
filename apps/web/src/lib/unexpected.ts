/**
 * Hands a failure nothing on the page expects (data the contract does not describe, a bug, a promise nobody awaits
 * that rejected) to the page's error handlers without interrupting the caller: the browser logs it with its stack, as
 * it would an uncaught error, and a global error handler sees it. Unit tests run without a page, and so without one.
 */
export function reportUnexpected(error: unknown): void {
  if (typeof globalThis.reportError === 'function') globalThis.reportError(error)
}
