# An app's view

Add `view.tsx` to an app's files and the owner can open it: in the chat, as a page beside the chat, or full screen.
It is one React component, the default export, drawn with goblin's components and Tailwind classes. It shows the
app's state live (every change by you, the owner or a schedule) and changes it only through the app's actions. (The
`views` in app.ts are something else: read-only queries you call as tools.)

## Design

Make the view look like one of goblin's own pages: calm, roomy, the important number first. Follow these rules.

- Root: `mx-auto flex w-full max-w-3xl flex-col gap-6`, with `p-6` on a page and `p-4` in the chat. Read the surface
  with `const { surface } = useHost()` and write `surface === 'page' ? 'p-6' : 'p-4'`.
- Do not repeat the app's name as a heading: goblin's frame already shows it. Start with what the owner came for.
- Each part of the view is a `<Section title="Hotels">` from `@goblin/ui`: a small muted head, an optional `action`
  (a button) beside it, then its content. The root's `gap-6` spaces them.
- One `Card` per group. Never a Card inside a Card. Cards side by side: `grid gap-4 sm:grid-cols-2`, each
  `<Card size="sm">`.
- A number that matters (a price, a count, a total) is a `<Stat label="Best tonight" value="€118" />`: big, with a
  small muted label above it and an optional `note` under it. Every other number that changes gets `tabular-nums`.
- Buttons sit in `flex flex-wrap items-center gap-2`. One primary button (the default variant) per section; the rest
  `outline` or `ghost`. Name a button by what it does: "Check now", not "Submit".
- A state is a `Badge`: `default` for good news ("Under target"), `secondary` for neutral, `destructive` for a problem.
- A log or a list of facts is two columns: `grid grid-cols-[max-content_1fr] gap-x-4 gap-y-2 text-sm`, the time or
  name `text-muted-foreground`.
- A map or a chart sizes itself. Put it straight into its section, not into a Card.
- An empty list says so in one muted line and says what fills it.
- Only goblin's colours (below). No gradients, shadows, emoji or decorative icons; an icon goes inside a button.

## view.tsx

A trip app: a price target, the best price, a "Check now" button, the hotels on a map and as cards, the day plan and a
log of checks.

```tsx
import { useActions, useAppState, useHost } from '@goblin/app'
import { MapView } from '@goblin/kit/map'
import {
  Badge,
  Button,
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Section,
  Stat,
} from '@goblin/ui'
import { RefreshCw } from 'lucide-react'
import type { State } from './app'

const euros = (value: number) => `€${Math.round(value)}`

export default function View() {
  const [state] = useAppState<State>()
  const { act, pending, error } = useActions()
  const { surface } = useHost()
  const hotels = state.hotels ?? []
  const checks = state.checks ?? []
  const days = state.days ?? []
  const best = hotels.length === 0 ? undefined : Math.min(...hotels.map((hotel) => hotel.price))
  return (
    <div className={`mx-auto flex w-full max-w-3xl flex-col gap-6 ${surface === 'page' ? 'p-6' : 'p-4'}`}>
      <Section title="Price watch">
        <Card>
          <CardContent className="flex flex-col gap-4">
            <div className="grid grid-cols-2 gap-4">
              <Stat label="Best tonight" value={best === undefined ? '–' : euros(best)} />
              <Stat label="Your target" value={euros(state.target)} />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button disabled={pending} onClick={() => void act('check', {})}>
                <RefreshCw />
                Check now
              </Button>
              {state.checkedAt && <span className="text-sm text-muted-foreground">Last checked {state.checkedAt}</span>}
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
          </CardContent>
        </Card>
      </Section>

      <Section title="Hotels">
        {hotels.length === 0 ? (
          <p className="text-sm text-muted-foreground">No hotels yet. Check now to find some.</p>
        ) : (
          <>
            <MapView
              spec={{ markers: hotels.map((hotel) => ({ lat: hotel.lat, lng: hotel.lng, label: hotel.name })) }}
            />
            <div className="grid gap-4 sm:grid-cols-2">
              {hotels.map((hotel) => (
                <Card key={hotel.id} size="sm">
                  <CardHeader>
                    <CardTitle>{hotel.name}</CardTitle>
                    <CardDescription>{hotel.area}</CardDescription>
                    {hotel.price <= state.target && (
                      <CardAction>
                        <Badge>Under target</Badge>
                      </CardAction>
                    )}
                  </CardHeader>
                  <CardContent>
                    <span className="text-2xl font-semibold tabular-nums">{euros(hotel.price)}</span>
                    <span className="text-sm text-muted-foreground"> a night</span>
                  </CardContent>
                </Card>
              ))}
            </div>
          </>
        )}
      </Section>

      {days.length > 0 && (
        <Section title="Plan">
          <Card>
            <CardContent>
              <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-2 text-sm">
                {days.map((day) => (
                  <div key={day.day} className="contents">
                    <dt className="font-medium">{day.day}</dt>
                    <dd>{day.plan}</dd>
                  </div>
                ))}
              </dl>
            </CardContent>
          </Card>
        </Section>
      )}

      <Section title="Checks">
        {checks.length === 0 ? (
          <p className="text-sm text-muted-foreground">No checks yet.</p>
        ) : (
          <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-2 text-sm">
            {checks.map((check) => (
              <div key={check.at} className="contents">
                <dt className="text-muted-foreground tabular-nums">{check.at}</dt>
                <dd>{check.note}</dd>
              </div>
            ))}
          </dl>
        )}
      </Section>
    </div>
  )
}
```

