# An app's view

Add `view.tsx` to an app's files and the owner can open it: in the chat, as a page beside the chat, or full screen.
It is one React component, the default export, drawn with goblin's components and Tailwind classes. It shows the
app's state live (every change by you, the owner or a schedule) and changes it only through the app's actions. (The
`views` in app.ts are something else: read-only queries you call as tools.)

## view.tsx

```tsx
import { useActions, useAppState } from '@goblin/app'
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, Input } from '@goblin/ui'
import { useState } from 'react'
import type { State } from './app'

export default function View() {
  const [state] = useAppState<State>()
  const { act, pending, error } = useActions()
  const [title, setTitle] = useState('')
  const books = state.books ?? []
  return (
    <div className="flex flex-col gap-4 p-4">
      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          if (title.trim() === '') return
          void act('add', { title: title.trim() }).then(() => setTitle(''))
        }}
      >
        <Input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Add a book" />
        <Button type="submit" disabled={pending}>
          Add
        </Button>
      </form>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <Card>
        <CardHeader>
          <CardTitle>To read</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {books.length === 0 && <p className="text-sm text-muted-foreground">Nothing yet.</p>}
          {books.map((book) => (
            <div key={book.id} className="flex items-center justify-between gap-2">
              <span className={book.done ? 'text-muted-foreground line-through' : ''}>{book.title}</span>
              {book.done ? (
                <Badge variant="secondary">Read</Badge>
              ) : (
                <Button size="sm" variant="outline" onClick={() => void act('finish', { id: book.id })}>
                  Done
                </Button>
              )}
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  )
}
```

In app.ts, export the state's type for the view: `export type State = { books: { id: string; title: string; done:
boolean }[] }`.

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
  `@goblin/kit/mdxcn`, `recharts`, `react-leaflet`, `leaflet`, `lucide-react` (icons), and types from `./app`. Nothing else.
- Style with Tailwind classes and goblin's colours, which follow light and dark: `bg-background`, `bg-card`,
  `bg-muted`, `text-foreground`, `text-muted-foreground`, `text-primary`, `text-destructive`, `border`. Do not write
  colours like `#fff` or `bg-white`. Start the root with padding (`p-4`); the width changes, so let rows wrap.
- If the view throws, the owner sees the error and you see it in the `<apps>` list at the end of each request and in
  `app_inspect` events. Fix it with `app_build` and `edits`.

## Components (`@goblin/ui`)

- `Button` (`variant`: default, outline, secondary, ghost, destructive, link; `size`: default, xs, sm, lg, icon)
- `Card`, `CardHeader`, `CardTitle`, `CardDescription`, `CardAction`, `CardContent`, `CardFooter`
- `Input`, `Textarea`, `Label`, `Switch` (`checked`, `onCheckedChange`), `NativeSelect` + `NativeSelectOption`
- `Badge` (`variant`: default, secondary, destructive, outline), `Separator`, `Skeleton`, `Spinner`
- `Tabs` (`defaultValue`), `TabsList`, `TabsTrigger` (`value`), `TabsContent` (`value`)
- `Alert` (`variant`: default, destructive), `AlertTitle`, `AlertDescription`
- `Empty`, `EmptyHeader`, `EmptyMedia`, `EmptyTitle`, `EmptyDescription`, `EmptyContent`
- `Meter` (`value`, `max`)

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
<Diagram source={flow} fallback={<pre>{flow}</pre>} />

import { Check, Trash2 } from 'lucide-react'
<Trash2 className="size-4" />
```

Use Recharts or react-leaflet directly for what the kit does not draw; on a react-leaflet map use `CircleMarker`, not
`Marker`.

## Compact read-only figures (`@goblin/kit/mdxcn`)

These share the chat's mdxcn components, light/dark tokens and reduced-motion-aware entrances. Props are plain data:

```tsx
import { Timeline, Check, Compare, Stat, Spark } from '@goblin/kit/mdxcn'

<Timeline title="Release" events={[
  { date: 'Monday', label: 'Build', state: 'done' },
  { date: 'Today', label: 'Review', state: 'now', note: 'Tests ready' },
  { date: 'Friday', label: 'Ship', state: 'next' },
]} />
<Check title="Tasks" items={[
  { label: 'Build', done: true, items: [{ label: 'Tests', done: true }] },
  { label: 'Review', done: false },
]} />
<Compare title="Options" columns={['A', 'B']} rows={[
  { label: 'Offline', values: [true, false] },
  { label: 'Cost', values: [3, 'Free'] },
]} />
<Stat title="Summary" items={[{ label: 'Done', value: 12, hint: 'Today', accent: true }]} />
<Spark title="This week" data={[2, 3, 5, 4]} caption="Tasks per day" />
```

Titles, labels and dates: 1–120 characters. Notes, hints, captions and comparison strings: at most 240.
Stat value strings: at most 64. Keep lists small: 32 timeline events; 20 checks per list, three levels and 64 total;
2–4 distinct comparison columns, 1–24 rows and one value per column; 1–8 stats; 2–64 non-negative finite spark
points up to 1e12. The components display data; any interaction still uses `useActions().act` and your app's actions.
They need no network or additional powers. They and their parser run for real in the build's render check.

For JSON data, validate with `mdxcnSpec(text)` from the same entrypoint (32,768 source characters maximum, no extra
fields). It returns a `MdxcnSpec` discriminated by `kind`, or `undefined`. `Mdxcn` can display a whole JSON figure:

```tsx
import { Mdxcn } from '@goblin/kit/mdxcn'
;<Mdxcn source={jsonText} fallback={<pre>{jsonText}</pre>} />
```

## Home tiles

An app has one live frame, shared by its chat, Home and page. `useHost()` from `@goblin/app` follows its placement:
`{ surface: 'inline' | 'home' | 'page', tileSize?: 'small' | 'medium' | 'large' | 'wide', width, height }`. On Home,
width and height are fixed; resize requests do not change the tile. Use a compact glance view, a handful of rows and
one primary action. Open gives the owner the full page without resetting React state or the action bridge.
Home supplies the tile's card colour as the frame background and places the frame flush under its label. Draw the glance contents directly; reserve an outer Card for the full-page variant.

```tsx
const host = useHost()
const compact = host.surface === 'home'
const shown = compact ? books.slice(0, host.tileSize === 'large' ? 5 : 2) : books
```

After building an app with a view, read `home_read` for its App id and layout revision, then call `home_edit` with an
`add` operation (`kind: 'app'`, that `appId`, a new tile `id`, and `size: 'medium'` or `'large'`). Read again if the
revision is stale. Placing grants no power and starts no model. Remove from Home keeps the app; Close unloads the
view and leaves a Closed · Show tile. Page > Home > chat is the placement order; other places show a stub.
