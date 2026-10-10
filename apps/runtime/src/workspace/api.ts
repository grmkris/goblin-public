import { OwnerApi } from '@goblin/contracts/api'
import * as Effect from 'effect/Effect'
import * as HttpServerResponse from 'effect/http/HttpServerResponse'
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder'
import { Workspace } from './service.ts'

/**
 * The `workspace` group: the feed, server-sent. The stream is its own: it runs until the browser goes away, past the
 * request's scope, and lets go of the feed then.
 */
export const WorkspaceHandlers = HttpApiBuilder.group(OwnerApi, 'workspace', (handlers) =>
  handlers.handleRaw('events', () =>
    Effect.map(
      Workspace.use((workspace) => workspace.events),
      (response) => HttpServerResponse.raw(response),
    ),
  ),
)
