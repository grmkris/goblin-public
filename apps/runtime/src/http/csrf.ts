import { Forbidden } from './errors.ts'

/** A write whose `Origin` names another site. A write with no `Origin` passes this check; `forgedWrite` needs one. */
export const crossOrigin = (request: Request, appOrigin: string): boolean => {
  if (request.method === 'GET') return false
  const origin = request.headers.get('origin')
  return origin !== null && origin !== appOrigin
}

/**
 * A write that the app's own page did not send: it lacks the app's `Origin` or the explicit `x-goblin-csrf` header the
 * web sends on every write. Reads pass.
 */
export const forgedWrite = (request: Request, appOrigin: string): boolean =>
  request.method !== 'GET' &&
  (request.headers.get('origin') !== appOrigin || request.headers.get('x-goblin-csrf') !== '1')

/** A browser write to the owner's routines or files must come from the app's page (`forgedWrite`). */
export function browserWrite(request: Request, appUrl: string): void {
  if (forgedWrite(request, new URL(appUrl).origin)) throw new Forbidden({ reason: 'csrf' })
}
