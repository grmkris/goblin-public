import type { ReactNode } from 'react'
import { QueryClientProvider } from '@tanstack/react-query'
import type { WorkspaceSnapshot } from '@goblin/contracts'
import { WorkspaceFeedProvider } from '../../src/components/workspace-feed.tsx'
import { makeQueryClient } from '../../src/lib/query/api-query.ts'

/**
 * A fixture page's app around `node`, as the router gives the real one: its own QueryClient, and the workspace without
 * a feed, holding `workspace` when given (the slice hooks answer from it) and empty otherwise.
 */
export function withQueryClient(node: ReactNode, workspace?: WorkspaceSnapshot): ReactNode {
  return (
    <QueryClientProvider client={makeQueryClient()}>
      <WorkspaceFeedProvider enabled={false} {...(workspace !== undefined && { snapshot: workspace })}>
        {node}
      </WorkspaceFeedProvider>
    </QueryClientProvider>
  )
}
