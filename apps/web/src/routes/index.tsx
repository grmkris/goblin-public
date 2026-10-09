import { createFileRoute, redirect } from '@tanstack/react-router'
import { lastChannel } from '../lib/last-channel.ts'

/** Home: the channel this tab showed last, Personal's at first. */
export const Route = createFileRoute('/')({
  beforeLoad: () => {
    throw redirect({ to: '/c/$chatId', params: { chatId: typeof window === 'undefined' ? '1' : lastChannel() } })
  },
})
