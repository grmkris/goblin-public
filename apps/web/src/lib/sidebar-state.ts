import { createIsomorphicFn } from '@tanstack/react-start'
import { SIDEBAR_COOKIE } from '@goblin/ui'

/**
 * Whether the desktop sidebar starts open: as the owner left it (the sidebar's cookie), open by default. The server
 * reads the request's cookie so the first paint already has the right layout; the browser reads its own.
 */
export const readSidebarOpen = createIsomorphicFn()
  .server(async () => (await import('@tanstack/react-start/server')).getCookie(SIDEBAR_COOKIE) !== 'false')
  .client(async () => !document.cookie.split('; ').includes(`${SIDEBAR_COOKIE}=false`))
