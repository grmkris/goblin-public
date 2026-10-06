import { Forbidden } from '../http/errors.ts'

/** Every routine write requires the configured app Origin and an explicit browser CSRF header. */
export function routineOrigin(request: Request, appUrl: string): void {
  if (request.method === 'GET') return
  if (request.headers.get('origin') !== new URL(appUrl).origin || request.headers.get('x-goblin-csrf') !== '1')
    throw new Forbidden({ reason: 'routine csrf' })
}
