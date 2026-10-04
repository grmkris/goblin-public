/** Wall-clock seconds for token and grant expiry checks at the plain-async edges. */
export const nowSeconds = (): number => Math.floor(Date.now() / 1000)
/** Wall-clock milliseconds for durations in plain-async log lines. */
export const nowMillis = (): number => Date.now()
