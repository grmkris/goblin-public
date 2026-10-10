// One loaded App and what it asked of the host: its height, the context it shares, a link, a file or a saved answer to
// offer. Each is kept on its instance until the owner acts on it or the App withdraws it.
import { type Dispatch, type SetStateAction, useCallback } from 'react'
import type { AppView } from '@goblin/contracts'
import type { DownloadFile } from '../../lib/app-download.ts'
import { type QuestionAnswerReceipt, receiptText } from '../../lib/app-message.ts'
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
  /** A saved answer waiting for the owner's Continue click; it contains no answer text. */
  readonly message?: QuestionAnswerReceipt
}

type SetInstances = Dispatch<SetStateAction<ReadonlyMap<string, Instance>>>

export const without = <T>(map: ReadonlyMap<string, T>, ids: readonly string[]): ReadonlyMap<string, T> => {
  if (!ids.some((id) => map.has(id))) return map
  const next = new Map(map)
  for (const id of ids) next.delete(id)
  return next
}

export const withItem = <T>(map: ReadonlyMap<string, T>, id: string, value: T) => new Map(map).set(id, value)

/** `instances` with one instance changed by `change`; unchanged when it is not loaded. */
export function patched(
  instances: ReadonlyMap<string, Instance>,
  id: string,
  change: (instance: Instance) => Instance,
): ReadonlyMap<string, Instance> {
  const current = instances.get(id)
  return current === undefined ? instances : withItem(instances, id, change(current))
}

/** What an App asked of the host, kept on its instance: its height, shared context, a link or a file to offer. */
export function useInstancePatches(setInstances: SetInstances) {
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
  const setMessage = useCallback(
    (id: string, message: QuestionAnswerReceipt) =>
      setInstances((current) => patched(current, id, (instance) => ({ ...instance, message }))),
    [setInstances],
  )
  const dropMessage = useCallback(
    (id: string, receipt: QuestionAnswerReceipt) =>
      setInstances((current) =>
        patched(current, id, (instance) => {
          if (instance.message === undefined || receiptText(instance.message) !== receiptText(receipt)) return instance
          const { message: _dropped, ...rest } = instance
          return rest
        }),
      ),
    [setInstances],
  )
  return { setHeight, setContext, setLink, setDownload, setMessage, dropMessage }
}
