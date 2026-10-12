import * as HttpApiEndpoint from 'effect/http-api/HttpApiEndpoint'
import * as HttpApiGroup from 'effect/http-api/HttpApiGroup'
import { SidebarEdit, SidebarEditResult, SidebarPins } from '../sidebar.ts'
import { ApiErrors } from './errors.ts'

/**
 * The owner's pinned servers and App views (ADR 0053), synced to every device and carried on the workspace feed.
 * Paths are relative to the API's `/api` prefix.
 *
 * - `read`: `GET /api/sidebar`, the pins as they are now.
 * - `edit`: `POST /api/sidebar`, one pin, unpin or move against the revision the browser read; `stale` with the pins
 *   as they are when another device changed them first.
 */
export class SidebarGroup extends HttpApiGroup.make('sidebar').add(
  HttpApiEndpoint.get('read', '/sidebar', { success: SidebarPins }),
  HttpApiEndpoint.post('edit', '/sidebar', {
    payload: SidebarEdit,
    success: SidebarEditResult,
    error: [ApiErrors.invalidInput],
  }),
) {}
