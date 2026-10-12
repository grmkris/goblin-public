import type { Me } from '@goblin/wallet/contract'
import { describe, expect, it } from 'vitest'
import { ME, OAUTH_REQUEST, OWNER } from '../../api/fixtures.ts'
import { clientHome, consentStage } from './consent-model.ts'

const fresh: Me = { userId: ME.userId, owner: OWNER, chains: [] }
const base = { id: 'req_demo_01', request: OAUTH_REQUEST, requestFailure: undefined, me: ME, meFailure: undefined }

describe('consentStage', () => {
  it('sets the wallet up first when it is not, then asks to approve', () => {
    expect(consentStage({ ...base, me: fresh })).toMatchObject({ kind: 'setup', view: OAUTH_REQUEST })
    const halfway: Me = { ...ME, chains: [{ chain: 'base', upgraded: true }] }
    expect(consentStage({ ...base, me: halfway }).kind).toBe('setup')
    expect(consentStage(base)).toMatchObject({ kind: 'approve', view: OAUTH_REQUEST })
  })
  it('sends the owner back to the client when the request ran out, set up or not', () => {
    const expired = { ...OAUTH_REQUEST, expired: true as const }
    expect(consentStage({ ...base, request: expired })).toMatchObject({ kind: 'expired' })
    expect(consentStage({ ...base, request: expired, me: undefined })).toMatchObject({ kind: 'expired' })
    expect(clientHome('goblin.surf')).toBe('https://goblin.surf/')
  })
  it('says why there is nothing to answer', () => {
    const failure = (code: string | undefined) => ({
      ...base,
      request: undefined,
      requestFailure: { code, message: 'm' },
    })
    expect(consentStage(failure('other_owner'))).toEqual({ kind: 'other-owner', message: 'm' })
    expect(consentStage(failure('request_gone'))).toEqual({ kind: 'gone' })
    expect(consentStage(failure(undefined))).toEqual({ kind: 'failed', message: 'm' })
    expect(consentStage({ ...base, id: '' })).toEqual({ kind: 'no-request' })
    expect(consentStage({ ...base, me: undefined, meFailure: { code: 'signed_out', message: 'Sign in.' } })).toEqual({
      kind: 'failed',
      message: 'Sign in.',
    })
  })
  it('waits for both the request and the owner', () => {
    expect(consentStage({ ...base, request: undefined }).kind).toBe('loading')
    expect(consentStage({ ...base, me: undefined }).kind).toBe('loading')
  })
})
