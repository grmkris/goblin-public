import * as Clock from 'effect/Clock'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import { type AppError, toAppError } from './http/errors.ts'
import type { ChatDirectory } from './chats/directory.ts'
import type { ConversationRegistry } from './conversations.ts'
import type { WorkspaceFeed } from './workspace/feed.ts'
import type { AppRegistry } from './apps/registry.ts'
import type { FileStore } from './files/store.ts'
import type { AgentApps } from './agent-apps/engine.ts'
import type { HomeService } from './home/service.ts'
import type { TopicRegistry } from './topics/registry.ts'
import type { PersonaRegistry } from './personas/registry.ts'
import type { PersonaInvocations } from './personas/invocations.ts'
import type { OrganizeReceipts } from './organize/receipts.ts'
import type { ChatMover } from './chats/mover.ts'

/** The Agent DO's application services, provided once per object through a ManagedRuntime (agent.ts). */
export class Chats extends Context.Service<Chats, ChatDirectory>()('goblin/Chats') {}
export class Conversations extends Context.Service<Conversations, ConversationRegistry>()('goblin/Conversations') {}
/** The owner's Topics (ADR 0032): each with one Conversation; Personal holds Main. */
export class Topics extends Context.Service<Topics, TopicRegistry>()('goblin/Topics') {}
/** The owner's Personas (ADR 0033), which Persona answered which message, and what organizing changed. */
export class Personas extends Context.Service<Personas, PersonaRegistry>()('goblin/Personas') {}
export class Invocations extends Context.Service<Invocations, PersonaInvocations>()('goblin/Invocations') {}
export class Receipts extends Context.Service<Receipts, OrganizeReceipts>()('goblin/Receipts') {}
/** Move to thread (ADR 0034): a chat's newest finished turn into a Thread. */
export class Moves extends Context.Service<Moves, ChatMover>()('goblin/Moves') {}
/** The owner's conversations and what each is doing, as one live feed. */
export class Workspace extends Context.Service<Workspace, WorkspaceFeed>()('goblin/Workspace') {}
/** The owner's Apps (ADRs 0020, 0021): MCP Apps kept per call and agent apps with a view. */
export class Apps extends Context.Service<Apps, AppRegistry>()('goblin/Apps') {}
export class Files extends Context.Service<Files, FileStore>()('goblin/Files') {}
/** The agent's apps (ADR 0021): their builds, calls and views. */
export class AppEngine extends Context.Service<AppEngine, AgentApps>()('goblin/AppEngine') {}
export class Home extends Context.Service<Home, HomeService>()('goblin/Home') {}
export type { AgentServices } from './layers/index.ts'

/** Wrap a plain async step so its failure lands in the typed `AppError` channel. */
export const attempt = <A>(run: () => Promise<A>): Effect.Effect<A, AppError> =>
  Effect.tryPromise({ try: run, catch: toAppError })

export const nowSecondsEffect: Effect.Effect<number> = Effect.map(Clock.currentTimeMillis, (millis) =>
  Math.floor(millis / 1000),
)
