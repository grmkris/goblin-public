// The one upgrade prompt (ADR 0054): any API call that fails with `SubscriptionRequired` for a feature the plan leaves
// out asks the owner, once, whether to see Pro, naming the feature. A refusal for want of any plan (`chat`, or none
// named) asks nothing: the plan is read again, and the composer and the page's gate say what to do. The query client's
// error hook feeds it (`router.tsx`), so no call wires it itself. One store per router, never module state.
import * as Predicate from 'effect/Predicate'

/** What the prompt shows: the feature that needs Pro, and where Pro is offered. */
export interface UpgradeAsk {
  readonly feature: string
  readonly subscribe: string
}

export interface UpgradePrompts {
  /** An API failure: a `SubscriptionRequired` for a feature asks, one for any plan reads the plan again. */
  readonly offer: (error: unknown) => void
  /** The owner said Not now (or went to see Pro): the same feature does not ask again this session. */
  readonly dismiss: () => void
  /** An ask that does not apply (an account with no plan at all, whose composer and gate offer the plans). */
  readonly clear: () => void
  readonly current: () => UpgradeAsk | undefined
  readonly subscribe: (listener: () => void) => () => void
}

const SUBSCRIBE = '/subscribe'
/** The feature an account without a plan is refused: goblin itself. */
const PLAN = 'chat'

/** A path of this app (the error's `subscribe`), never another origin; `/subscribe` otherwise. */
const pathOf = (value: unknown): string =>
  Predicate.isString(value) && value.startsWith('/') && !value.startsWith('//') ? value : SUBSCRIBE

/** The error's feature, as a short code; anything else is no feature. */
const featureOf = (error: object): string | undefined => {
  const feature = Predicate.hasProperty(error, 'feature') ? error.feature : undefined
  return Predicate.isString(feature) && /^[a-z][a-z_-]{0,40}$/u.test(feature) ? feature : undefined
}

export interface UpgradePromptOptions {
  /** A refusal for want of any plan: the plan the page holds is out of date, so it is read again. */
  readonly planGone?: () => void
}

export function makeUpgradePrompts(options: UpgradePromptOptions = {}): UpgradePrompts {
  let current: UpgradeAsk | undefined
  /** Features the owner said Not now to: a page that keeps failing does not ask again. */
  const declined = new Set<string>()
  const listeners = new Set<() => void>()
  const set = (next: UpgradeAsk | undefined) => {
    current = next
    for (const listener of listeners) listener()
  }
  return {
    offer: (error) => {
      if (!Predicate.isTagged(error, 'SubscriptionRequired') || !Predicate.isObject(error)) return
      if (typeof location !== 'undefined' && location.pathname.startsWith(SUBSCRIBE)) return
      const feature = featureOf(error)
      if (feature === undefined || feature === PLAN) {
        options.planGone?.()
        return
      }
      const ask: UpgradeAsk = {
        feature,
        subscribe: pathOf(Predicate.hasProperty(error, 'subscribe') ? error.subscribe : undefined),
      }
      if (current !== undefined || declined.has(feature)) return
      set(ask)
    },
    dismiss: () => {
      if (current !== undefined) declined.add(current.feature)
      set(undefined)
    },
    clear: () => set(undefined),
    current: () => current,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

/** What the prompt says a feature is, in the owner's words: known ones by name, any other as "this". */
const FEATURES: Readonly<Record<string, string>> = {
  hand_over: 'Handing an event or a schedule to goblin or a Persona is part of Pro.',
  subagents: 'Subagents take long jobs off your hands. They are part of Pro.',
}

export const featureLine = (feature: string | undefined): string =>
  (feature === undefined ? undefined : FEATURES[feature]) ?? 'This is part of goblin Pro.'
