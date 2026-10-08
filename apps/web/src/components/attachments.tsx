import { useRef, useState, useSyncExternalStore } from 'react'
import type { Attachment } from '@goblin/contracts'
import { Button, Spinner } from '@goblin/ui'
import { AlertCircleIcon, FileIcon, ImageIcon, PaperclipIcon, RotateCcwIcon, XIcon } from 'lucide-react'
import { fileSize, fileUrl } from '../lib/files.ts'
import { AttachmentDraft } from '../lib/attachment-draft.ts'

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

/** A portable attachment draft. Detaching leaves uploads running in the new pane. */
export function useAttachments(initial?: AttachmentDraft) {
  const [draft, setDraft] = useState(() => initial ?? new AttachmentDraft())
  const pending = useSyncExternalStore(draft.subscribe, draft.snapshot, draft.snapshot)
  return {
    pending,
    add: draft.add,
    full: pending.length >= MAX_FILES,
    uploading: pending.some((item) => item.state === 'uploading'),
    paths: pending.flatMap((item) => (item.state === 'ready' ? [item.file.path] : [])),
    failed: pending.some((item) => item.state === 'failed'),
    remove: draft.remove,
    retry: draft.retry,
    clear: draft.clear,
    detach: () => {
      setDraft(new AttachmentDraft())
      return draft
    },
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
          {item.state === 'failed' && (
            <>
              <span className="file-chip-error" role="alert">
                {item.reason}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => void attachments.retry(item.id)}
                aria-label={`Retry ${item.name}`}
              >
                <RotateCcwIcon data-icon="inline-start" />
                Retry
              </Button>
            </>
          )}
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
