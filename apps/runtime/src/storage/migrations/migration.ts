/** Separates a migration's statements; drizzle's migrator splits on it too. */
export const BREAK = '\n--> statement-breakpoint\n'

/** One additive, inline migration keyed `<14-digit timestamp>_<name>`. Pi/Agents tables are never touched. */
export type Migration = { readonly key: string; readonly tables: readonly string[]; readonly sql: string }
