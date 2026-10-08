import type { Attachment } from '@goblin/contracts'
import { failureText } from './boundary.ts'
import { uploadAttachment } from './files.ts'

export type PendingAttachment =
  | { readonly id: number; readonly name: string; readonly state: 'uploading' }
  | { readonly id: number; readonly name: string; readonly state: 'ready'; readonly file: Attachment }
  | {
      readonly id: number
      readonly name: string
      readonly state: 'failed'
      readonly reason: string
      readonly source: File
    }

/** One portable draft: in-flight uploads continue when /new-thread moves its composer. */
export class AttachmentDraft {
  #pending: readonly PendingAttachment[] = []
  #next = 0
  readonly #listeners = new Set<() => void>()
  readonly #uploadFile: typeof uploadAttachment
  constructor(upload = uploadAttachment) {
    this.#uploadFile = upload
  }
  readonly snapshot = () => this.#pending
  readonly subscribe = (listener: () => void) => {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }
  #set(pending: readonly PendingAttachment[]): void {
    this.#pending = pending
    for (const listener of this.#listeners) listener()
  }
  readonly clear = () => this.#set([])
  readonly remove = (id: number) => this.#set(this.#pending.filter((item) => item.id !== id))
  readonly retry = async (id: number): Promise<void> => {
    const failed = this.#pending.find((item) => item.id === id)
    if (failed?.state !== 'failed') return
    const file = failed.source
    this.#set(this.#pending.map((item) => (item.id === id ? { id, name: file.name, state: 'uploading' } : item)))
    await this.#upload(id, file)
  }
  readonly add = async (files: readonly File[]): Promise<void> => {
    const picked = files
      .slice(0, Math.max(0, 8 - this.#pending.length))
      .map((file) => ({ file, id: (this.#next += 1) }))
    const taken = new Set(this.#pending.flatMap((item) => (item.state === 'ready' ? [item.file.name] : [])))
    this.#set([
      ...this.#pending,
      ...picked.map(({ file, id }): PendingAttachment => ({ id, name: file.name, state: 'uploading' })),
    ])
    for (const { file, id } of picked) {
      if (this.#pending.some((item) => item.id === id)) await this.#upload(id, file, taken)
    }
  }
  async #upload(id: number, file: File, taken = new Set<string>()): Promise<void> {
    try {
      const uploaded = await this.#uploadFile(file, taken)
      this.#set(
        this.#pending.map((item) =>
          item.id === id ? { id, name: uploaded.name, state: 'ready', file: uploaded } : item,
        ),
      )
    } catch (error) {
      this.#set(
        this.#pending.map((item) =>
          item.id === id ? { id, name: file.name, state: 'failed', reason: failureText(error), source: file } : item,
        ),
      )
    }
  }
}
