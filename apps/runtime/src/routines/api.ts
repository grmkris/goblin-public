import { OwnerApi } from '@goblin/contracts/api'
import * as Effect from 'effect/Effect'
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder'
import { attemptSync } from '../http/errors.ts'
import { routineChange } from './controller.ts'
import { editRoutine, proposeRoutine, routinesList, setRoutineSettings } from './program.ts'
import { runView } from './runs.ts'
import { RoutineControl, RoutineRuns, Routines } from './service.ts'

/**
 * The `routines` group (ADR 0012): each handler runs the program its Durable Object RPC method ran. The owner gate has
 * already admitted the request; a program's `AppError` is answered in its envelope.
 */
export const RoutinesHandlers = HttpApiBuilder.group(OwnerApi, 'routines', (handlers) =>
  handlers
    .handle('list', () => routinesList)
    .handle('propose', ({ payload }) => proposeRoutine(payload.definition, payload.operationId))
    .handle('settings', () => Routines.use((store) => store.settings))
    .handle('updateSettings', ({ payload }) => setRoutineSettings(payload))
    .handle('edit', ({ params, payload }) =>
      Effect.tap(editRoutine(params.id, payload), () => RoutineControl.use((control) => control.reconcile)),
    )
    .handle('archive', ({ params, payload }) => routineChange(params.id, payload, 'archive'))
    .handle('confirm', ({ params, payload }) => routineChange(params.id, payload, 'confirm'))
    .handle('pause', ({ params, payload }) => routineChange(params.id, payload, 'pause'))
    .handle('run', ({ params, payload }) =>
      RoutineControl.use((control) =>
        Effect.flatMap(control.manual(params.id, payload), (run) => attemptSync(() => runView(run))),
      ),
    )
    .handle('runs', ({ params }) =>
      RoutineRuns.use((runs) => Effect.map(runs.list(params.id), (list) => ({ runs: list }))),
    ),
)
