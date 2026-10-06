// The one place to add a server: the servers we suggest, a registry search, or an address, as tabs of one card.
import { useState } from 'react'
import type { ServerView } from '@purrable/contracts'
import { Card, CardContent, Tabs, TabsContent, TabsList, TabsTrigger } from '@purrable/ui'
import { AddByAddress, SuggestedServers } from './server-add.tsx'
import { ServerSearch } from './server-search.tsx'

type PickerTab = 'suggested' | 'search' | 'address'

export function ServerPicker({
  version,
  onChanged,
  onAdded,
  onMessage,
}: {
  /** Changes whenever the server list does. */
  readonly version: number
  /** A server was added and connected from a list, with what to tell the owner. */
  readonly onChanged: (message: string) => void
  /** A server was added by its address and waits to be connected. */
  readonly onAdded: (server: ServerView) => void
  readonly onMessage: (message: string) => void
}) {
  const [tab, setTab] = useState<PickerTab>('suggested')
  return (
    <Card>
      <CardContent>
        <Tabs value={tab} onValueChange={(value: PickerTab) => setTab(value)}>
          <TabsList>
            <TabsTrigger value="suggested">Suggested</TabsTrigger>
            <TabsTrigger value="search">Search</TabsTrigger>
            <TabsTrigger value="address">By address</TabsTrigger>
          </TabsList>
          <TabsContent value="suggested">
            <p className="server-note">Servers we have checked work from here. You still choose every tool.</p>
            <SuggestedServers version={version} onChanged={onChanged} onMessage={onMessage} />
          </TabsContent>
          <TabsContent value="search">
            <ServerSearch onChanged={onChanged} onMessage={onMessage} />
          </TabsContent>
          <TabsContent value="address">
            <AddByAddress onAdded={onAdded} onMessage={onMessage} />
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  )
}
