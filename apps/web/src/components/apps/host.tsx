// The workspace's live Apps (ADRs 0020, 0021). A kept App the owner is looking at has one live instance: its iframe in
// a fixed stage (stage.tsx) that follows the App's page while it has one, else its place in its transcript. The stage
// never moves in the DOM, so an App goes between the two without reloading. At most LIVE_APPS stay loaded: beyond
// that the least recently seen unloads and its place shows a stub. Nothing here grants anything: an MCP App's
// resource and every call it makes go through the owner's grants, live, and an agent app's view calls only its own
// actions (frame.tsx). An agent app's new release reloads its frame; a new state is pushed into it.
import {
  type Dispatch,
  type ReactNode,
  type SetStateAction,
  createContext,
  use,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { Schema } from 'effect'
import { type AppView, AppLaunch } from '@goblin/contracts'
import type { CallToolResult } from '@modelcontextprotocol/client'
import type { DownloadFile } from '../../lib/app-download.ts'
import { LIVE_APPS, evictions } from '../../lib/app-residency.ts'
import { failureText, record, records, request } from '../../lib/boundary.ts'
import { appKey } from '../../lib/workspace.ts'
import { useWorkspace } from '../workspace.tsx'
import { useWorkspaceFeed } from '../workspace-feed.tsx'
import type { AppSelection } from './frame.tsx'

/** One loaded App: what it is, what it shows, and what it asked of the host so far. */
export type Instance = {
  readonly app: AppView
  readonly selection: AppSelection
  /** The height the App asked for in its transcript. */
  readonly height?: number
  /** What the App last shared for the agent; sent with the owner's next message there, then cleared. */
  readonly context?: string
  /** A link the App asked to open, waiting for the owner's click. */
  readonly link?: URL
  /** A file the App offers to save, waiting for the owner's click. */
  readonly download?: DownloadFile
}

/** Where a stage can be: an App's place in its transcript, or its page. */
export type SlotName = `app-inline:${string}` | `app-home:${string}` | `app-page:${string}`

type Host = {
  readonly instances: ReadonlyMap<string, Instance>
  /** Apps unloaded to stay under the cap: their place shows a stub until the owner shows them again. */
  readonly dormant: ReadonlySet<string>
  /** Why an App could not be loaded, by App. */
  readonly problems: ReadonlyMap<string, string>
  /** Loads `app` (or, loaded already, marks it seen now). */
  readonly show: (app: AppView) => void
  /** Closes an App: its iframe and its page go, its place offers to show it again. */
  readonly close: (id: string) => void
  readonly setHeight: (id: string, height: number) => void
  /** Keeps (or with '', drops) what the App shares with the owner's next message. */
  readonly setContext: (id: string, text: string) => void
  /** Offers a link the App asked to open, or withdraws it. */
  readonly setLink: (id: string, link: URL | undefined) => void
  /** Offers a file the App asked to download, or withdraws it. */
  readonly setDownload: (id: string, file: DownloadFile | undefined) => void
  /** The stage's report of whether any of its App shows. */
  readonly seen: (id: string, visible: boolean) => void
  /** A ref callback that registers a slot's element while it is mounted. */
  readonly slot: (name: SlotName) => (element: HTMLElement | null) => void
  readonly element: (name: SlotName) => HTMLElement | undefined
  /** Tells the stages that a slot moved or resized; they re-measure on the next frame. */
  readonly kick: () => void
  readonly onKick: (listener: () => void) => () => void
}

const HostContext = createContext<Host | undefined>(undefined)

export function useAppHost(): Host {
  const host = use(HostContext)
  if (host === undefined) throw new Error('useAppHost must be used inside AppHost')
  return host
}

const decodeLaunch = Schema.decodeUnknownSync(AppLaunch)

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

async function launch(app: AppView): Promise<AppSelection> {
  const loaded = decodeLaunch(await request(`/api/apps/${app.id}/launch`))
  if (loaded.kind === 'agent') return { kind: 'agent', id: app.id, launch: loaded }
  return {
    kind: 'mcp',
    serverId: loaded.serverId,
    uri: loaded.uri,
    arguments: loaded.arguments,
    result: resultOf(loaded.result),
  }
}

const without = <T,>(map: ReadonlyMap<string, T>, ids: readonly string[]): ReadonlyMap<string, T> => {
  if (!ids.some((id) => map.has(id))) return map
  const next = new Map(map)
  for (const id of ids) next.delete(id)
  return next
}

const withItem = <T,>(map: ReadonlyMap<string, T>, id: string, value: T) => new Map(map).set(id, value)

/** An agent app whose loaded view is an older release than the feed says it runs. */
const outdated = (instance: Instance, app: AppView) =>
  instance.selection.kind === 'agent' &&
  app.source.kind === 'agent' &&
  app.source.release !== instance.selection.launch.release

/** `instances` with one instance changed by `change`; unchanged when it is not loaded. */
function patched(
  instances: ReadonlyMap<string, Instance>,
  id: string,
  change: (instance: Instance) => Instance,
): ReadonlyMap<string, Instance> {
  const current = instances.get(id)
  return current === undefined ? instances : withItem(instances, id, change(current))
}

function useSlots(kick: () => void) {
  const elements = useRef(new Map<SlotName, HTMLElement>())
  const callbacks = useRef(new Map<SlotName, (element: HTMLElement | null) => void>())
  const slot = useCallback(
    (name: SlotName) => {
      const existing = callbacks.current.get(name)
      if (existing) return existing
      const callback = (element: HTMLElement | null) => {
        if (element) elements.current.set(name, element)
        else elements.current.delete(name)
        kick()
      }
      callbacks.current.set(name, callback)
      return callback
    },
    [kick],
  )
  const element = useCallback((name: SlotName) => elements.current.get(name), [])
  return { slot, element }
}

function useKicks() {
  const listeners = useRef(new Set<() => void>())
  const kick = useCallback(() => {
    for (const listener of listeners.current) listener()
  }, [])
  const onKick = useCallback((listener: () => void) => {
    listeners.current.add(listener)
    return () => void listeners.current.delete(listener)
  }, [])
  return { kick, onKick }
}

/**
 * Loading and unloading: `show` launches an App once however often it is asked, the cap unloads the least recently
 * seen, and an App the feed reports closed (or gone) unloads everywhere.
 */
function useResidency(apps: readonly AppView[]) {
  const [instances, setInstances] = useState<ReadonlyMap<string, Instance>>(new Map())
  const [dormant, setDormant] = useState<ReadonlySet<string>>(new Set())
  const [problems, setProblems] = useState<ReadonlyMap<string, string>>(new Map())
  const loading = useRef(new Set<string>())
  const seenAt = useRef(new Map<string, { seenAt: number; visible: boolean }>())
  const latest = useRef(instances)
  latest.current = instances
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
  const show = useCallback((app: AppView) => {
    seenAt.current.set(app.id, { seenAt: Date.now(), visible: true })
    setDormant((current) => (current.has(app.id) ? new Set([...current].filter((id) => id !== app.id)) : current))
    if (latest.current.has(app.id) || loading.current.has(app.id)) return
    loading.current.add(app.id)
    setProblems((current) => without(current, [app.id]))
    launch(app)
      .then((selection) => setInstances((current) => withItem(current, app.id, { app, selection })))
      .catch((cause: unknown) => setProblems((current) => withItem(current, app.id, failureText(cause))))
      .finally(() => loading.current.delete(app.id))
  }, [])
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
  const reload = useCallback((app: AppView) => {
    if (loading.current.has(app.id)) return
    loading.current.add(app.id)
    launch(app)
      .then((selection) =>
        setInstances((current) => patched(current, app.id, (instance) => ({ ...instance, app, selection }))),
      )
      .catch((cause: unknown) => setProblems((current) => withItem(current, app.id, failureText(cause))))
      .finally(() => loading.current.delete(app.id))
  }, [])
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

/** What an App asked of the host, kept on its instance: its height, shared context, a link or a file to offer. */
function useInstancePatches(setInstances: Dispatch<SetStateAction<ReadonlyMap<string, Instance>>>) {
  const setHeight = useCallback(
    (id: string, height: number) => setInstances((current) => patched(current, id, (it) => ({ ...it, height }))),
    [setInstances],
  )
  const setContext = useCallback(
    (id: string, text: string) =>
      setInstances((current) =>
        patched(current, id, ({ context: _dropped, ...rest }) => (text === '' ? rest : { ...rest, context: text })),
      ),
    [setInstances],
  )
  const setLink = useCallback(
    (id: string, link: URL | undefined) =>
      setInstances((current) =>
        patched(current, id, ({ link: _dropped, ...rest }) => (link === undefined ? rest : { ...rest, link })),
      ),
    [setInstances],
  )
  const setDownload = useCallback(
    (id: string, download: DownloadFile | undefined) =>
      setInstances((current) =>
        patched(current, id, ({ download: _dropped, ...rest }) =>
          download === undefined ? rest : { ...rest, download },
        ),
      ),
    [setInstances],
  )
  return { setHeight, setContext, setLink, setDownload }
}

export function AppHost({ children }: { readonly children: ReactNode }) {
  const feed = useWorkspaceFeed()
  const workspace = useWorkspace()
  const { kick, onKick } = useKicks()
  const { slot, element } = useSlots(kick)
  const { instances, setInstances, dormant, problems, setProblems, show, seen, unload } = useResidency(feed.apps)
  const outside = useRef({ feed, workspace })
  outside.current = { feed, workspace }
  const close = useCallback(
    (id: string) => {
      unload([id], false)
      outside.current.workspace.close(appKey(id))
      outside.current.feed.closeApp(id).catch((cause: unknown) => {
        setProblems((current) => withItem(current, id, failureText(cause)))
      })
    },
    [unload, setProblems],
  )
  const { setHeight, setContext, setLink, setDownload } = useInstancePatches(setInstances)
  const host = useMemo<Host>(
    () => ({
      instances,
      dormant,
      problems,
      show,
      close,
      setHeight,
      setContext,
      setLink,
      setDownload,
      seen,
      slot,
      element,
      kick,
      onKick,
    }),
    [
      instances,
      dormant,
      problems,
      show,
      close,
      setHeight,
      setContext,
      setLink,
      setDownload,
      seen,
      slot,
      element,
      kick,
      onKick,
    ],
  )
  return <HostContext value={host}>{children}</HostContext>
}
