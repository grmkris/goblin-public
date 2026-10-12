// Which Apps are loaded, at most LIVE_APPS at a time, and the launch that loads one: an MCP App's resource and tool
// result, a server's own App's tool called as the owner (ADR 0053), or an agent app's release.
import * as Data from 'effect/Data'
import { type Dispatch, type SetStateAction, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { type QueryClient, useQueryClient } from '@tanstack/react-query'
import type { AppView } from '@goblin/contracts'
import type { CallToolResult } from '@modelcontextprotocol/client'
import { LIVE_APPS, evictions } from '../../lib/app-residency.ts'
import { appLaunchQuery } from '../../apps/queries.ts'
import { serverAppQuery } from '../../mcp/queries.ts'
import { cancelledReason } from '../../lib/call-outcome.ts'
import { record, records } from '../../lib/values.ts'
import { messageOf } from '../../lib/query/app-error.ts'
import type { AppSelection } from './frame.tsx'
import { type Instance, patched, withItem, without } from './instance.ts'

/** The tool result an App expects, rebuilt from the (redacted) details the resident tool committed. */
function resultOf(details: unknown): CallToolResult {
  const value = record(details)
  const structured = record(value?.structuredContent)
  const meta = record(value?._meta)
  return {
    // SAFETY: the content blocks were committed from the remote CallToolResult by mcpModelResult (runtime).
    content: records(value?.content) as CallToolResult['content'],
    ...(structured === undefined ? {} : { structuredContent: structured }),
    ...(meta === undefined ? {} : { _meta: meta }),
  }
}

/** A server's own App that offered no `ui://` resource when its tool answered: its place says so. */
class NoServerApp extends Data.TaggedError('NoServerApp')<{ readonly message: string }> {
  constructor(title: string) {
    super({ message: `${title} did not offer its app` })
  }
}

/** Whether `app` is a server's own App (ADR 0053): its tool is called as the owner on each open. */
export const isServerApp = (app: AppView): boolean => app.source.kind === 'mcp' && app.source.entrypoint === true

/** The panel a loaded server App was opened on (`focus`), if any. */
const focusOf = (selection: AppSelection): unknown =>
  selection.kind === 'mcp' ? selection.arguments['focus'] : undefined

/**
 * A server's own App: its tool called as the owner, as its card's Open always did (ADR 0043), opened on `focus` when
 * one is named; the result is the server's own.
 */
async function launchServerApp(queryClient: QueryClient, app: AppView, focus?: string): Promise<AppSelection> {
  if (app.source.kind !== 'mcp') throw new NoServerApp(app.title)
  const { connectionId, tool } = app.source
  const opened = await queryClient.query(serverAppQuery(connectionId, tool, focus))
  if (opened.uri === undefined) throw new NoServerApp(app.title)
  return {
    kind: 'mcp',
    connectionId,
    uri: opened.uri,
    arguments: focus === undefined ? {} : { focus },
    // SAFETY: the runtime returned this body from the SDK-validated CallToolResult of this exact call.
    result: opened.result as CallToolResult,
  }
}

async function launch(queryClient: QueryClient, app: AppView, focus?: string): Promise<AppSelection> {
  if (isServerApp(app)) return launchServerApp(queryClient, app, focus)
  const loaded = await queryClient.query(appLaunchQuery(app.id))
  if (loaded.kind === 'agent') return { kind: 'agent', id: app.id, launch: loaded }
  const cancelled = cancelledReason(loaded.result)
  return {
    kind: 'mcp',
    connectionId: loaded.connectionId,
    uri: loaded.uri,
    arguments: loaded.arguments,
    result: resultOf(loaded.result),
    ...(cancelled === undefined ? {} : { cancelled }),
  }
}

/** An agent app whose loaded view is an older release than the feed says it runs. */
const outdated = (instance: Instance, app: AppView) =>
  instance.selection.kind === 'agent' &&
  app.source.kind === 'agent' &&
  app.source.release !== instance.selection.launch.release

/** Launches an App, one launch at a time per App, and puts what loaded in place; a failure shows on the App's place. */
function useLaunch(setProblems: Dispatch<SetStateAction<ReadonlyMap<string, string>>>) {
  const queryClient = useQueryClient()
  const loading = useRef(new Set<string>())
  const load = useCallback(
    (app: AppView, put: (selection: AppSelection) => void, focus?: string) => {
      if (loading.current.has(app.id)) return
      loading.current.add(app.id)
      launch(queryClient, app, focus)
        .then(put)
        .catch((cause: unknown) =>
          setProblems((current) => withItem(current, app.id, messageOf(cause, 'load the app'))),
        )
        .finally(() => loading.current.delete(app.id))
    },
    [queryClient, setProblems],
  )
  return { loading, load }
}

/**
 * Loading and unloading: `show` launches an App once however often it is asked (a server's own App again when asked
 * for another panel), the cap unloads the least recently seen, and an App the feed reports closed (or gone) unloads
 * everywhere.
 */
export function useResidency(apps: readonly AppView[]) {
  const [instances, setInstances] = useState<ReadonlyMap<string, Instance>>(new Map())
  const [dormant, setDormant] = useState<ReadonlySet<string>>(new Set())
  const [problems, setProblems] = useState<ReadonlyMap<string, string>>(new Map())
  const { loading, load } = useLaunch(setProblems)
  const seenAt = useRef(new Map<string, { seenAt: number; visible: boolean }>())
  const latest = useRef(instances)
  // Balancing reads the residents as they are now, written after each render.
  useLayoutEffect(() => {
    latest.current = instances
  })
  const unload = useCallback((ids: readonly string[], keepStub: boolean) => {
    if (ids.length === 0) return
    for (const id of ids) seenAt.current.delete(id)
    setInstances((current) => without(current, ids))
    if (keepStub) setDormant((current) => new Set([...current, ...ids]))
  }, [])
  const balance = useCallback(() => {
    const residents = [...latest.current.keys()].map((id) => ({
      id,
      ...(seenAt.current.get(id) ?? { seenAt: 0, visible: false }),
    }))
    unload(evictions(residents, LIVE_APPS), true)
  }, [unload])
  const show = useCallback(
    (app: AppView, focus?: string) => {
      seenAt.current.set(app.id, { seenAt: Date.now(), visible: true })
      setDormant((current) => (current.has(app.id) ? new Set([...current].filter((id) => id !== app.id)) : current))
      const loaded = latest.current.get(app.id)
      if (loaded !== undefined && isServerApp(app) && focusOf(loaded.selection) !== focus) {
        load(app, (selection) => setInstances((current) => withItem(current, app.id, { app, selection })), focus)
        return
      }
      if (loaded !== undefined || loading.current.has(app.id)) return
      setProblems((current) => without(current, [app.id]))
      load(app, (selection) => setInstances((current) => withItem(current, app.id, { app, selection })), focus)
    },
    [load, loading],
  )
  const seen = useCallback(
    (id: string, visible: boolean) => {
      const was = seenAt.current.get(id)
      seenAt.current.set(id, { seenAt: visible || was === undefined ? Date.now() : was.seenAt, visible })
      if (!visible) balance()
    },
    [balance],
  )
  useEffect(balance, [instances.size, balance])
  /** Loads an agent app's new release in place of the old one. */
  const reload = useCallback(
    (app: AppView) =>
      load(app, (selection) =>
        setInstances((current) => patched(current, app.id, (instance) => ({ ...instance, app, selection }))),
      ),
    [load],
  )
  // The feed is the truth about which Apps are kept: a closed one unloads, a renamed one shows its new name, and an
  // agent app on a new release loads it.
  useEffect(() => {
    const open = new Map(apps.filter((app) => app.closedAt === undefined).map((app) => [app.id, app]))
    unload(
      [...latest.current.keys()].filter((id) => !open.has(id)),
      false,
    )
    for (const [id, instance] of latest.current) {
      const app = open.get(id)
      if (app !== undefined && outdated(instance, app)) reload(app)
    }
    setInstances((current) => {
      let next = current
      for (const [id, instance] of current) {
        const app = open.get(id)
        if (app !== undefined && app !== instance.app) next = withItem(next, id, { ...instance, app })
      }
      return next
    })
  }, [apps, unload, reload])
  return { instances, setInstances, dormant, problems, setProblems, show, seen, unload }
}
