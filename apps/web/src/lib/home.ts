/**
 * Where Home (`/`) sends someone (routes/index.tsx): a signed-in owner to a channel, a visitor nowhere, so goblin's
 * landing shows. On the server, signed in means the request carries Better Auth's session cookie, under its `__Secure-`
 * name over https and its plain name on the local stack; the cookie is only a hint, since `OwnerGate` decides on every
 * owner page.
 */
const SESSION_COOKIES = ['__Secure-better-auth.session_token', 'better-auth.session_token'] as const

/** Whether a request carries a session cookie, as `cookie` reads one by name. */
export const hasSessionCookie = (cookie: (name: string) => string | undefined): boolean =>
  SESSION_COOKIES.some((name) => (cookie(name) ?? '') !== '')

/** The channel Home opens for `signedIn`: `channel`, or none (the landing). */
export const homeFor = (signedIn: boolean, channel: string): string | undefined => (signedIn ? channel : undefined)
