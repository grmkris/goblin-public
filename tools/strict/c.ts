/** Lane C's files that pass the strict rules (tools/strict/index.ts). Only lane C appends globs here. */
export const paths: string[] = [
  'apps/runtime/src/chats/**',
  'apps/runtime/src/{conversations,agent-program,composer,conversation-queue,agent-model,replies,attention}.ts',
  'apps/runtime/src/channel/turns.ts',
  'apps/runtime/src/personas/ask.ts',
  'apps/runtime/src/pi/{content,transcript,context-tail,turns,events,moves,ask-user}.ts',
  'apps/runtime/src/storage/{chat-operations,migrations/conversation}.ts',
  'apps/runtime/src/layers/conversation.ts',
  'apps/runtime/test/http/api/conversations.test.ts',
  'apps/runtime/test/{chats-service,chats,moves,queue,content,context-tail,replies,attention,ask-user}.test.ts',
  'apps/runtime/test/integration/{probe-reads,composer-probe,native-composer,thread-heads-case,move-case,move-probe,queue-case}.ts',
]
