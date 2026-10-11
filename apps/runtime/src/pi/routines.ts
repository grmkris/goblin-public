import { defineExtension, section } from '@earendil-works/pi-durable'
import * as Schema from 'effect/Schema'
import { RoutineDefinition, RoutinePage, RoutineView } from '@goblin/contracts'
import { changeRoutine, proposeRoutineFrom, routinesList } from '../routines/program.ts'
import type { RunProgram } from '../runtime/bridge.ts'
import { typedTool } from './typed-tool.ts'

const operationOf = (api: { readonly conversationId: unknown; readonly callId: string }) =>
  `routine:${String(api.conversationId)}:${api.callId}`

/** A draft the owner must review: its id, the revision they will confirm, and its title. */
const Proposed = Schema.Struct({ routineId: Schema.String, revision: Schema.Int, title: Schema.String })

const proposeTool = (run: RunProgram) =>
  typedTool({
    name: 'routine_propose',
    description:
      "Propose a routine: what happens at a time, on a schedule, or when a connection sends an event. `handTo` gives the work to Goblin (`{ kind: 'goblin', instruction, allowedTools, budget }`); `tellMe` (`{ on, telegram }`) tells the owner of what it posts. It lives in this chat's Topic. Proposing does not activate it: the owner reviews and confirms it in Settings → Routines, which ends this turn.",
    input: RoutineDefinition,
    output: Proposed,
    replay: 'safe',
    execute: async (definition, api) => {
      const draft = await run(proposeRoutineFrom(definition, operationOf(api), String(api.conversationId)))
      return { routineId: draft.id, revision: draft.revision, title: draft.definition.title }
    },
    text: ({ title, revision }) =>
      `Proposed routine "${title}", revision ${String(revision)}. The owner must review and confirm it in Settings → Routines.`,
    details: ({ routineId, revision }) => ({ kind: 'routine-proposal', routineId, revision }),
    terminate: () => true,
  })

const listTool = (run: RunProgram) =>
  typedTool({
    name: 'routine_list',
    description: "The owner's routines with their state, definition and schedule.",
    input: Schema.Struct({}),
    output: RoutinePage,
    replay: 'safe',
    execute: async () => run(routinesList),
  })

const pauseTool = (run: RunProgram) =>
  typedTool({
    name: 'routine_pause',
    description: 'Pause a routine by its id at its current revision (from routine_list). Only the owner can resume it.',
    input: Schema.Struct({ id: Schema.String.check(Schema.isMaxLength(100)), revision: Schema.Int }),
    output: RoutineView,
    replay: 'safe',
    execute: async ({ id, revision }, api) =>
      run(changeRoutine(id, { revision, operationId: operationOf(api) }, 'pause')),
  })

/** The model proposes a draft; only the authenticated owner's review may confirm it. */
export function routinesExtension(run: RunProgram) {
  return defineExtension({
    name: 'goblin.routines',
    sections: [
      section(
        'routines',
        () =>
          'Use routine_propose to propose a scheduled reminder or event-driven task. The owner reviews and confirms the exact definition in Settings → Routines before it can run. You may list (routine_list) or pause (routine_pause) routines; you cannot activate them.',
      ),
    ],
    tools: [proposeTool(run), listTool(run), pauseTool(run)],
  })
}
