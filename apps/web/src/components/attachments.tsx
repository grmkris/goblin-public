import { useRef, useState } from 'react'
import type { Attachment } from '@goblin/contracts'
import { Button, Spinner } from '@goblin/ui'
import { AlertCircleIcon, FileIcon, ImageIcon, PaperclipIcon, XIcon } from 'lucide-react'
import { failureText } from '../lib/boundary.ts'
import { fileSize, fileUrl, uploadAttachment } from '../lib/files.ts'

/** How many files one message carries (the runtime refuses more). */
const MAX_FILES = 8

const isImage = (mimeType: string) => /^image\/(?:png|jpeg|gif|webp)$/u.test(mimeType)

/** The files a sent message carried: a plain image opens in a new tab, anything else downloads. */
export function MessageFiles({ files }: { readonly files: readonly Attachment[] }) {
  if (files.length === 0) return null
  return (
    <ul className="message-files" aria-label="Attached files">
      {files.map((file) => (
        <li key={file.path}>
          <a
            className="file-chip"
            href={fileUrl(file.path)}
            title={file.path}
            {...(isImage(file.mimeType) ? { target: '_blank', rel: 'noreferrer' } : { download: file.name })}
          >
            {isImage(file.mimeType) ? <ImageIcon aria-hidden /> : <FileIcon aria-hidden />}
            <span className="truncate">{file.name}</span>
            <span className="file-chip-size">{fileSize(file.size)}</span>
          </a>
        </li>
      ))}
    </ul>
  )
}

type Pending =
  | { readonly id: number; readonly name: string; readonly state: 'uploading' }
  | { readonly id: number; readonly name: string; readonly state: 'ready'; readonly file: Attachment }
  | { readonly id: number; readonly name: string; readonly state: 'failed'; readonly reason: string }

/** Files the owner picked for their next message: each uploads at once, one after another, and can be removed. */
export function useAttachments() {
  const [pending, setPending] = useState<readonly Pending[]>([])
  const next = useRef(0)
  const update = (id: number, change: Pending) =>
    setPending((current) => current.map((item) => (item.id === id ? change : item)))
  async function add(files: readonly File[]): Promise<void> {
    const room = MAX_FILES - pending.length
    const picked = files.slice(0, Math.max(0, room)).map((file) => ({ file, id: (next.current += 1) }))
    setPending((current) => [
      ...current,
      ...picked.map(({ file, id }): Pending => ({ id, name: file.name, state: 'uploading' })),
    ])
    const taken = new Set(pending.flatMap((item) => (item.state === 'ready' ? [item.file.name] : [])))
    for (const { file, id } of picked) {
      try {
        const uploaded = await uploadAttachment(file, taken)
        update(id, { id, name: uploaded.name, state: 'ready', file: uploaded })
      } catch (error) {
        update(id, { id, name: file.name, state: 'failed', reason: failureText(error) })
      }
    }
  }
  return {
    pending,
    add,
    full: pending.length >= MAX_FILES,
    uploading: pending.some((item) => item.state === 'uploading'),
    /** The paths the next message carries. */
    paths: pending.flatMap((item) => (item.state === 'ready' ? [item.file.path] : [])),
    remove: (id: number) => setPending((current) => current.filter((item) => item.id !== id)),
    clear: () => setPending([]),
  }
}

/** Above the composer's field: each picked file, uploading, ready or why it failed, removable before sending. */
export function PendingFiles({ attachments }: { readonly attachments: ReturnType<typeof useAttachments> }) {
  if (attachments.pending.length === 0) return null
  return (
    <ul className="pending-files" aria-label="Files for your next message">
      {attachments.pending.map((item) => (
        <li key={item.id} className="file-chip" data-state={item.state}>
          {item.state === 'uploading' ? (
            <Spinner aria-hidden />
          ) : item.state === 'failed' ? (
            <AlertCircleIcon aria-hidden />
          ) : (
            <FileIcon aria-hidden />
          )}
          <span className="truncate" title={item.state === 'failed' ? item.reason : item.name}>
            {item.name}
          </span>
          <span className="file-chip-size">
            {item.state === 'ready' ? fileSize(item.file.size) : item.state === 'failed' ? 'failed' : 'uploading'}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={`Remove ${item.name}`}
            onClick={() => attachments.remove(item.id)}
          >
            <XIcon />
          </Button>
        </li>
      ))}
    </ul>
  )
}

/** The composer's paperclip: picks files for the next message. */
export function AttachButton({ attachments }: { readonly attachments: ReturnType<typeof useAttachments> }) {
  const input = useRef<HTMLInputElement>(null)
  return (
    <>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        onChange={(event) => {
          const files = [...(event.target.files ?? [])]
          event.target.value = ''
          void attachments.add(files)
        }}
      />
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label="Attach files"
        title="Attach files"
        disabled={attachments.full}
        onClick={() => input.current?.click()}
      >
        <PaperclipIcon />
      </Button>
    </>
  )
}
