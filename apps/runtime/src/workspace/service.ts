import type { WorkspaceChange, WorkspaceSnapshot } from '@goblin/contracts'
import * as Context from 'effect/Context'
import type * as Stream from 'effect/Stream'
import type { AppError } from '../http/errors.ts'

/** One event of the feed: the snapshot it starts with, then each batch of changes after it. */
export type WorkspaceEvent =
  | { readonly event: 'snapshot'; readonly data: WorkspaceSnapshot }
  | { readonly event: 'change'; readonly data: readonly WorkspaceChange[] }

/**
 * The owner's workspace as one live feed: every conversation and what each is doing, Apps, Home, Topics, Personas,
 * invocations, receipts and decision proposals, so a client needs no polling and no stream per conversation to draw
 * the tree. A client that reconnects starts again from a fresh snapshot.
 */
export class Workspace extends Context.Service<
  Workspace,
  {
    /**
     * The snapshot, then each batch of changes after it, never older than what the snapshot shows. The stream holds
     * its own subscription and the watch of Pi's task graph while it runs; both end with it.
     */
    readonly stream: Stream.Stream<WorkspaceEvent, AppError>
  }
>()('goblin/workspace/Workspace') {}
