import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { Conversations } from '../chats/service.ts'
import { Home, HomeService } from '../home/service.ts'
import { Memories } from '../memory/service.ts'
import { modelOptions } from '../models.ts'
import type { KeyedLock } from '../observability/lock.ts'
import { OrganizeReceipts } from '../organize/receipts.ts'
import { Receipts } from '../organize/service.ts'
import { PersonaInvocations } from '../personas/invocations.ts'
import { PersonaRegistry } from '../personas/registry.ts'
import { Invocations, Personas } from '../personas/service.ts'
import { restoreHelperExecution } from '../pi/helper-execution.ts'
import type { Changes } from '../runtime/changes.ts'
import { Db } from '../runtime/db.ts'
import { AgentInput } from '../runtime/input.ts'
import { topicPorts } from '../topics/ports.ts'
import { TopicRegistry } from '../topics/registry.ts'
import { Topics } from '../topics/service.ts'

/** The delegation stores, one each per agent: Topics, Personas, the invocations, receipts and Home, on SQLite. */
export type DelegationStores = {
  readonly topics: TopicRegistry
  readonly personas: PersonaRegistry
  readonly invocations: PersonaInvocations
  readonly receipts: OrganizeReceipts
  readonly home: HomeService
}

/**
 * The delegation services over `stores`: Topics (creates serialized by the per-key lock), Personas, the invocations,
 * receipts and Home, each telling the change bus what its writes changed.
 */
export const delegationServices = (
  stores: DelegationStores,
): Layer.Layer<Topics | Personas | Invocations | Receipts | Home, never, KeyedLock | Changes> =>
  Layer.effectContext(
    Effect.gen(function* () {
      const topics = yield* Topics.make(stores.topics)
      const personas = yield* Personas.make(stores.personas)
      const receipts = yield* Receipts.make(stores.receipts)
      const invocations = yield* Invocations.make(stores.invocations)
      const home = yield* Home.make(stores.home)
      return Context.mergeAll(
        Topics.context(topics),
        Personas.context(personas),
        Invocations.context(invocations),
        Receipts.context(receipts),
        Home.context(home),
      )
    }),
  )

/**
 * The agent's own delegation stores, each made here once: Topics, Personas, the invocations, receipts and Home. A
 * Topic's Conversation is made, written and told about through the conversation services, listed with Personal's
 * switches inside the Topic's own transaction, and its memory turned on through Memories.
 */
const stores: Effect.Effect<DelegationStores, never, AgentInput | Db | Conversations | Memories> = Effect.gen(
  function* () {
    const input = yield* AgentInput
    const db = yield* Db
    const topics = new TopicRegistry(
      db,
      topicPorts(db, { conversations: yield* Conversations, memories: yield* Memories }),
    )
    const personas = new PersonaRegistry(
      db,
      modelOptions(input.env.MODELS, input.env.MODEL_ID).map((option) => option.id),
    )
    const receipts = new OrganizeReceipts(db, (kind, target) => {
      try {
        return (kind.startsWith('topic.') ? topics : personas).get(Number(target)).revision
      } catch {
        // expected: a receipt whose target is gone is not undoable.
        return undefined
      }
    })
    const home = new HomeService(db, input.agentApps)
    return { topics, personas, invocations: new PersonaInvocations(db), receipts, home } satisfies DelegationStores
  },
)

/** Delegation, Topics, Personas, organizing and Home. */
export const DelegationLive: Layer.Layer<
  Topics | Personas | Invocations | Receipts | Home,
  never,
  AgentInput | Db | KeyedLock | Changes | Conversations | Memories
> = Layer.unwrap(Effect.map(stores, delegationServices))

/** Start step 7: each helper conversation runs with the execution extensions the agent has now. */
export const HelperExecutionLive: Layer.Layer<never, never, AgentInput | Db> = Layer.effectDiscard(
  Effect.gen(function* () {
    const { harness, helperExtensions } = yield* AgentInput
    const db = yield* Db
    yield* Effect.promise(() => restoreHelperExecution(db, harness, helperExtensions))
  }),
)
