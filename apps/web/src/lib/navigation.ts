import { createContext, use } from 'react'
import type { ComposerDraft } from './composer.ts'

/**
 * Where the shell shows things, as Apps and composers ask for them. The shell implements it; an App's stage, its place
 * in a transcript or a composer never reach into the shell's layout themselves.
 */
export type Navigation = {
  /** Whether App `app` shows as a page of its own now. */
  readonly isAppPage: (app: string) => boolean
  /** Shows App `app` as a page. `near` names where it was opened from, when the shell can use that. */
  readonly openApp: (app: string, near?: string) => void
  /** Leaves App `app`'s page: the conversation it belongs to shows instead. Nothing happens to the App itself. */
  readonly closeAppPage: (app: string) => void
  /** Brings App `app`'s page into view. */
  readonly focusApp: (app: string) => void
  /** Starts writing a new thread from conversation `from` with this draft: its text, references and files. */
  readonly newThreadWith: (draft: ComposerDraft, from: string) => void
}

export const NavigationContext = createContext<Navigation | undefined>(undefined)

/** The shell's navigation, for components under it. */
export function useNavigation(): Navigation {
  const navigation = use(NavigationContext)
  if (navigation === undefined) throw new Error('useNavigation outside the shell')
  return navigation
}
