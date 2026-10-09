import * as Layer from 'effect/Layer'
import { ChatOperations } from '../src/chats/service.ts'
import type { ChatDirectory } from '../src/chats/directory.ts'
import { KnowledgeLive } from '../src/layers/knowledge.ts'
import type { ChatMemories } from '../src/memory/memory.ts'
import { KeyedLock } from '../src/observability/lock.ts'
import type { ChatRetrieval } from '../src/retrieval/service.ts'
import { Chats, Learner, Memories, Retrieval, Skills } from '../src/services.ts'
import type { SkillLearner } from '../src/skills/learner.ts'
import type { SkillLibrary } from '../src/skills/library.ts'

/** The legacy instances lane K's layer adapts; a test gives the ones its programs reach. */
type Given = {
  readonly memories?: ChatMemories
  readonly chats?: ChatDirectory
  readonly retrieval?: ChatRetrieval
  readonly skills?: SkillLibrary
  readonly learner?: SkillLearner
  /** Lane C's chat operations, where a memory's view is placed; none of its operations by default. */
  readonly operations?: Layer.Layer<ChatOperations>
}

/**
 * Lane K's services (layers/knowledge.ts: Memories, Retrieval, Skills, Learner) over the instances `given`, with a
 * KeyedLock of their own.
 */
export const knowledgeOver = (given: Given) => {
  // SAFETY: an adapter only holds its instance until one of its methods runs; a test reaches only the ones it gave.
  const unread = undefined as never
  return KnowledgeLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(Memories, given.memories ?? unread),
        Layer.succeed(Chats, given.chats ?? unread),
        Layer.succeed(Retrieval, given.retrieval ?? unread),
        Layer.succeed(Skills, given.skills ?? unread),
        Layer.succeed(Learner, given.learner ?? unread),
        given.operations ?? Layer.mock(ChatOperations)({}),
        KeyedLock.layer,
      ),
    ),
  )
}
