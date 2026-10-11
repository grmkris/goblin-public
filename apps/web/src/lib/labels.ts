import type { BillingState, ResidentStatus, RoutineRunView, RoutineView, ServerView } from '@goblin/contracts'

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

/** What to call a connection: the owner's label for it (ADR 0041). */
export const connectionName = (server: Pick<ServerView, 'label'>): string => server.label

/** What the server behind a connection calls itself: its card's title, else the name it reports. */
export const serverName = (server: Pick<ServerView, 'title' | 'serverName'>): string | undefined =>
  server.title ?? server.serverName

/** The owner's plan, from billing state. */
export function planStatus(state: BillingState): Label {
  if (!state.active) return { text: 'Not subscribed', tone: 'quiet' }
  if (state.status === 'past_due' || state.status === 'on_hold') return { text: 'Payment due', tone: 'attention' }
  if (state.cancelAtPeriodEnd || state.status === 'cancelled') return { text: 'Ending', tone: 'quiet' }
  return { text: 'Active', tone: 'good' }
}

/** Whether the agent may act while the owner is away (resident authority). */
export function residentStatus(state: ResidentStatus['state']): Label {
  switch (state) {
    case 'active':
      return { text: 'On', tone: 'good' }
    case 'expired':
      return { text: 'Expired', tone: 'attention' }
    case 'revoked':
      return { text: 'Off', tone: 'quiet' }
    case 'never':
      return { text: 'Not on yet', tone: 'quiet' }
  }
}

/** A routine's lifecycle; `health` says when a confirmed routine is still being prepared. */
export function routineStatus(routine: Pick<RoutineView, 'state' | 'health'>): Label {
  if (routine.health === 'execution_pending') return { text: 'Getting ready', tone: 'quiet' }
  switch (routine.state) {
    case 'proposed':
      return { text: 'Waiting for your OK', tone: 'attention' }
    case 'activating':
      return { text: 'Getting ready', tone: 'quiet' }
    case 'active':
      return { text: 'On', tone: 'good' }
    case 'paused':
      return { text: 'Paused', tone: 'quiet' }
    case 'completed':
      return { text: 'Done', tone: 'quiet' }
    case 'archived':
      return { text: 'Archived', tone: 'quiet' }
  }
}

/** One run of a routine. */
export function runStatus(state: RoutineRunView['state']): Label {
  switch (state) {
    case 'admitted':
      return { text: 'Starting', tone: 'quiet' }
    case 'running':
      return { text: 'Running', tone: 'good' }
    case 'waiting_owner':
      return { text: 'Waiting for you', tone: 'attention' }
    case 'completed':
      return { text: 'Done', tone: 'good' }
    case 'skipped':
      return { text: 'Skipped', tone: 'quiet' }
    case 'failed':
      return { text: 'Failed', tone: 'bad' }
    case 'stopped':
      return { text: 'Stopped', tone: 'quiet' }
  }
}
