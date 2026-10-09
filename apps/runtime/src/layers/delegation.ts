import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { ProfilesInstance } from '../capabilities/profiles.ts'
import { Home, HomeService } from '../home/service.ts'
import { modelOptions } from '../models.ts'
import type { KeyedLock } from '../observability/lock.ts'
import { OrganizeReceipts } from '../organize/receipts.ts'
import { Receipts } from '../organize/service.ts'
import type { PersonaInvocations } from '../personas/invocations.ts'
import { PersonaRegistry } from '../personas/registry.ts'
import { Invocations, Personas } from '../personas/service.ts'
import { AgentInput } from '../runtime/input.ts'
import type { Changes } from '../runtime/changes.ts'
import type { FoundationServices } from './core.ts'
import { Db } from '../runtime/db.ts'
import * as Legacy from '../services.ts'
import { topicPorts } from '../topics/ports.ts'
import { TopicRegistry } from '../topics/registry.ts'
import { Topics } from '../topics/service.ts'
import { WorkspaceFeed } from '../workspace/feed.ts'
import { Workspace } from '../workspace/service.ts'

/** Lane D's stores, one each per agent: the SQLite stores and the workspace feed over them. */
export type DelegationStores = {
  readonly topics: TopicRegistry
  readonly personas: PersonaRegistry
  readonly invocations: PersonaInvocations
  readonly receipts: OrganizeReceipts
  readonly home: HomeService
  readonly feed: WorkspaceFeed
}

/**
 * Lane D's services over `stores`: Topics (creates serialized by the per-key lock), Personas, receipts and Home tell
 * the change bus what each write changed, and the workspace feed follows it.
 */
export const delegationServices = (
  stores: DelegationStores,
): Layer.Layer<Topics | Personas | Invocations | Receipts | Home | Workspace, never, KeyedLock | Changes> =>
  Layer.effectContext(
    Effect.gen(function* () {
      const topics = yield* Topics.make(stores.topics)
      const personas = yield* Personas.make(stores.personas)
      const receipts = yield* Receipts.make(stores.receipts)
      const home = yield* Home.make(stores.home)
      const workspace = yield* Workspace.make(stores.feed)
      return Context.mergeAll(
        Topics.context(topics),
        Personas.context(personas),
        Invocations.context(Invocations.make(stores.invocations)),
        Receipts.context(receipts),
        Home.context(home),
        Workspace.context(workspace),
      )
    }),
  )

/**
 * The agent's own lane D stores. Topics, Personas, receipts, Home and the feed are made here, once; the legacy start's
 * copies of them are no longer read. The invocations stay the legacy start's one instance, which the Persona asks and
 * Stop still write through. A Topic's Conversation is made, listed and given memory by the conversation, capability and
 * memory instances of the legacy start, the agent's only ones, synchronously inside the Topic's own transaction.
 */
const stores: Effect.Effect<DelegationStores, never, FoundationServices> = Effect.gen(function* () {
  const input = yield* AgentInput
  const db = yield* Db
  const conversations = yield* Legacy.Conversations
  const chats = yield* Legacy.Chats
  const kit = { capabilities: yield* ProfilesInstance, chats, memories: yield* Legacy.Memories }
  const apps = yield* Legacy.Apps
  const invocations = yield* Legacy.Invocations
  const topics = new TopicRegistry(db, topicPorts(db, conversations, kit))
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
  const home = new HomeService(db, apps, input.agentApps)
  const feed = new WorkspaceFeed(
    input.harness,
    { conversations, apps, home, topics, personas, invocations, receipts },
    chats,
  )
  feed.listen()
  return { topics, personas, invocations, receipts, home, feed } satisfies DelegationStores
})

/** Lane D's services: delegation, Topics, Personas, organizing, Home and the workspace feed. */
export const DelegationLive: Layer.Layer<
  Topics | Personas | Invocations | Receipts | Home | Workspace,
  never,
  FoundationServices
> = Layer.unwrap(Effect.map(stores, delegationServices))
