/** Whether the person asks for less motion: the one place a script reads it (CSS reads its own media query). */
export const prefersReducedMotion = (): boolean => matchMedia('(prefers-reduced-motion: reduce)').matches

/**
 * How a scroll the app starts itself travels: it glides, unless the person asks for less motion, when it jumps. The
 * CSS `scroll-behavior` rule cannot reach these: a script's `behavior` option wins over it.
 */
export const glide = (): ScrollBehavior => (prefersReducedMotion() ? 'auto' : 'smooth')
