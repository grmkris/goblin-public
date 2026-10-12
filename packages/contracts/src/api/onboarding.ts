import * as HttpApiEndpoint from 'effect/http-api/HttpApiEndpoint'
import * as HttpApiGroup from 'effect/http-api/HttpApiGroup'
import { OnboardingChange, OnboardingState, OnboardingView } from '../onboarding.ts'

/**
 * First-run Start (ADR 0048). Paths are relative to the API's `/api` prefix.
 *
 * - `state`: `GET /api/onboarding/status`, whether Start stands before the chats, from what the agent knows locally.
 * - `view`: `GET /api/onboarding`, every step's state, reading the wallet's and Mercator's status as the owner.
 * - `change`: `PUT /api/onboarding`, the owner finishes, skips or reopens Start, or goes through a step.
 */
export class OnboardingGroup extends HttpApiGroup.make('onboarding').add(
  HttpApiEndpoint.get('state', '/onboarding/status', { success: OnboardingState }),
  HttpApiEndpoint.get('view', '/onboarding', { success: OnboardingView }),
  HttpApiEndpoint.put('change', '/onboarding', { payload: OnboardingChange, success: OnboardingView }),
) {}
