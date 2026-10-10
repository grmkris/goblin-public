import * as HttpApiEndpoint from 'effect/http-api/HttpApiEndpoint'
import * as HttpApiGroup from 'effect/http-api/HttpApiGroup'
import { SetupCatalog } from '../setup.ts'

/**
 * What a Topic's or a Persona's setup can be chosen from (ADR 0040). Paths are relative to the API's `/api` prefix.
 *
 * - `catalog`: `GET /api/setup/catalog`: the owner's MCP servers with their granted tools, the skill servers they turned
 *   on with the skills each lists now, and the agent's apps.
 */
export class SetupGroup extends HttpApiGroup.make('setup').add(
  HttpApiEndpoint.get('catalog', '/setup/catalog', { success: SetupCatalog }),
) {}
