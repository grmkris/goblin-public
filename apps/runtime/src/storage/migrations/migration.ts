/** Separates a migration's statements; drizzle's migrator splits on it too. */
export const BREAK = '\n--> statement-breakpoint\n'

/**
 * One inline migration keyed `<14-digit timestamp>_<name>`. Until launch goblin is greenfield (ADR 0041): a migration
 * is edited in place as if the schema had always been so, and dev is reset. Pi/Agents tables are never touched.
 */
export type Migration = { readonly key: string; readonly tables: readonly string[]; readonly sql: string }
