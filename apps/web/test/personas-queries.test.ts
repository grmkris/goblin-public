import type { PersonaDetail, PersonaView } from '@goblin/contracts'
import {
  Conflict,
  NotFound,
  OwnerApi,
  OwnerAdmission,
  PersonasGroup,
  Unauthenticated,
  ownerApiOf,
} from '@goblin/contracts/api'
import { MutationObserver, QueryObserver } from '@tanstack/react-query'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { owner } from '../src/lib/api.ts'
import { primeOwnerRead } from '../src/lib/prime.ts'
import { fakeHttpApi, testQueryClient } from '../src/lib/query/testing.ts'
import { personaDetailQuery, personaKeys, updatePersonaMutation } from '../src/personas/queries.ts'

const SAGE: PersonaView = {
  id: 1,
  name: 'Sage',
  avatar: { glyph: 'S', hue: 140 },
  role: 'Reviewer',
  instructions: 'Review carefully.',
  exclusions: [],
  revision: 1,
  createdAt: 1,
  updatedAt: 1,
}

/** The real Personas group served in memory, over one Persona; `signedIn` false refuses every call at the gate. */
const fakeOwner = () => {
  const state = { persona: SAGE, signedIn: true }
  const detail = (): PersonaDetail => ({
    persona: state.persona,
    revisions: [{ ...state.persona, actor: 'owner', createdAt: state.persona.updatedAt }],
  })
  const Personas = HttpApiBuilder.group(OwnerApi, 'personas', (handlers) =>
    handlers
      .handle('create', () => Effect.die('not used'))
      .handle('detail', ({ params }) =>
        params.id === state.persona.id ? Effect.succeed(detail()) : Effect.fail(new NotFound({ what: 'persona' })),
      )
      .handle('update', ({ payload }) => {
        if (payload.expectedRevision !== state.persona.revision)
          return Effect.fail(new Conflict({ reason: 'revision' }))
        const revision = state.persona.revision + 1
        const role = payload.role ?? state.persona.role
        state.persona = { ...state.persona, role, revision, updatedAt: revision }
        return Effect.succeed(state.persona)
      }),
  )
  const admit = Effect.suspend(() =>
    state.signedIn ? Effect.void : Effect.fail(new Unauthenticated({ reason: 'no_session' })),
  )
  const gate = Layer.succeed(
    OwnerAdmission,
    OwnerAdmission.of((handler) => Effect.andThen(admit, handler)),
  )
  const server = fakeHttpApi(ownerApiOf(PersonasGroup), Personas.pipe(Layer.provide(gate)))
  return {
    ...server,
    state,
    reset: () => {
      state.persona = SAGE
      state.signedIn = true
    },
  }
}

const fake = fakeOwner()
beforeAll(() => {
  vi.stubGlobal('location', new URL('http://app.test/'))
  vi.stubGlobal('fetch', fake.fetch)
})
beforeEach(() => fake.reset())
afterAll(async () => {
  vi.unstubAllGlobals()
  await owner.runtime.dispose()
  await fake.dispose()
})

describe('Persona queries', () => {
  it('read a Persona through the contract, under its own key', async () => {
    const client = testQueryClient()
    const detail = await client.query(personaDetailQuery(1))
    expect(detail.persona).toEqual(SAGE)
    expect(client.getQueryData(personaKeys.detail(1))).toEqual(detail)
  })

  it('read the profile again once a save lands, and refuse a save from an older revision as a conflict', async () => {
    const client = testQueryClient()
    const watching = new QueryObserver(client, personaDetailQuery(1))
    const unsubscribe = watching.subscribe(() => undefined)
    try {
      await vi.waitFor(() => expect(watching.getCurrentResult().data?.persona.revision).toBe(1))
      const save = new MutationObserver(client, updatePersonaMutation(client, 1))
      await save.mutate({ role: 'Editor', expectedRevision: 1 })
      expect(watching.getCurrentResult().data?.persona).toMatchObject({ role: 'Editor', revision: 2 })
      await expect(save.mutate({ role: 'Critic', expectedRevision: 1 })).rejects.toBeInstanceOf(Conflict)
      expect(fake.state.persona.role).toBe('Editor')
    } finally {
      unsubscribe()
    }
  })
})

describe('priming a route', () => {
  it('fills the cache for the page', async () => {
    vi.stubGlobal('window', globalThis)
    const client = testQueryClient()
    await primeOwnerRead(client, personaDetailQuery(1))
    expect(client.getQueryData(personaKeys.detail(1))).toMatchObject({ persona: SAGE })
  })

  it('leaves a refused read neither in the cache nor as a sign-in, for the gated page to decide', async () => {
    vi.stubGlobal('window', globalThis)
    fake.state.signedIn = false
    const client = testQueryClient()
    await primeOwnerRead(client, personaDetailQuery(1))
    expect(client.getQueryState(personaKeys.detail(1))).toBeUndefined()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(client.signIns.count).toBe(0)
  })
})
