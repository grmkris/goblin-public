import { TopicSetup } from '@goblin/contracts'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'

const decode = Schema.decodeUnknownOption(Schema.fromJsonString(TopicSetup))

/** A Topic with nothing chosen: what a setup that cannot be read becomes, so a bad row never widens anything. */
export const CLOSED_SETUP: TopicSetup = { mcpServers: [], skills: [], apps: [], subagents: false }

/** A Topic's stored setup (ADR 0040), or nothing when the row cannot be read. */
export const topicSetupOf = (stored: string): TopicSetup => Option.getOrElse(decode(stored), () => CLOSED_SETUP)

/** A Topic's setup as stored. */
export const storedSetup = (setup: TopicSetup): string => JSON.stringify(setup)
