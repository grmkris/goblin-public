import * as Schema from 'effect/Schema'
import * as HttpApiEndpoint from 'effect/http-api/HttpApiEndpoint'
import * as HttpApiGroup from 'effect/http-api/HttpApiGroup'
import { DecisionLabel, DecisionProposal } from '../decisions.ts'
import { ApiErrors } from './errors.ts'

/** A proposal's id in a path: `dp_` and up to 120 letters, digits, underscores or dashes. */
const ProposalParam = Schema.String.check(Schema.isPattern(/^dp_[\w-]{1,120}$/u))

/**
 * The owner's labels of typed decision proposals (ADR 0031); the workspace feed carries the proposals. Paths are
 * relative to the API's `/api` prefix.
 *
 * - `label`: `POST /api/decisions/:id` confirms or dismisses an open proposal and answers it as it is now. The first
 *   label wins: the same label again answers the same proposal, the other one is a conflict (`settled`), and so is
 *   confirming a proposal a newer exchange made stale (`stale`).
 */
export class DecisionsGroup extends HttpApiGroup.make('decisions').add(
  HttpApiEndpoint.post('label', '/decisions/:id', {
    params: { id: ProposalParam },
    payload: DecisionLabel,
    success: DecisionProposal,
    error: [ApiErrors.notFound, ApiErrors.conflict],
  }),
) {}
