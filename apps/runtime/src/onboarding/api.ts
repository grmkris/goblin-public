import { OwnerApi } from '@goblin/contracts/api'
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder'
import { changeOnboarding, onboardingState, onboardingView, startConnect } from './program.ts'

/** The `onboarding` group (ADR 0048): Start's state for the gate, its whole view, the owner's changes and sign-ins. */
export const OnboardingHandlers = HttpApiBuilder.group(OwnerApi, 'onboarding', (handlers) =>
  handlers
    .handle('state', () => onboardingState)
    .handle('view', () => onboardingView)
    .handle('change', ({ payload }) => changeOnboarding(payload))
    .handle('connect', ({ payload }) => startConnect(payload)),
)
