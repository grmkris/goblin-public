// The workspace's live Apps (ADRs 0020, 0021). A kept App the owner is looking at has one live instance: its iframe in
// a fixed stage (stage.tsx) that follows the App's page while it has one, else its place in its transcript. The stage
// never moves in the DOM, so an App goes between the two without reloading. At most LIVE_APPS stay loaded: beyond
// that the least recently seen unloads and its place shows a stub. Nothing here grants anything: an MCP App's
// resource and every call it makes go through the owner's grants, live, and an agent app's view calls only its own
// actions (frame.tsx). An agent app's new release reloads its frame; a new state is pushed into it.
import * as Data from 'effect/Data'
import { type ReactNode, createContext, use, useCallback, useMemo, useRef } from 'react'
import { useMutation } from '@tanstack/react-query'
import type { AppView } from '@goblin/contracts'
import type { DownloadFile } from '../../lib/app-download.ts'
import type { QuestionAnswerReceipt } from '../../lib/app-message.ts'
import { messageOf } from '../../lib/query/app-error.ts'
import { useNavigation } from '../../lib/navigation.ts'
import { useApps } from '../../lib/workspace/hooks.ts'
import { closeWorkspaceAppMutation } from '../../lib/workspace/mutations.ts'
import { type Instance, useInstancePatches, withItem } from './instance.ts'
import { useResidency } from './residency.ts'
import { type SlotName, useKicks, useSlots } from './slot-registry.ts'

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
  /** Accept only while the originating App is live. */
  readonly offerMessage: (id: string, receipt: QuestionAnswerReceipt) => boolean
  /** Drop the exact offer that finished; a newer receipt is preserved. */
  readonly dropMessage: (id: string, receipt: QuestionAnswerReceipt) => void
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

/** A component asked for the App host outside `AppHost`: a wiring mistake in the page, not a failure to show. */
class NoAppHost extends Data.TaggedError('NoAppHost')<{ readonly message: string }> {
  constructor(message: string) {
    super({ message })
  }
}

export function useAppHost(): Host {
  const host = use(HostContext)
  if (host === undefined) throw new NoAppHost('useAppHost must be used inside AppHost')
  return host
}

export function AppHost({ children }: { readonly children: ReactNode }) {
  const navigation = useNavigation()
  const closing = useMutation(closeWorkspaceAppMutation).mutateAsync
  const { kick, onKick } = useKicks()
  const { slot, element } = useSlots(kick)
  const { instances, setInstances, dormant, problems, setProblems, show, seen, unload } = useResidency(useApps())
  const outside = useRef({ navigation, instances })
  outside.current = { navigation, instances }
  const close = useCallback(
    (id: string) => {
      unload([id], false)
      outside.current.navigation.closeAppPage(id)
      closing({ id, closed: true }).catch((cause: unknown) => {
        setProblems((current) => withItem(current, id, messageOf(cause, 'close the app')))
      })
    },
    [unload, setProblems, closing],
  )
  const { setHeight, setContext, setLink, setDownload, setMessage, dropMessage } = useInstancePatches(setInstances)
  const offerMessage = useCallback(
    (id: string, receipt: QuestionAnswerReceipt): boolean => {
      const instance = outside.current.instances.get(id)
      if (instance === undefined || instance.selection.kind !== 'mcp' || instance.app.closedAt !== undefined)
        return false
      setMessage(id, receipt)
      return true
    },
    [setMessage],
  )
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
      offerMessage,
      dropMessage,
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
      offerMessage,
      dropMessage,
      seen,
      slot,
      element,
      kick,
      onKick,
    ],
  )
  return <HostContext value={host}>{children}</HostContext>
}
