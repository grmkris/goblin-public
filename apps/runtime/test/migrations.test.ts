import { describe, expect, it } from 'vitest'
import { migrationKeys } from '../src/storage/migrations.ts'

/**
 * Every key a deployed agent may have applied, in order. Drizzle records applied migrations by key, so a key that
 * changed or moved would run again or never. Until launch goblin is greenfield (ADR 0041): a migration may be edited in
 * place or removed, and the release that does it resets dev first; keep this list equal to the migrations.
 */
const APPLIED = [
  '20261004000000_initial',
  '20261005000000_resident_mcp_host',
  '20261006000000_model_budget',
  '20261007000000_model_choice',
  '20261008000000_mcp_endpoints',
  '20261009000000_mcp_added_servers',
  '20261010000000_mcp_registries',
  '20261011000000_conversations',
  '20261012000000_memory',
  '20261013000000_skills',
  '20261014000000_skill_drafts',
  '20261015000000_channel',
  '20261016000000_thread_notes',
  '20261016000100_conversation_capabilities',
  '20261016000200_mcp_events',
  '20261016000210_routines',
  '20261016000211_routine_usage_projection',
  '20261016000212_routine_event_spacing',
  '20261017000000_conversation_tree',
  '20261017000001_members_phase_b',
  '20261017000100_conversation_read_mark',
  '20261017000234_members_readers',
  '20261017000300_apps',
  '20261018000000_agent_apps',
  '20261018000100_app_registry',
  '20261018000200_agent_app_views',
  '20261018000300_agent_app_powers',
  '20261018000400_agent_app_jobs',
  '20261019000000_run_events',
  '20261020000000_operator_reads',
  '20261021000000_home',
  '20261022000100_usage_credits',
  '20261023000000_mcp_ask_first',
  '20261024000000_helper_app_exclusions',
  '20261025000000_logical_chats',
  '20261026000000_topics',
  '20261026000100_chat_memory',
  '20261026000150_organize_receipts',
  '20261026000200_personas',
  '20261026000300_transcript_index',
  '20261026000350_thread_heads',
  '20261026000400_chat_moves',
  '20261026000500_routine_topics',
  '20261026000600_decisions',
]

describe('application migrations (unit)', () => {
  it('keeps every applied key, in order, ahead of any new one', () => {
    expect(migrationKeys().slice(0, APPLIED.length)).toEqual(APPLIED)
  })

  it('applies in key order with no key twice', () => {
    const keys = migrationKeys()
    expect(keys).toEqual(keys.toSorted())
    expect(new Set(keys).size).toBe(keys.length)
  })
})
