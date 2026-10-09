import { type DrizzleSqliteDODatabase, drizzle } from 'drizzle-orm/durable-sqlite'
import * as Context from 'effect/Context'
import * as Layer from 'effect/Layer'
import { AgentInput } from './input.ts'

/**
 * The application tables' Drizzle database over the object's SQLite, built the way every store builds it
 * (`drizzle(storage)`). Drizzle holds no state of its own here, so sharing it changes nothing.
 */
export class Db extends Context.Service<Db, DrizzleSqliteDODatabase>()('goblin/runtime/Db') {
  static readonly layer = Layer.effect(
    Db,
    AgentInput.useSync((input) => drizzle(input.storage)),
  )
}
