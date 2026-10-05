import { createFileRoute } from '@tanstack/react-router'

/** The workspace as this device left it; the URL moves to the focused conversation once it is restored. */
export const Route = createFileRoute('/_workspace/')({})
