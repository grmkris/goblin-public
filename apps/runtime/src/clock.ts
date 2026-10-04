/** Wall-clock seconds for token and grant expiry checks at the plain-async edges. */
export const nowSeconds = (): number => Math.floor(Date.now() / 1000)
