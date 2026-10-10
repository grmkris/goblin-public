import { OwnerApi } from '@goblin/contracts/api'
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder'
import { createTopic, editTopicSetup, updateTopic } from './program.ts'

/**
 * The `topics` group (ADR 0032), the reference the other groups copy: each handler runs its program. Owner admission
 * has already admitted the request; a program's `AppError` is answered in its envelope, and services come from the
 * agent's runtime.
 */
export const TopicsHandlers = HttpApiBuilder.group(OwnerApi, 'topics', (handlers) =>
  handlers
    .handle('create', ({ payload }) => createTopic(payload, { actor: 'owner' }))
    .handle('update', ({ params, payload }) => updateTopic(params.id, payload))
    .handle('setSetup', ({ params, payload }) => editTopicSetup(params.id, payload)),
)
