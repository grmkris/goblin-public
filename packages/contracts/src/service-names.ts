// The names of an app's tools and Events, as the server goblin reaches it through spells them (ADR 0052). An app's own
// server names them bare (mygram's `inbox_read` and `message.received`); mysi, which serves every my* app behind one
// connection, prefixes each with the app's service id: `<service>_<tool>` and `<service>.<event>` (`mygram_inbox_read`,
// `mygram.message.received`). Every check of such a name, in the runtime and the web, goes through here.

/** The names `tool` of `service` goes by: the app's own, then mysi's. */
export const toolSpellings = (service: string, tool: string): readonly [string, string] => [tool, `${service}_${tool}`]

/** The Telegram channel's server (ADR 0009): mygram, directly or through mysi. */
const TELEGRAM_SERVICE = 'mygram'

/** What the channel calls on it: read the inbox from a cursor, and send a message. */
const TELEGRAM_TOOLS = { inbox: 'inbox_read', send: 'message_send' } as const
export type TelegramTool = keyof typeof TELEGRAM_TOOLS

/** The Events that wake the channel, by the app's own names; a consumer is keyed by these whatever the spelling. */
export const TELEGRAM_EVENTS = ['message.received', 'question.answered'] as const
type TelegramEvent = (typeof TELEGRAM_EVENTS)[number]

/** The channel's tools on one server: both under one spelling, mygram's own or mysi's. */
export type TelegramTools = Readonly<Record<TelegramTool, string>>

/** The channel's tools as a server offering `offered` names them; none unless it offers both under one spelling. */
export function telegramTools(offered: Iterable<string>): TelegramTools | undefined {
  const names = new Set(offered)
  for (const prefix of ['', `${TELEGRAM_SERVICE}_`]) {
    const tools = { inbox: `${prefix}${TELEGRAM_TOOLS.inbox}`, send: `${prefix}${TELEGRAM_TOOLS.send}` }
    if (names.has(tools.inbox) && names.has(tools.send)) return tools
  }
  return undefined
}

/** Whether `name` is the channel's send tool under either spelling. */
export const isTelegramSend = (name: string): boolean =>
  toolSpellings(TELEGRAM_SERVICE, TELEGRAM_TOOLS.send).includes(name)

/** `event` as a server offering the Events `offered` names it: mygram's own name first; none under neither. */
export const telegramEvent = (offered: ReadonlySet<string>, event: TelegramEvent): string | undefined =>
  [event, `${TELEGRAM_SERVICE}.${event}`].find((name) => offered.has(name))
