/** An app's name: kebab-case, unique per agent, never changed (ADR 0021). */
export const APP_NAME = /^[a-z][a-z0-9-]{1,23}$/u
/** An action's or view's name: camelCase. */
export const MEMBER_NAME = /^[a-z][a-zA-Z0-9]{0,31}$/u

/** The app's name as an identifier: tool names and storage namespaces take no `-`. */
export const slugOf = (app: string): string => app.replaceAll('-', '_')
/** The Pi tool of one action or view. Host tool names never contain `__`, so these cannot shadow one. */
export const toolName = (app: string, member: string): string => `app_${slugOf(app)}__${member}`
/** The Pi extension that carries an app's tools. */
export const extensionName = (app: string): string => `goblin.app.${app}`
