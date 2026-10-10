import type { TopicSetupEdit } from '@goblin/contracts'
import { owner } from '../lib/api.ts'

/** What a setup is chosen from and a Topic's setup on the owner API (ADR 0040). Keys are `['setup', kind]`. */
const setupKeys = { catalog: ['setup', 'catalog'] as const }

/**
 * The servers with their granted tools, the skill servers turned on with their skills, and the agent's apps. It changes
 * whenever a grant, a skill server or an app does, so a picker reads it again each time it opens.
 */
export const setupCatalogQuery = owner.apiQuery({
  queryKey: setupKeys.catalog,
  queryFn: (api) => api.setup.catalog(),
})

/** A Topic's setup changed: the Topic as it is now, and the routines it leaves without some of their tools. */
export const setTopicSetupMutation = owner.apiMutation({
  mutationFn: (api, { id, edit }: { readonly id: number; readonly edit: TopicSetupEdit }) =>
    // The client takes each variant of the edit on its own.
    'set' in edit
      ? api.topics.setSetup({ params: { id }, payload: edit })
      : 'add' in edit
        ? api.topics.setSetup({ params: { id }, payload: edit })
        : api.topics.setSetup({ params: { id }, payload: edit }),
})
