// The generated dist/toolchain.js (scripts/build.ts): ESM sources for Dynamic Workers and the agent's docs.

/** A hash over the SDK, release entry, transpiler and style compiler: part of every release id. */
export declare const TOOLCHAIN_HASH: string
/** The server SDK, served to an app as the module `@goblin/app`. */
export declare const SDK: string
/** The release entry (`release.js`): imports `./app.js` and exports the `App` entrypoint. */
export declare const RELEASE: string
/** The transpiler (`transpile.js`): exports the `Transpile` entrypoint. */
export declare const TRANSPILER: string
/** The style compiler (`style.js`): exports the `Style` entrypoint and imports `./sheets.js`. */
export declare const STYLE: string
/** The style compiler's `sheets.js`: goblin's theme and what it imports. */
export declare const STYLE_SHEETS: string
/** The agent's docs by topic: `core`, `ui`, `files`, `examples`. */
export declare const DOCS: Readonly<Record<string, string>>
