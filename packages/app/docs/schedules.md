# Schedules: actions that run on their own

An app can run one of its actions on a schedule, without you or the owner: refresh a forecast every hour, sum up the
day at 18:00. Declare it in app.ts; it starts at its next slot once the build is active.

```ts
export default defineApp({
  name: 'weather',
  // …
  egress: ['api.open-meteo.com'],
  schedules: [
    { action: 'refresh', every: '1h', input: { lat: 46.05, lon: 14.51 } },
    { action: 'digest', every: '1d', at: '06:30', input: {} }, // daily at 06:30 UTC
  ],
  actions: {
    refresh: {
      description: 'Fetch the forecast.',
      input: s.object({ lat: s.number(), lon: s.number() }),
      prepare: async (input, ctx) => await (await ctx.fetch(`https://api.open-meteo.com/…`)).json(),
      run: (input, ctx, data) => ({ ...ctx.state, forecast: data.hourly, updatedAt: ctx.now }),
    },
    // …
  },
})
```

- `every` is one of `15m`, `30m`, `1h`, `3h`, `6h`, `12h`, `1d`. Slots fall on the clock in UTC (`1h` runs at :00),
  and `at: 'HH:MM'` (UTC, daily schedules only) picks the time of day. Convert the owner's local time to UTC.
- At most 4 schedules, one per action. `input` must fit the action's input schema.
- A scheduled action runs like any other call: `prepare` with the powers the owner approved, then `run`. Nothing
  else happens: no model is asked unless the action calls `ctx.llm`.
- If runs were missed (goblin was idle), only the newest slot runs. At most 96 runs a day per app.
- A failing run is retried after 15 minutes, then 30, 60… up to 6 hours. After 10 failures in a row the schedule
  pauses until you build a new version; `app_inspect` shows the errors (include `events`).
- While the owner has been away for 30 days or turned the agent's own work off, runs are skipped as "waiting".
- The `<apps>` list at the end of each request shows each schedule and how its last run went; the owner sees it on
  the app's bar.
