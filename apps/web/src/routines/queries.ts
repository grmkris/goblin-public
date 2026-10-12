import { type QueryClient, mutationOptions, queryOptions, skipToken } from '@tanstack/react-query'
import type { RoutineDefinition, RoutineSettings } from '@goblin/contracts'
import * as Effect from 'effect/Effect'
import { owner } from '../lib/api.ts'
import { mcpKeys } from '../mcp/queries.ts'
import { withOperation } from '../lib/query/api-query.ts'

/**
 * The owner's routines on the owner API (ADR 0012). Keys are `['routines', kind, input]`. Every change carries the
 * revision it was made against and an operation id, sent as the request's operation: a stale revision is a conflict,
 * and the same operation answers the same result. Each change settles once the list is fresh.
 */
const routineKeys = {
  list: ['routines', 'list'] as const,
  settings: ['routines', 'settings'] as const,
  runs: (id: string) => ['routines', 'runs', id] as const,
}

/** Every routine but the archived ones. */
export const routinesQuery = owner.apiQuery({ queryKey: routineKeys.list, queryFn: (api) => api.routines.list() })
/** The routines as they are now, for a proposal's review: nothing until `open`, then never a cached list. */
export const reviewedRoutinesQuery = (open: boolean) =>
  queryOptions({ queryKey: routineKeys.list, queryFn: open ? routinesQuery.queryFn : skipToken, staleTime: 0 })
/** The timezone new routines use, and the active and running caps. */
export const routineSettingsQuery = owner.apiQuery({
  queryKey: routineKeys.settings,
  queryFn: (api) => api.routines.settings(),
})
/** A routine's newest runs. */
export const routineRunsQuery = (id: string) =>
  owner.apiQuery({ queryKey: routineKeys.runs(id), queryFn: (api) => api.routines.runs({ params: { id } }) })

const listChanged = (client: QueryClient) => client.invalidateQueries({ queryKey: routineKeys.list })

/** Changes the timezone (and caps) new routines use; the answer is the settings as they are now. */
export const routineSettingsMutation = mutationOptions({
  ...owner.apiMutation({
    mutationFn: (api, settings: RoutineSettings) => api.routines.updateSettings({ payload: settings }),
  }),
  onSuccess: (settings, _change, _result, { client }) => client.setQueryData(routineKeys.settings, settings),
})

/** A new routine as a draft, or an edit of one as a new revision back in draft; it runs only once confirmed. */
export type RoutineSave = {
  readonly operationId: string
  /** The Topic it lives in, runs in and posts to. */
  readonly topic: number
  readonly definition: RoutineDefinition
  readonly routine?: { readonly id: string; readonly revision: number }
}
export const saveRoutineMutation = mutationOptions({
  ...owner.apiMutation({
    mutationFn: (api, { operationId, topic, definition, routine }: RoutineSave) =>
      withOperation(operationId)(
        routine === undefined
          ? api.routines.propose({ payload: { operationId, topic, definition } })
          : api.routines.edit({
              params: { id: routine.id },
              payload: { operationId, topic, definition, revision: routine.revision },
            }),
      ),
  }),
  onSuccess: (_routine, _save, _result, { client }) => listChanged(client),
})

/**
 * Confirm (or resume), confirm again (a routine whose Persona changed is pinned to it as it is now), pause or archive
 * one revision of a routine.
 */
export type RoutineChange = {
  readonly action: 'confirm' | 'confirmAgain' | 'pause' | 'archive'
  readonly id: string
  readonly revision: number
  readonly operationId: string
}
export const changeRoutineMutation = mutationOptions({
  ...owner.apiMutation({
    mutationFn: (api, { action, id, revision, operationId }: RoutineChange) => {
      const request = { params: { id }, payload: { revision, operationId } }
      const call = {
        archive: () => api.routines.archive(request),
        pause: () => api.routines.pause(request),
        confirm: () => api.routines.confirm(request),
        confirmAgain: () => api.routines.confirmAgain(request),
      }[action]()
      return withOperation(operationId)(call)
    },
  }),
  onSuccess: async (_routine, { action }, _result, { client }) => {
    await listChanged(client)
    // A confirmed event routine answers its connection's offer of events (ADR 0041).
    if (action === 'confirm' || action === 'confirmAgain') await client.invalidateQueries({ queryKey: mcpKeys.servers })
  },
})

/** One event the owner set up from a connection's picker: its routine, in its Topic, under one operation. */
export type EventSetUpRequest = {
  readonly operationId: string
  readonly topic: number
  readonly definition: RoutineDefinition
}
/**
 * The events the owner picked, set up in one step (ADR 0041): each is proposed, then confirmed at the revision it was
 * proposed at, one after the other, so each confirmation grants exactly its own selector. The first failure stops the
 * rest; what was set up before it stays, and the routines and servers are read again either way.
 */
export const setUpEventsMutation = mutationOptions({
  ...owner.apiMutation({
    mutationFn: (api, requests: readonly EventSetUpRequest[]) =>
      Effect.forEach(requests, ({ operationId, topic, definition }) =>
        Effect.gen(function* () {
          const proposed = yield* withOperation(operationId)(
            api.routines.propose({ payload: { operationId, topic, definition } }),
          )
          const confirm = `${operationId}:confirm`
          return yield* withOperation(confirm)(
            api.routines.confirm({
              params: { id: proposed.id },
              payload: { revision: proposed.revision, operationId: confirm },
            }),
          )
        }),
      ),
  }),
  onSettled: async (_routines, _error, _requests, _result, { client }) => {
    await listChanged(client)
    await client.invalidateQueries({ queryKey: mcpKeys.servers })
  },
})

/** Runs a routine now; the run it admitted (or skipped) shows in its runs. */
export const runRoutineMutation = mutationOptions({
  ...owner.apiMutation({
    mutationFn: (api, { id, revision, operationId }: Omit<RoutineChange, 'action'>) =>
      withOperation(operationId)(
        api.routines.run({ params: { id }, payload: { revision, operationId, confirmRun: true } }),
      ),
  }),
  onSuccess: (_run, { id }, _result, { client }) => client.invalidateQueries({ queryKey: routineKeys.runs(id) }),
})

/** Stops a routine's live run by stopping its conversation; its runs are read again. */
export const stopRunMutation = mutationOptions({
  ...owner.apiMutation({
    mutationFn: (api, { chat }: { readonly routineId: string; readonly run: string; readonly chat: string }) =>
      api.conversations.stop({ params: { id: chat }, payload: {} }),
  }),
  onSuccess: (_stopped, { routineId }, _result, { client }) =>
    client.invalidateQueries({ queryKey: routineKeys.runs(routineId) }),
})
