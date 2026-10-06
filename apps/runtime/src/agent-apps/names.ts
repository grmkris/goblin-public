/** An app's name: kebab-case, unique per agent, never changed (ADR 0021). */
export const APP_NAME = /^[a-z][a-z0-9-]{1,23}$/u
/** An action's or view's name: camelCase. */
export const MEMBER_NAME = /^[a-z][a-zA-Z0-9]{0,31}$/u

/** The app's name as an identifier: storage namespaces take no `-`. */
export const slugOf = (app: string): string => app.replaceAll('-', '_')
