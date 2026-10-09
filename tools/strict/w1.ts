/** Lane W1's files that pass the strict rules (tools/strict/index.ts). Only lane W1 appends globs here. */
export const paths: string[] = [
  'apps/web/src/lib/{composer,conversation-stream,ephemeral,fences,interactions,keyboard,keys,labels,last-channel,local-time,markdown,navigation,panel,parts,personas,presence,projection,rail,recent-threads,sources,spring,stream-pool,subagent-state,submission-retry,threads,tool-payload,topics,turn-map,unexpected,workspace-feed}.ts',
  'apps/web/src/components/workspace-feed.tsx',
  'apps/web/src/components/{conversation,composer,queued-messages,interaction-cards,approval-card,persona-avatar,on-screen}*',
  'apps/web/src/components/parts/**',
  'apps/web/src/components/shell/pages/tasks-page.tsx',
  'apps/web/test/{drawn-parts,text-blocks,tool-markdown}.test.ts',
  'apps/web/test/{composer,conversation-stream,fences,interactions,keyboard,keys,labels,local-time,markdown,panel,parts,presence,projection,rail,spring,stream-pool,subagent-state,submission-retry,threads,tool-payload,topics,turn-map,workspace-feed}.test.ts',
]
