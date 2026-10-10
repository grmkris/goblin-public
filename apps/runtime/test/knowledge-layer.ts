import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import type { ChatDirectory } from '../src/chats/directory.ts'
import { ChatOperations, Chats } from '../src/chats/service.ts'
import { toAppError } from '../src/http/errors.ts'
import { KnowledgeLive } from '../src/layers/knowledge.ts'
import { learnerOver, skillsOver } from '../src/layers/skills.ts'
import { type ChatMemories, MemoriesInstance } from '../src/memory/memory.ts'
import { CheapModels } from '../src/memory/model.ts'
import { KeyedLock } from '../src/observability/lock.ts'
import { TranscriptsInstance } from '../src/retrieval/index.ts'
import { Db } from '../src/runtime/db.ts'
import { Learner, Skills } from '../src/skills/service.ts'
import type { SkillLearner } from '../src/skills/learner.ts'
import type { SkillLibrary } from '../src/skills/library.ts'
import type { chatDatabase } from './chats-sqlite.ts'

/** The database and started instances lane K's layer reads; a test gives the ones its programs reach. */
type Given = {
  /** The memory tables (chats-sqlite.ts). */
  readonly db?: ReturnType<typeof chatDatabase>['db']
  /** Lane C's chats, as the memory's status reads them: Personal, and the Conversation a chat sits under. */
  readonly chats?: ChatDirectory
  readonly memories?: ChatMemories
  readonly skills?: SkillLibrary
  readonly learner?: SkillLearner
  /** Lane C's chat operations, where a memory's view is placed; none of its operations by default. */
  readonly operations?: Layer.Layer<ChatOperations>
}

/**
 * The knowledge services (Memories and Retrieval, layers/knowledge.ts; Skills and Learner, layers/skills.ts) over what
 * `given` holds, with a KeyedLock of their own. Retrieval's index and cheap model are never read here.
 */
export const knowledgeOver = (given: Given) => {
  // SAFETY: a layer only holds what it is given until one of its methods runs; a test reaches only the ones it gave.
  const unread = undefined as never
  const { chats } = given
  const services = KnowledgeLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        // SAFETY: the memory's queries use only Drizzle's query builder, which node:sqlite's driver serves alike.
        Layer.succeed(Db, (given.db ?? unread) as never),
        chats === undefined
          ? Layer.succeed(Chats, unread)
          : Layer.mock(Chats)({
              primary: chats.primary(),
              conversationAbove: (chat: string) =>
                Effect.try({ try: () => chats.conversationAbove(chat), catch: toAppError }),
            }),
        Layer.succeed(MemoriesInstance, given.memories ?? unread),
        Layer.succeed(TranscriptsInstance, unread),
        Layer.succeed(CheapModels, () => unread),
        given.operations ?? Layer.mock(ChatOperations)({}),
        KeyedLock.layer,
      ),
    ),
  )
  return Layer.mergeAll(
    services,
    Layer.succeed(Skills, given.skills === undefined ? unread : skillsOver(given.skills)),
    Layer.succeed(Learner, given.learner === undefined ? unread : learnerOver(given.learner)),
  )
}
