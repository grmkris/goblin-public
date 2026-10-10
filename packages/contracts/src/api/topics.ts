import * as Schema from 'effect/Schema'
import * as HttpApiEndpoint from 'effect/http-api/HttpApiEndpoint'
import * as HttpApiGroup from 'effect/http-api/HttpApiGroup'
import * as HttpApiSchema from 'effect/http-api/HttpApiSchema'
import { CreateTopic, TopicView, UpdateTopic } from '../topics.ts'
import { ApiErrors } from './errors.ts'

/** A Topic's id in a path: 1 to 999999999. */
const TopicParam = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 999_999_999 }))

/**
 * The owner's Topics (ADR 0032), the reference group the others copy. Paths are relative to the API's `/api` prefix.
 * Every owner endpoint can also answer owner admission's failures (`OwnerAdmission` in `owner.ts`); `error` names the ones
 * the endpoint itself produces.
 *
 * - `create`: `POST /api/topics`, 201 with the Topic as it is now. The same operation id finds the same Topic.
 * - `update`: `PATCH /api/topics/:id` renames, archives, restores or changes the search opt-out. A name another active
 *   Topic has is a conflict; archiving Personal is invalid input.
 */
export class TopicsGroup extends HttpApiGroup.make('topics').add(
  HttpApiEndpoint.post('create', '/topics', {
    payload: CreateTopic,
    success: TopicView.pipe(HttpApiSchema.status(201)),
    error: [ApiErrors.conflict, ApiErrors.invalidInput],
  }),
  HttpApiEndpoint.patch('update', '/topics/:id', {
    params: { id: TopicParam },
    payload: UpdateTopic,
    success: TopicView,
    error: [ApiErrors.notFound, ApiErrors.conflict, ApiErrors.invalidInput],
  }),
) {}
