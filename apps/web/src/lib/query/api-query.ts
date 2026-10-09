import {
  mutationOptions,
  MutationCache,
  QueryCache,
  QueryClient,
  queryOptions,
  type QueryFunction,
  type QueryKey,
  type QueryMeta,
} from '@tanstack/react-query'
import * as Cause from 'effect/Cause'
import * as Context from 'effect/Context'
import * as Data from 'effect/Data'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Layer from 'effect/Layer'
import * as ManagedRuntime from 'effect/ManagedRuntime'
import * as Option from 'effect/Option'
import * as FetchHttpClient from 'effect/http/FetchHttpClient'
import * as HttpClient from 'effect/http/HttpClient'
import * as HttpClientRequest from 'effect/http/HttpClientRequest'
import { describeError, messageOf, type ErrorKind } from './app-error.ts'

/** A failure outside the call's error channel: a defect, or an interruption (an aborted query). */
export class ApiDefect extends Data.TaggedError('ApiDefect')<{
  readonly message: string
  readonly interrupted: boolean
  readonly cause: unknown
}> {}

/**
 * The operation id a write carries, set around one call with `withOperation`. The app's `headers` read it, so the
 * request names its operation and the agent's logs join the operation's receipt.
 */
export const CurrentOperation = Context.Reference<string | undefined>('goblin/query/CurrentOperation', {
  defaultValue: () => undefined,
})
/** Run `call` as operation `operationId` (its idempotency key, for example a create's `operationId`). */
export const withOperation =
  (operationId: string) =>
  <A, E, R>(call: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.provideService(call, CurrentOperation, operationId)

export interface AppQueryMeta extends Record<string, unknown> {
  readonly auth?: 'optional' | 'required' | undefined
  readonly errorToast?: string | undefined
}
declare module '@tanstack/react-query' {
  interface Register {
    queryMeta: AppQueryMeta
    mutationMeta: AppQueryMeta
  }
}
export interface QueryClientOptions {
  readonly onError?: (error: unknown) => void
  readonly onUnauthenticated?: () => void | Promise<void>
  readonly notify?: (message: string) => void
  readonly codes?: Readonly<Record<string, ErrorKind>>
  readonly signInPath?: string
}

/** Transient failures retry twice; data stays fresh for thirty seconds. */
export const makeQueryClient = (options: QueryClientOptions = {}) => {
  let signingIn = false
  const signIn = async () => {
    await Promise.resolve()
    try {
      await options.onUnauthenticated?.()
    } catch {
      /* A navigation adapter owns its failure; do not replace the original query error. */
    } finally {
      signingIn = false
    }
  }
  const onError = (error: unknown, meta: QueryMeta | undefined) => {
    options.onError?.(error)
    const signInPath = options.signInPath ?? '/login'
    if (
      describeError(error, options.codes).kind !== 'unauthenticated' ||
      meta?.auth === 'optional' ||
      globalThis.location?.pathname === signInPath ||
      signingIn ||
      options.onUnauthenticated === undefined
    )
      return
    signingIn = true
    void signIn()
  }
  return new QueryClient({
    queryCache: new QueryCache({ onError: (error, query) => onError(error, query.meta) }),
    mutationCache: new MutationCache({
      onError: (error, _variables, _context, mutation) => {
        onError(error, mutation.meta)
        if (mutation.meta?.errorToast !== undefined) options.notify?.(messageOf(error, mutation.meta.errorToast))
      },
    }),
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        networkMode: 'online',
        retry: (failures, error) => failures < 2 && describeError(error, options.codes).retryable,
        retryDelay: (attempt, error) =>
          describeError(error, options.codes).retryAfterMs ?? Math.min(1_000 * 2 ** attempt, 30_000),
      },
      mutations: { retry: false, networkMode: 'online' },
    },
  })
}

/** Headers for one outgoing request, given the operation it carries (`withOperation`), if any. */
export type RequestHeaders = (
  request: HttpClientRequest.HttpClientRequest,
  operation: string | undefined,
) => Readonly<Record<string, string>>

export interface ApiQueryOptions<Client> {
  /** A unique service key for this app's client. */
  readonly id: string
  /**
   * The app's typed client, e.g. `HttpApiClient.make(Api, { baseUrl })`. It is passed in rather than built from the
   * HttpApi here: over a generic `Groups`, the client's middleware requirement cannot be shown to be empty.
   */
  readonly client: Effect.Effect<Client, never, HttpClient.HttpClient>
  /** Sent on every request: fixed headers, or headers made for each request (a fresh request id, CSRF on writes). */
  readonly headers?: Readonly<Record<string, string>> | RequestHeaders
  /** Optional transport injection for tests and alternative browser hosts. */
  readonly fetch?: typeof globalThis.fetch
}

/** A runtime holding the app's typed client, with `apiQuery` / `apiMutation` builders over it. */
export function makeApiQuery<Client>(options: ApiQueryOptions<Client>) {
  const ApiClient = Context.Service<Client>(options.id)
  const { headers = {} } = options
  const addHeaders = (request: HttpClientRequest.HttpClientRequest) =>
    Effect.gen(function* () {
      const operation = yield* CurrentOperation
      return HttpClientRequest.setHeaders(
        request,
        typeof headers === 'function' ? headers(request, operation) : headers,
      )
    })
  const WithHeaders = Layer.effect(
    HttpClient.HttpClient,
    Effect.map(HttpClient.HttpClient, HttpClient.mapRequestEffect(addHeaders)),
  ).pipe(
    Layer.provide(
      options.fetch === undefined
        ? FetchHttpClient.layer
        : FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, options.fetch))),
    ),
  )
  const runtime = ManagedRuntime.make(Layer.effect(ApiClient, options.client).pipe(Layer.provide(WithHeaders)))

  /** Run one call; resolve its value or throw its typed failure (or ApiDefect). */
  async function run<A, E extends Error>(
    call: (client: Client) => Effect.Effect<A, E>,
    signal?: AbortSignal,
  ): Promise<A> {
    const exit = await runtime.runPromiseExit(Effect.flatMap(ApiClient, call), signal === undefined ? {} : { signal })
    if (Exit.isSuccess(exit)) return exit.value
    const failure = Cause.findErrorOption(exit.cause)
    if (Option.isSome(failure)) throw failure.value
    const interrupted = Cause.hasInterruptsOnly(exit.cause)
    throw new ApiDefect({
      message: 'Could not complete the request. Try again.',
      interrupted,
      cause: Cause.squash(exit.cause),
    })
  }

  /**
   * Query options for one call. The key is the cache identity, so it names every input of the call; the argument has
   * `queryKey` and `queryFn` so that @tanstack/query/exhaustive-deps checks exactly that.
   */
  const apiQuery = <A, E extends Error, const Key extends QueryKey>(spec: {
    readonly queryKey: Key
    readonly queryFn: (client: Client) => Effect.Effect<A, E>
  }) => {
    const queryFn: QueryFunction<A, Key> = ({ signal }) => run(spec.queryFn, signal)
    return {
      ...queryOptions<A, E | ApiDefect, A, Key>({
        queryKey: spec.queryKey,
        queryFn,
      }),
      queryFn,
    }
  }

  /** Mutation options for one call with its variables; invalidate what it changes in `onSuccess`. */
  const apiMutation = <A, E extends Error, Variables>(spec: {
    readonly mutationFn: (client: Client, variables: Variables) => Effect.Effect<A, E>
  }) =>
    mutationOptions<A, E | ApiDefect, Variables>({
      mutationFn: (variables) => run((client) => spec.mutationFn(client, variables)),
    })

  return { runtime, run, apiQuery, apiMutation }
}
