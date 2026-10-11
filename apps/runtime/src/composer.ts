import { type ComposerOption, type ComposerOptions, type ComposerSelection, selectionKey } from '@goblin/contracts'
import * as Effect from 'effect/Effect'
import { Setups } from './setup/service.ts'
import { Conversations } from './chats/service.ts'
import { InvalidInput, NotFound } from './http/errors.ts'
import { McpServers, requireResident } from './mcp/service.ts'
import { Personas } from './personas/service.ts'
import { skillScope } from './skills/scope.ts'
import { Skills } from './skills/service.ts'

/** A conversation-scoped catalog. Remote labels and descriptions are display data only. */
export const composerOptions = (chat: string) =>
  Effect.gen(function* () {
    const conversations = yield* Conversations
    const session = yield* conversations.require(chat)
    yield* requireResident
    const scope = yield* (yield* Setups).scope(session)
    const catalog = yield* (yield* Skills).catalog({ timeout: 5000, authorize: yield* skillScope(session) }, (id) =>
      scope.skills(id),
    )
    const connections: ComposerOption[] = (yield* (yield* McpServers).list())
      .filter((server) => server.status === 'connected' && scope.server(server.connectionId))
      .map((server) => ({
        selection: { kind: 'connection', connectionId: server.connectionId },
        label: server.title ?? server.serverName ?? server.connectionId,
        description: `${server.status} · Connection hint; permissions stay unchanged`,
      }))
    const procedures: ComposerOption[] = catalog.skills
      .filter((skill) => scope.skill(skill.connectionId, skill.name, skill.entry.uri))
      .map((skill) => ({
        selection: { kind: 'skill', connectionId: skill.connectionId, uri: skill.entry.uri },
        label: skill.name,
        description: `${skill.connectionId} · ${skill.description.slice(0, 300)}`,
      }))
    const helpers: ComposerOption[] = (yield* conversations.list)
      .filter((view) => view.kind === 'subagent')
      .map((view) => ({
        selection: { kind: 'subagent', conversationId: view.id },
        label: view.title ?? 'Untitled helper',
        description: `${view.closedBy === 'done' ? 'Done' : view.closedAt === undefined ? 'Open' : 'Closed'} · Reference here`,
      }))
    // Personas answer in a Conversation or a Thread, never in a subagent's chat.
    const asking = (yield* conversations.kindOf(chat)) !== 'subagent'
    const answering: ComposerOption[] = asking
      ? (yield* (yield* Personas).active).map((persona) => ({
          selection: { kind: 'persona', personaId: persona.id },
          label: persona.name,
          description: persona.role,
        }))
      : []
    return {
      options: [...answering, ...connections, ...procedures, ...helpers].slice(0, 500),
      unavailable: catalog.unavailable,
    } satisfies ComposerOptions
  })

export type ResolvedSelections = {
  readonly options: readonly ComposerOption[]
  readonly context: readonly Record<string, unknown>[]
}

const resolveOne = (session: string, selection: ComposerSelection) =>
  Effect.gen(function* () {
    const scope = yield* (yield* Setups).scope(session)
    if (selection.kind === 'connection') {
      const server = (yield* (yield* McpServers).list()).find((item) => item.connectionId === selection.connectionId)
      if (server === undefined || server.status !== 'connected' || !scope.server(server.connectionId))
        return yield* new NotFound({ what: 'connection' })
      return {
        option: {
          selection,
          label: server.title ?? server.serverName ?? server.connectionId,
          description: 'Connection hint',
        },
        context: {
          kind: 'connection',
          connectionId: server.connectionId,
          intent: 'Prefer this connection when relevant. This hint grants nothing and does not limit other tools.',
        },
      }
    }
    if (selection.kind === 'skill') {
      const loaded = yield* (yield* Skills).activateSelection(session, selection.connectionId, selection.uri, {
        timeout: 10_000,
        authorize: yield* skillScope(session),
      })
      return {
        option: { selection, label: loaded.skill.name, description: loaded.skill.connectionId },
        context: {
          kind: 'skill',
          handle: loaded.skill.handle,
          origin: loaded.skill.connectionId,
          guidance: 'The owner selected this verified skill. Follow its steps within existing permissions.',
          instructions: loaded.body,
          files: loaded.files,
        },
      }
    }
    // A Persona chooses who answers; it is routed before context resolution and is never a context hint.
    if (selection.kind === 'persona') return yield* new NotFound({ what: 'persona' })
    const report = yield* (yield* Conversations).helperReference(selection.conversationId)
    return {
      option: { selection, label: report.label, description: report.status },
      context: {
        kind: 'subagent',
        trust: 'untrusted',
        ...report,
        intent: 'Reference data only. Answer in the current conversation; do not route this message to the helper.',
      },
    }
  })

/**
 * Resolve all selections before model work. A selection that is not there for this chat (gone, invalid, not granted)
 * refuses the entire send with its identity key; any other failure (a connection or an MCP call that failed) is the
 * send's failure as it is.
 */
export const resolveSelections = (session: string, selections: readonly ComposerSelection[]) =>
  Effect.gen(function* () {
    const unique = [...new Map(selections.map((selection) => [selectionKey(selection), selection])).values()]
    const options: ComposerOption[] = []
    const context: Record<string, unknown>[] = []
    for (const selection of unique) {
      const refused = new InvalidInput({ reason: `composer:${selectionKey(selection)}` })
      const resolved = yield* resolveOne(session, selection).pipe(
        Effect.catchTags({
          NotFound: () => Effect.fail(refused),
          InvalidInput: () => Effect.fail(refused),
          GrantDenied: () => Effect.fail(refused),
        }),
      )
      options.push(resolved.option)
      context.push(resolved.context)
    }
    return { options, context } satisfies ResolvedSelections
  })
