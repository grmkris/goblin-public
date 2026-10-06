import type { ServerView } from '@purrable/contracts'

/**
 * A state in the owner's words, with the tone its dot takes: `good` (working as it should), `attention` (the owner can
 * fix it), `quiet` (nothing is wrong and nothing is happening) or `bad` (it failed). The raw strings the runtime sends
 * (`needs_auth`, `catching_up`) never reach the page.
 */
export type Tone = 'good' | 'attention' | 'quiet' | 'bad'
export type Label = { readonly text: string; readonly tone: Tone }

/** A server's connection. */
export function serverStatus(status: ServerView['status']): Label {
  switch (status) {
    case 'connected':
      return { text: 'Connected', tone: 'good' }
    case 'needs_auth':
      return { text: 'Needs sign-in', tone: 'attention' }
    case 'disconnected':
      return { text: 'Not connected', tone: 'quiet' }
  }
}

/** A server's event subscription, which the runtime reports as a free string. */
export function eventStatus(status: string): Label {
  switch (status) {
    case 'active':
      return { text: 'Receiving', tone: 'good' }
    case 'catching_up':
      return { text: 'Catching up', tone: 'good' }
    case 'pending':
      return { text: 'Connecting', tone: 'quiet' }
    case 'terminated':
      return { text: 'Needs reconnecting', tone: 'attention' }
    default:
      return { text: 'Paused', tone: 'quiet' }
  }
}

/** What to call a server: its own title, else the name it reports, else its id. */
export const serverTitle = (server: Pick<ServerView, 'title' | 'serverName' | 'serverId'>): string =>
  server.title ?? server.serverName ?? server.serverId
