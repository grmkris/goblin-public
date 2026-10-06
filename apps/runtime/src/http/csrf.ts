import { Forbidden } from './errors.ts'

/**
 * A browser write to the owner's routines or files: it must come from the configured app Origin and carry the explicit
 * `x-goblin-csrf` header the web sends on every write. Reads pass.
 */
export function browserWrite(request: Request, appUrl: string): void {
  if (request.method === 'GET') return
  if (request.headers.get('origin') !== new URL(appUrl).origin || request.headers.get('x-goblin-csrf') !== '1')
    throw new Forbidden({ reason: 'csrf' })
}
