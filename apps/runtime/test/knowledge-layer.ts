import type { PiHarness } from 'agents/harness/pi'
import * as Layer from 'effect/Layer'
import type { ChatDirectory } from '../src/chats/directory.ts'
import { ChatOperations, Chats } from '../src/chats/service.ts'
import { attemptSync } from '../src/http/errors.ts'
import { KnowledgeLive } from '../src/layers/knowledge.ts'
import { CheapModels } from '../src/memory/model.ts'
import { KeyedLock } from '../src/observability/lock.ts'
import { Db } from '../src/runtime/db.ts'
import { AgentInput, type AgentInputs } from '../src/runtime/input.ts'
import { Learner, Skills } from '../src/skills/service.ts'
import { type ChatDatabase, sqliteDb } from './chats-sqlite.ts'
import { unread } from './fake.ts'

/** The database and started instances the knowledge layer reads; a test gives the ones its programs reach. */
type Given = {
  /** The memory tables (chats-sqlite.ts). */
  readonly db?: ChatDatabase
  /** The chats, as the memory's status reads them: Personal, and the Conversation a chat sits under. */
  readonly chats?: ChatDirectory
  /** Pi, as the memory's builder reads it. */
  readonly harness?: PiHarness
  /** The memory's fold threshold (`MEMORY_FOLD_TOKENS`), the deployment's by default. */
  readonly foldTokens?: number
  readonly skills?: Skills['Service']
  readonly learner?: Learner['Service']
  /** The chat operations, where a memory's view is placed; none of its operations by default. */
  readonly operations?: Layer.Layer<ChatOperations>
}

/**
 * The knowledge services (Memories and Retrieval, layers/knowledge.ts; Skills and Learner, layers/skills.ts) over what
 * `given` holds, with a KeyedLock of their own. Retrieval's Pi and cheap model are never read here.
 */
export const knowledgeOver = (given: Given) => {
  // A layer only holds what it is given until one of its methods runs; a test reaches only the ones it gave.
  const { chats } = given
  const input: Pick<AgentInputs, 'harness' | 'memory'> & { readonly env: Partial<AgentInputs['env']> } = {
    harness: given.harness ?? unread,
    env: given.foldTokens === undefined ? {} : { MEMORY_FOLD_TOKENS: String(given.foldTokens) },
    memory: { memory: unread, recall: unread },
  }
  const services = KnowledgeLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        given.db === undefined ? Layer.succeed(Db, unread) : sqliteDb(given.db),
        chats === undefined
          ? Layer.succeed(Chats, unread)
          : Layer.mock(Chats)({
              primary: chats.primary(),
              conversationAbove: (chat: string) => attemptSync(() => chats.conversationAbove(chat)),
            }),
        // SAFETY: memory and retrieval read only Pi, the fold threshold and the memory extensions from the instance
        // input, and Pi only when a test steps a memory or searches.
        Layer.succeed(AgentInput, input as AgentInputs),
        Layer.succeed(CheapModels, () => unread),
        given.operations ?? Layer.mock(ChatOperations)({}),
        KeyedLock.layer,
      ),
    ),
  )
  return Layer.mergeAll(
    services,
    Layer.succeed(Skills, given.skills ?? unread),
    Layer.succeed(Learner, given.learner ?? unread),
  )
}
