import { ApiError } from '@goblin/wallet/contract'
import * as Data from 'effect/Data'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import { useCallback, useState } from 'react'

/** The step a signing flow is on, for a progress line. */
export type FlowStep = 'preparing' | 'checking' | 'signing' | 'submitting' | 'confirming'

/**
 * Where one signing flow stands. `code` is stable (e.g. `rejected` when the owner closed Privy's screen,
 * `allowance_mismatch` when what the server asked to sign is not what the owner chose); `message` is for people.
 */
export type FlowState =
  | { readonly status: 'idle' }
  | { readonly status: 'working'; readonly step: FlowStep }
  | { readonly status: 'done' }
  | { readonly status: 'error'; readonly code: string; readonly message: string }

/** A signing flow that stopped: a stable code and a sentence for the owner. */
export class FlowFailure extends Data.TaggedError('FlowFailure')<{ readonly code: string; readonly message: string }> {}

const REJECTED = /reject|denied|cancel|closed|exited/iu

/** Any failure as a flow failure: Privy's "the user closed the screen" as `rejected`, our own `code: message` errors kept. */
export const asFailure = (cause: unknown): FlowFailure => {
  if (cause instanceof FlowFailure) return cause
  const text = cause instanceof Error ? cause.message : String(cause)
  if (REJECTED.test(text))
    return new FlowFailure({ code: 'rejected', message: 'You closed the signature; nothing was signed.' })
  const coded = /^([a-z_]{3,40}): (.{1,300})/u.exec(text)
  return new FlowFailure({
    code: coded?.[1] ?? 'failed',
    message: coded?.[2] ?? 'Signing did not finish. Try again in a moment.',
  })
}

export interface Flow {
  readonly state: FlowState
  /** Runs one flow: `working` with the step it reports, `done` when it resolves, `error` (and a rejection) otherwise. */
  readonly run: <T>(body: (step: (next: FlowStep) => void) => Promise<T>) => Promise<T>
  readonly reset: () => void
}

export function useFlow(): Flow {
  const [state, setState] = useState<FlowState>({ status: 'idle' })
  const run = useCallback(async <T>(body: (step: (next: FlowStep) => void) => Promise<T>): Promise<T> => {
    setState({ status: 'working', step: 'preparing' })
    try {
      const result = await body((step) => setState({ status: 'working', step }))
      setState({ status: 'done' })
      return result
    } catch (cause) {
      const failure = asFailure(cause)
      setState({ status: 'error', code: failure.code, message: failure.message })
      throw failure
    }
  }, [])
  const reset = useCallback(() => setState({ status: 'idle' }), [])
  return { state, run, reset }
}

const decodeApiError = Schema.decodeUnknownOption(ApiError)

type Route = { readonly method: string; readonly path: string; readonly response: Schema.Decoder<unknown> }

/** One owner API call with the Privy bearer token; the answer decoded with the route's own schema. */
export async function ownerCall<R extends Route>(
  getToken: () => Promise<string | null>,
  route: R,
  options: { readonly params?: Readonly<Record<string, string>>; readonly body?: unknown } = {},
): Promise<R['response']['Type']> {
  const token = await getToken()
  if (token === null) throw new FlowFailure({ code: 'signed_out', message: 'You are signed out. Sign in again.' })
  const path = route.path.replace(/:(\w+)/gu, (_, name: string) => encodeURIComponent(options.params?.[name] ?? ''))
  const response = await fetch(path, {
    method: route.method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  })
  // expected: an error page that is not JSON is answered with the status line below
  const body: unknown = await response.json().catch(() => undefined)
  if (!response.ok) {
    const error = Option.getOrUndefined(decodeApiError(body))?.error
    throw new FlowFailure({
      code: error?.code ?? `http_${response.status}`,
      message:
        error === undefined
          ? `The wallet answered ${response.status}.`
          : `${error.message} ${error.recovery ?? ''}`.trim(),
    })
  }
  return Schema.decodeUnknownSync(route.response)(body)
}
