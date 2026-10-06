import { describe, expect, it } from 'vitest'
import { INSPECT_SCOPE, consentBody, requestedScopes } from '../src/lib/consent-scope.ts'

describe('the consent page’s grant', () => {
  const asked = requestedScopes(`openid offline_access ${INSPECT_SCOPE}`)

  it('leaves inspection out unless the owner turned it on', () => {
    expect(consentBody(asked, true, false)).toEqual({ accept: true, scope: 'openid offline_access' })
    expect(consentBody(asked, true, true)).toEqual({ accept: true })
  })

  it('grants a request without inspection as asked, and a denial is a denial', () => {
    expect(consentBody(requestedScopes('openid offline_access'), true, false)).toEqual({ accept: true })
    expect(consentBody(asked, false, false)).toEqual({ accept: false })
    expect(requestedScopes(null)).toEqual([])
  })
})
