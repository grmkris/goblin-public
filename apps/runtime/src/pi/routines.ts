import { defineExtension, section } from '@earendil-works/pi-durable'
import * as Schema from 'effect/Schema'
import {
  PersonaName,
  RoutineDefinition,
  RoutineHandOverFields,
  RoutinePage,
  RoutineTellMe,
  RoutineTrigger,
  RoutineView,
} from '@goblin/contracts'
import { changeRoutine, proposeAsked, routinesList } from '../routines/program.ts'
import type { RunProgram } from '../runtime/bridge.ts'
import { typedTool } from './typed-tool.ts'

const operationOf = (api: { readonly conversationId: unknown; readonly callId: string }) =>
  `routine:${String(api.conversationId)}:${api.callId}`

/** A draft the owner must review: its id, the revision they will confirm, and its title. */
const Proposed = Schema.Struct({ routineId: Schema.String, revision: Schema.Int, title: Schema.String })

/** Who the model hands a routine's work to: nobody, Goblin, or a Persona by its name (its revision is pinned for it). */
const AskedHandTo = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('none') }),
  Schema.Struct({ kind: Schema.Literal('goblin'), ...RoutineHandOverFields }),
  Schema.Struct({ kind: Schema.Literal('persona'), persona: PersonaName, ...RoutineHandOverFields }),
])

/** A routine as the model proposes it (ADR 0041): its definition, the Persona by name, and another Topic by name. */
const Asked = Schema.Struct({
  title: RoutineDefinition.fields.title,
  trigger: RoutineTrigger,
  timezone: RoutineDefinition.fields.timezone,
  tellMe: RoutineTellMe,
  handTo: AskedHandTo,
  topic: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(80))),
}).check(
  Schema.makeFilter(
    (asked) =>
      asked.handTo.kind !== 'none' || asked.tellMe.on || 'A routine that hands nothing over must tell the owner.',
  ),
)

const proposeTool = (run: RunProgram) =>
  typedTool({
    name: 'routine_propose',
    description:
      "Propose a routine: what happens at a time (`trigger: { kind: 'once', at }`), on a schedule (`{ kind: 'cron', expression }`), or when a connection sends an event (`{ kind: 'event', connectionId, name, arguments }`, with a name and arguments from that connection's `events`, which mcp_list lists with `events: true`). `tellMe` (`{ on, telegram }`) tells the owner of everything it posts: each event as a notice, and the answer. `handTo` gives the work to nobody (`{ kind: 'none' }`, then `tellMe.on` must be true), to Goblin (`{ kind: 'goblin', instruction, allowedTools, budget }`) or to a Persona by its name (`{ kind: 'persona', persona, instruction, allowedTools, budget }`). It lives in this chat's Topic unless `topic` names another. Proposing does not activate it: the owner reviews and confirms it in Settings → Routines, which ends this turn.",
    input: Asked,
    output: Proposed,
    replay: 'safe',
    execute: async (asked, api) => {
      const draft = await run(proposeAsked(asked, operationOf(api), String(api.conversationId)))
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
          'Use routine_propose to propose a reminder, a schedule, or what happens when a connection sends an event: tell the owner (Tell me), hand the work to Goblin or a Persona (Hand to), or both. When the owner connects something that sends events, offer to set one up. The owner reviews and confirms the exact definition in Settings → Routines before it can run. You may list (routine_list) or pause (routine_pause) routines; you cannot activate them.',
      ),
    ],
    tools: [proposeTool(run), listTool(run), pauseTool(run)],
  })
}
