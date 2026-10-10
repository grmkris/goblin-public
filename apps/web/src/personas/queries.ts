import type { CreatePersona, UpdatePersona } from '@goblin/contracts'
import { mutationOptions } from '@tanstack/react-query'
import { owner } from '../lib/api.ts'
import { withOperation } from '../lib/query/api-query.ts'

/** Every Persona read: keys are `['personas', kind, input]`, so `['personas']` reaches them all. */
export const personaKeys = {
  all: ['personas'] as const,
  detail: (id: number) => ['personas', 'detail', id] as const,
}

/** A Persona with its revisions, newest first (`GET /api/personas/:id`). */
export const personaDetailQuery = (id: number) =>
  owner.apiQuery({ queryKey: personaKeys.detail(id), queryFn: (api) => api.personas.detail({ params: { id } }) })

/** A new Persona; the same `operationId` finds the same one. Its profile reads it fresh. */
export const createPersonaMutation = mutationOptions({
  ...owner.apiMutation({
    mutationFn: (api, persona: CreatePersona) =>
      api.personas.create({ payload: persona }).pipe(withOperation(persona.operationId)),
  }),
  onSuccess: (created, _persona, _result, { client }) =>
    client.invalidateQueries({ queryKey: personaKeys.detail(created.id) }),
})

/** A new revision of Persona `id` (`expectedRevision` must be the current one); its profile reads it again. */
export const updatePersonaMutation = (id: number) =>
  mutationOptions({
    ...owner.apiMutation({
      mutationFn: (api, change: UpdatePersona) => api.personas.update({ params: { id }, payload: change }),
    }),
    onSuccess: (_persona, _change, _result, { client }) =>
      client.invalidateQueries({ queryKey: personaKeys.detail(id) }),
  })