In app.ts, export the state's type for the view:

```ts
export type State = {
  target: number
  checkedAt?: string
  hotels: { id: string; name: string; area: string; price: number; lat: number; lng: number }[]
  checks: { at: string; note: string }[]
  days: { day: string; plan: string }[]
}
```

## Rules

- `useAppState<State>()` returns `[state, { revision }]`. The view is drawn once the first state has arrived, so state
  is there; still read lists with a fallback (`state.items ?? []`).
- `useActions()` returns `{ act, pending, error }`. `await act('name', input)` calls one of the app's actions (any
  action, also those with `agent: false`) and resolves with the new state; it throws when the action fails, and
  `error` holds the message.
- A view calls only its own app's actions. It has no network (`fetch` fails), no storage and no new windows. Data
  from outside comes through an action's `prepare` (topic `powers`). `download(name, text, type)` from `@goblin/app`
  offers the owner a file to save. `share(text)` puts what the owner is looking at (the selected task, the filtered
  rows) beside their next message to you, as context they can remove.
- Each build renders the view once with the state the app will have (`initial` for a new app). If it throws, the
  build fails with the line of `view.tsx` and the app keeps running its last release: fix it with `edits` (often a
  field of state that is not there yet: read state the way `initial` shapes it and guard optional parts). Read
  `window` or `document` in `useEffect` or event handlers, never while rendering: the check cannot run those and says
  so in `viewWarning`.
- Imports: `react`, `@goblin/app`, `@goblin/ui`, `@goblin/kit/chart`, `@goblin/kit/map`, `@goblin/kit/diagram`,
  `recharts`, `react-leaflet`, `leaflet`, `lucide-react` (icons), and types from `./app`. Nothing else.
- Style with Tailwind classes and goblin's colours, which follow light and dark: `bg-background`, `bg-card`,
  `bg-muted`, `text-foreground`, `text-muted-foreground`, `text-primary`, `text-destructive`, `border`. Do not write
  colours like `#fff` or `bg-white`. Lay it out as **Design** says; the width changes, so let rows wrap.
- If the view throws, the owner sees the error and you see it in the `<apps>` list at the end of each request and in
  `app_inspect` events. Fix it with `app_build` and `edits`.

## Components (`@goblin/ui`)

- `Button` (`variant`: default, outline, secondary, ghost, destructive, link; `size`: default, xs, sm, lg, and for
  a button with only an icon, which needs an `aria-label`: icon, icon-xs, icon-sm, icon-lg)
- `Card` (`size`: default, sm), `CardHeader`, `CardTitle`, `CardDescription`, `CardAction` (top right of the header),
  `CardContent`, `CardFooter`
- `Input`, `Textarea`, `Label`, `Switch` (`checked`, `onCheckedChange`), `NativeSelect` + `NativeSelectOption`
- `Badge` (`variant`: default, secondary, destructive, outline), `Separator`, `Skeleton`, `Spinner`
- `Tabs` (`defaultValue`), `TabsList`, `TabsTrigger` (`value`), `TabsContent` (`value`)
- `Alert` (`variant`: default, destructive), `AlertTitle`, `AlertDescription`
- `Empty`, `EmptyHeader`, `EmptyMedia`, `EmptyTitle`, `EmptyDescription`, `EmptyContent`
- `Meter` (`value`, `max`)
- `Section` (`title`, optional `action`), `Stat` (`label`, `value`, optional `note`): the layout pieces of **Design**

## Charts, maps, diagrams, icons

```tsx
import { Chart } from '@goblin/kit/chart'
// type: line, bar, area or pie; x names the category column; up to five numeric series
<Chart spec={{ type: 'bar', x: 'day', series: [{ key: 'minutes', label: 'Minutes' }], data: rows }} />

import { MapView } from '@goblin/kit/map'
// markers and lines in latitude/longitude; it fits what it shows
<MapView spec={{ markers: [{ lat: 59.44, lng: 24.75, label: 'Tallinn' }] }} />

import { Diagram } from '@goblin/kit/diagram'
const flow = 'graph TD\n  A --> B'
// Offers an explorer for zoom, pan and node connections inside this frame.
<Diagram source={flow} fallback={<pre>{flow}</pre>} />
// Pass interactive={false} for an image preview only.

import { Check, Trash2 } from 'lucide-react'
<Trash2 className="size-4" />
```

Use Recharts or react-leaflet directly for what the kit does not draw; on a react-leaflet map use `CircleMarker`, not
`Marker`.

## App placement

An app has one live frame shared by its chat and page. `useHost()` from `@goblin/app` follows the current surface (`inline` or `page`) and available width and height. Inline height requests are bounded by the host; a page fills its pane. Opening a page and returning to chat preserves React state and the action bridge.

Home dashboard presentation is deferred. Do not offer to place new apps there: saved layouts are retained by the runtime, but currently have no browser surface.

For a live inbox or calendar view, declare the exact connected tool in `uses.tools`, refresh it with a `{ action: 'refresh', every: '15m' }` schedule, validate and bound the response in `prepare`, and retain the last good state when a refresh fails. Show freshness and the last error; the complete example is in the `app_docs` `examples` topic. The owner must connect the real server and approve the app power.
