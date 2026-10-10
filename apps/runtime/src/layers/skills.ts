import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import type { McpConnections, McpGrants } from '../mcp/service.ts'
import { CheapModels } from '../memory/model.ts'
import type { SingleFlight } from '../observability/single-flight.ts'
import type { PiSessions } from '../pi/sessions.ts'
import { Db } from '../runtime/db.ts'
import { makeLearner } from '../skills/learner.ts'
import { makeSkills } from '../skills/library.ts'
import { Learner, Skills } from '../skills/service.ts'
import { SqliteDraftLog, SqliteSkillState } from '../skills/store.ts'

/**
 * Start step 10: skills from the owner's MCP libraries over the host's connections, and the learner that proposes new
 * ones, each made once over the skills state in the agent's database.
 */
export const SkillsLive: Layer.Layer<
  Skills | Learner,
  never,
  Db | McpConnections | McpGrants | PiSessions | SingleFlight | CheapModels
> = Layer.effectContext(
  Effect.gen(function* () {
    const db = yield* Db
    const cheap = yield* CheapModels
    const state = new SqliteSkillState(db)
    const skills = yield* makeSkills(state)
    const learner = yield* makeLearner({ drafts: new SqliteDraftLog(db), state, skills, model: cheap('skill') })
    return Context.merge(Skills.context(skills), Learner.context(learner))
  }),
)
