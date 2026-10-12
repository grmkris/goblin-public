import { describe, expect, it } from 'vitest'
import { FRESH_STATUS, NO_AGENT_STATUS, STATUS } from '../api/fixtures.ts'
import { setupOf } from './decode.ts'
import { UPGRADE_FEE_CEILINGS } from '@goblin/wallet/userop'
import { clientNameOf, notReadyTitle, setupChecklist, setupGapsOf, UPGRADE_FEE_BOUND_BASE } from './setup-model.ts'

/** A tool result carrying `structuredContent`. */
const result = (structuredContent: Record<string, unknown>) => ({ content: [], structuredContent })

const SERVER_GAPS = [
  'create the agent wallet',
  "add USDC to the account on Base (the upgrade's gas is paid in USDC)",
  'upgrade the account on Base',
  'sign the spending allowance',
]

describe('what setup still needs', () => {
  it("takes the tool's own list, empty when finished", () => {
    expect(setupGapsOf(NO_AGENT_STATUS, [])).toEqual([])
    expect(setupGapsOf(STATUS, ['sign the spending allowance'])).toEqual(['sign the spending allowance'])
  })
  it('counts funds against the same gas ceiling as the upgrade', () => {
    expect(UPGRADE_FEE_BOUND_BASE).toBe(UPGRADE_FEE_CEILINGS.base)
  })
  it('reads it from the status when the result does not say', () => {
    expect(setupGapsOf(STATUS, undefined)).toEqual([])
    expect(setupChecklist(setupGapsOf(NO_AGENT_STATUS, undefined))).toEqual([
      'Create your agent wallet',
      'Add USDC on Base',
      'Turn on spending',
    ])
    expect(setupChecklist(setupGapsOf(FRESH_STATUS, undefined))).toEqual(['Add USDC on Base', 'Turn on spending'])
  })
  it("says the server's gaps as the owner's checklist, each step once", () => {
    expect(setupChecklist(SERVER_GAPS)).toEqual(['Create your agent wallet', 'Add USDC on Base', 'Turn on spending'])
    expect(setupChecklist(['something new'])).toEqual(['Something new'])
  })
  it('decodes `setup` beside the status, and says nothing when it is absent or malformed', () => {
    expect(setupOf(result({ ...STATUS, setup: SERVER_GAPS }))).toEqual(SERVER_GAPS)
    expect(setupOf(result({ ...STATUS, setup: [] }))).toEqual([])
    expect(setupOf(result({ ...STATUS }))).toBeUndefined()
    expect(setupOf(result({ ...STATUS, setup: 'no' }))).toBeUndefined()
    expect(setupOf(undefined)).toBeUndefined()
  })
})

describe('whose agent it is', () => {
  it('names the host by a plain short name, and "your agent" otherwise', () => {
    expect(notReadyTitle(clientNameOf('goblin'))).toBe("Your wallet isn't ready for goblin yet")
    expect(notReadyTitle(clientNameOf(undefined))).toBe("Your wallet isn't ready for your agent yet")
    expect(clientNameOf('<script>')).toBeUndefined()
    expect(clientNameOf('x'.repeat(41))).toBeUndefined()
  })
})
