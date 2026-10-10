import { OwnerApi } from '@goblin/contracts/api'
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder'
import { setupCatalog } from './catalog.ts'

/** The `setup` group (ADR 0040): what a Topic's or a Persona's setup can be chosen from. */
export const SetupHandlers = HttpApiBuilder.group(OwnerApi, 'setup', (handlers) =>
  handlers.handle('catalog', () => setupCatalog),
)
