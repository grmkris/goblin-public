import { createFileRoute, redirect } from '@tanstack/react-router'

/** The workspace with App `<id>` focused as a page, opened beside the focused pane when it is not open yet. */
export const Route = createFileRoute('/_workspace/a/$appId')({
  beforeLoad: ({ params }) => {
    if (!/^\d{1,12}$/u.test(params.appId)) throw redirect({ to: '/' })
  },
})
