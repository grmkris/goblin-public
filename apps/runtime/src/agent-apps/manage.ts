import type { AgentAppChange, AgentAppDetail, AgentAppSummary } from '@goblin/contracts'
import { NotFound } from '../http/errors.ts'
import type { AgentApps } from './engine.ts'

/** An agent app as the owner's Apps page lists it, without its App id (the registry adds that). */
export type AppSummary = Omit<AgentAppSummary, 'app'>
export type AppDetail = Omit<AgentAppDetail, 'app'>

const EVENTS_SHOWN = 30
const RELEASES_SHOWN = 20

/** What the owner sees of one agent app in the list: its name and home, version, schedules and what needs them. */
export function appSummary(apps: AgentApps, name: string): AppSummary {
  const row = apps.store.app(name)
  if (row === undefined) throw new NotFound({ what: `app ${name}` })
  const [last] = apps.store.events(name, 1)
  return {
    name,
    title: row.title,
    description: row.description,
    home: row.homeSession,
    version: apps.store.release(row.activeRelease)?.seq ?? 0,
    revision: apps.store.state(name)?.revision ?? 0,
    jobs: apps.jobs.list(name),
    waiting: apps.powers(name).filter((power) => power.status !== 'approved').length,
    failure: last?.kind === 'error' ? last.detail.slice(0, 500) : null,
    updatedAt: row.updatedAt,
  }
}

/** Every agent app, newest change first. */
export function appSummaries(apps: AgentApps): readonly AppSummary[] {
  return apps.store
    .apps()
    .map((row) => appSummary(apps, row.name))
    .toSorted((a, b) => b.updatedAt - a.updatedAt)
}

/** One agent app in full: its versions, powers, today's usage, its files and recent events. */
export async function appDetail(apps: AgentApps, name: string, now: number): Promise<AppDetail> {
  const summary = appSummary(apps, name)
  const usage = apps.store.usage(name, now)
  return {
    ...summary,
    releases: apps.store.releases(name, RELEASES_SHOWN).map((release) => ({
      release: release.id,
      version: release.seq ?? 0,
      status: release.status,
      note: release.note,
      at: release.createdAt,
    })),
    powers: apps.powers(name),
    usage: { egress: usage.egress ?? 0, tokens: usage.tokens ?? 0, notify: usage.notify ?? 0, job: usage.job ?? 0 },
    files: await apps.files(name).size(),
    events: apps.store
      .events(name, EVENTS_SHOWN)
      .map((event) => ({ kind: event.kind, detail: event.detail.slice(0, 1000), at: event.createdAt })),
  }
}

/** One change the owner makes to an agent app, other than moving its home (the program checks the conversation). */
export async function changeApp(
  apps: AgentApps,
  name: string,
  change: Exclude<AgentAppChange, { readonly kind: 'home' }>,
): Promise<void> {
  if (apps.store.app(name) === undefined) throw new NotFound({ what: `app ${name}` })
  switch (change.kind) {
    case 'rollback':
      await apps.rollback(name, change.release)
      return
    case 'pause':
      await apps.jobs.pause(name, change.action, change.paused)
      return
    case 'run':
      await apps.jobs.runNow(name, change.action)
      return
    case 'power':
      apps.answer(name, { kind: change.power, target: change.target }, change.allowed)
  }
}
