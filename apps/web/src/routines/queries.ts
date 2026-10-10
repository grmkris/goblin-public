import { type QueryClient, mutationOptions, queryOptions, skipToken } from '@tanstack/react-query'
import type { RoutineDefinition, RoutineSettings } from '@goblin/contracts'
import { owner } from '../lib/api.ts'
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
  readonly definition: RoutineDefinition
  readonly routine?: { readonly id: string; readonly revision: number }
}
export const saveRoutineMutation = mutationOptions({
  ...owner.apiMutation({
    mutationFn: (api, { operationId, definition, routine }: RoutineSave) =>
      withOperation(operationId)(
        routine === undefined
          ? api.routines.propose({ payload: { operationId, definition } })
          : api.routines.edit({
              params: { id: routine.id },
              payload: { operationId, definition, revision: routine.revision },
            }),
      ),
  }),
  onSuccess: (_routine, _save, _result, { client }) => listChanged(client),
})

/** Confirm (or resume), pause or archive one revision of a routine. */
export type RoutineChange = {
  readonly action: 'confirm' | 'pause' | 'archive'
  readonly id: string
  readonly revision: number
  readonly operationId: string
}
export const changeRoutineMutation = mutationOptions({
  ...owner.apiMutation({
    mutationFn: (api, { action, id, revision, operationId }: RoutineChange) => {
      const request = { params: { id }, payload: { revision, operationId } }
      const call =
        action === 'archive'
          ? api.routines.archive(request)
          : action === 'pause'
            ? api.routines.pause(request)
            : api.routines.confirm(request)
      return withOperation(operationId)(call)
    },
  }),
  onSuccess: (_routine, _change, _result, { client }) => listChanged(client),
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
