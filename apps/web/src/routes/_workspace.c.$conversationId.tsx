import { createFileRoute, redirect } from '@tanstack/react-router'

/** The workspace with conversation `<id>` focused, opened beside the focused pane when it is not open yet. */
export const Route = createFileRoute('/_workspace/c/$conversationId')({
  beforeLoad: ({ params }) => {
    if (!/^\d{1,12}$/u.test(params.conversationId)) throw redirect({ to: '/' })
  },
})
