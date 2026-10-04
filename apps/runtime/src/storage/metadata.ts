import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/durable-sqlite'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import { appMetadata } from './schema.ts'

export class MetadataStorageError extends Schema.TaggedError<MetadataStorageError>()('MetadataStorageError', {
  operation: Schema.String,
}) {}

export class AppMetadata extends Context.Service<
  AppMetadata,
  {
    readonly get: (id: string) => Effect.Effect<string | undefined, MetadataStorageError>
    readonly set: (id: string, value: string) => Effect.Effect<void, MetadataStorageError>
  }
>()('AppMetadata') {
  static layer(storage: DurableObjectStorage): Layer.Layer<AppMetadata> {
    const db = drizzle(storage)
    return Layer.succeed(AppMetadata, {
      get: (id) =>
        Effect.try({
          try: () =>
            db.select({ value: appMetadata.value }).from(appMetadata).where(eq(appMetadata.id, id)).get()?.value,
          catch: () => new MetadataStorageError({ operation: 'get' }),
        }),
      set: (id, value) =>
        Effect.try({
          try: () => {
            db.insert(appMetadata)
              .values({ id, value })
              .onConflictDoUpdate({ target: appMetadata.id, set: { value } })
              .run()
          },
          catch: () => new MetadataStorageError({ operation: 'set' }),
        }),
    })
  }
}
