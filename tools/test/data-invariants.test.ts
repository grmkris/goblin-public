// Ported from myapps (`grmkris/myapps` `27416c98`, `tools/test/data-invariants.test.ts`) with tools/oxlint/data-invariants.ts.
import { RuleTester } from 'oxlint/plugins-dev'
import { describe, it } from 'vitest'
import { noLoaderData, noNetworkInEffect, noTransportOutsideClient } from '../oxlint/data-invariants.ts'

RuleTester.describe = describe
RuleTester.it = it
const tester = new RuleTester({ languageOptions: { parserOptions: { lang: 'tsx' } } })
const transportMessage =
  "Server calls go through the app's client in a query or mutation factory (docs/agents/lint-quality.md)."
const networkMessage =
  'Read server data with a query factory (useQuery/useSuspenseQuery); start writes from the event handler with a mutation (docs/agents/lint-quality.md).'
const loaderMessage =
  "API data comes from the cache (useSuspenseQuery with the loader's query options), not useLoaderData (docs/agents/lint-quality.md)."

tester.run('no-transport-outside-client', noTransportOutsideClient, {
  valid: [
    'queryOptions({ queryFn: () => fetch("/api") })',
    'mutationOptions({ mutationFn: async () => fetch("/api", { method: "POST" }) })',
    'const options = { async queryFn() { return fetch("/api") } }',
    'const options = { "mutationFn": () => { const send = () => callApi(); return send() } }',
    'const options = { ["queryFn"]: () => Promise.resolve().then(() => chrome.runtime.sendMessage({})) }',
    'queryOptions({ queryFn: active ? () => fetch("/api") : skipToken })',
    'const options = { queryFn: () => new XMLHttpRequest() }',
    'const options = { mutationFn: () => owner.callTool("save") }',
    'function component(fetch: () => void) { fetch() }',
    'const fetch = () => 1; fetch()',
    'const window = { fetch() {} }; window.fetch()',
    'function local(chrome: { runtime: { sendMessage(): void } }) { chrome.runtime.sendMessage() }',
    'function component(XMLHttpRequest: new () => object) { new XMLHttpRequest() }',
    'const HttpClient = { get() {} }; HttpClient.get()',
    'task.run(); state.run(); command.run()',
    'const task = { run() {} }; const alias = task; alias.run()',
    'const task = task.member; task.run()',
    'const a = b.member; const b = a.member; a.run()',
    'import { task } from "../tasks"; task.run()',
    'import * as HttpClient from "effect/http/HttpClient"; const options = { queryFn: () => HttpClient.get("/api") }',
    'const owner = makeApiQuery({}); const options = { queryFn: () => owner.run(read) }',
    { code: 'fetch("/api"); HttpClient.get("/api")', options: [{ callees: ['custom.send'] }] },
    { code: 'custom.send()', options: [{ callees: [] }] },
  ],
  invalid: [
    { code: 'fetch("/api")', errors: [{ message: transportMessage }] },
    { code: 'globalThis.fetch("/api"); window.fetch("/api"); self.fetch("/api")', errors: 3 },
    { code: 'window["fetch"]?.("/api")', errors: [{ messageId: 'transport' }] },
    { code: 'new XMLHttpRequest(); new globalThis.XMLHttpRequest()', errors: 2 },
    { code: 'HttpClient.get("/api"); HttpClient["execute"](request)', errors: 2 },
    { code: 'HttpApiClient.make(Api)', errors: [{ messageId: 'transport' }] },
    {
      code: 'import * as Http from "effect/http/HttpClient"; Http.post("/api")',
      errors: [{ messageId: 'transport' }],
    },
    {
      code: 'import { get as read } from "effect/http/HttpClient"; read("/api")',
      errors: [{ messageId: 'transport' }],
    },
    {
      code: 'import { make as build } from "effect/http-api/HttpApiClient"; build(Api)',
      errors: [{ messageId: 'transport' }],
    },
    { code: 'import { callApi as send } from "../lib/api"; send(read)', errors: [{ messageId: 'transport' }] },
    { code: 'const owner = makeApiQuery({}); owner.run(read)', errors: [{ messageId: 'transport' }] },
    { code: 'makeApiQuery({}).run(read)', errors: [{ messageId: 'transport' }] },
    {
      code: 'import { makeApiQuery as make } from "./query/api-query.ts"; const owner = make({}); const alias = owner; alias.run(read)',
      errors: [{ messageId: 'transport' }],
    },
    {
      code: 'import * as Query from "./query/api-query.ts"; const owner = Query.makeApiQuery({}); owner.run(read)',
      errors: [{ messageId: 'transport' }],
    },
    { code: 'import { owner as api } from "../lib/api.ts"; api.run(read)', errors: [{ messageId: 'transport' }] },
    {
      code: 'const alias = other; const other = alias; alias.run(read); fetch("/api")',
      errors: [{ messageId: 'transport' }],
    },
    { code: 'connection.client.callTool("save")', errors: [{ messageId: 'transport' }] },
    { code: 'chrome.runtime.sendMessage({}); chrome["runtime"]["sendMessage"]({})', errors: 2 },
    { code: 'const queryFn = () => fetch("/api"); queryOptions({ queryFn })', errors: [{ messageId: 'transport' }] },
    { code: 'queryOptions({ queryFn: fetch("/api") })', errors: [{ messageId: 'transport' }] },
    { code: 'queryOptions({ queryFn: (() => fetch("/api"))() })', errors: [{ messageId: 'transport' }] },
    { code: 'const options = { onSuccess: () => fetch("/api") }', errors: [{ messageId: 'transport' }] },
    { code: 'const options = { [key]: () => fetch("/api") }', errors: [{ messageId: 'transport' }] },
    {
      code: 'function component() { return <button onClick={() => fetch("/api")} /> }',
      errors: [{ messageId: 'transport' }],
    },
    {
      code: 'const custom = {}; custom.send()',
      options: [{ callees: ['custom.send'] }],
      errors: [{ messageId: 'transport' }],
    },
    { code: 'service.request()', options: [{ callees: ['*.request'] }], errors: [{ messageId: 'transport' }] },
    // goblin's list (oxlint.config.ts) adds the browser's SSE transport.
    {
      code: 'new EventSource("/api/events")',
      options: [{ callees: ['EventSource'] }],
      errors: [{ messageId: 'transport' }],
    },
  ],
})

tester.run('no-network-in-effect', noNetworkInEffect, {
  valid: [
    'const onClick = () => fetch("/api")',
    'const onClick = () => mutation.mutate({}); const onSubmit = () => mutation.mutateAsync({})',
    'const options = { queryFn: () => fetch("/api"), mutationFn: () => callApi(write) }',
    'useEffect(() => { socket.addEventListener("change", () => queryClient.invalidateQueries({ queryKey: ["items"] })) }, [])',
    'useEffect(() => { const task = { run() {} }; task.run() }, [])',
    'function useEffect(callback: () => void) { callback() }; useEffect(() => fetch("/api"))',
    'import { useEffect } from "react"; function view(fetch: () => void) { useEffect(() => fetch(), []) }',
    'useMemo(() => fetch("/api"), [])',
    { code: 'useEffect(() => fetch("/api"), [])', options: [{ callees: ['custom.send'] }] },
  ],
  invalid: [
    { code: 'useEffect(() => { fetch("/api") }, [])', errors: [{ message: networkMessage }] },
    { code: 'useLayoutEffect(() => { new XMLHttpRequest() }, [])', errors: [{ messageId: 'network' }] },
    { code: 'React.useEffect(() => { callApi(read) }, [])', errors: [{ messageId: 'network' }] },
    { code: 'useEffect(() => { function read() { fetch("/api") }; read() }, [])', errors: [{ messageId: 'network' }] },
    {
      code: 'useEffect(() => { const load = async () => { await fetch("/api") }; void load() }, [])',
      errors: [{ messageId: 'network' }],
    },
    {
      code: 'useEffect(() => { Promise.resolve().then(() => fetch("/api")) }, [])',
      errors: [{ messageId: 'network' }],
    },
    { code: 'useEffect(() => () => fetch("/api"), [])', errors: [{ messageId: 'network' }] },
    { code: 'useEffect(() => { mutation.mutate({}); mutation.mutateAsync({}) }, [])', errors: 2 },
    {
      code: 'useEffect(() => { const options = { queryFn: () => fetch("/api") } }, [])',
      errors: [{ messageId: 'network' }],
    },
    { code: 'useLayoutEffect(() => chrome.runtime.sendMessage({}), [])', errors: [{ messageId: 'network' }] },
    { code: 'useEffect(() => bridge.callTool("read"), [])', errors: [{ messageId: 'network' }] },
    {
      code: 'const owner = makeApiQuery({}); useEffect(() => owner.run(read), [])',
      errors: [{ messageId: 'network' }],
    },
    { code: 'useEffect(() => HttpClient.get("/api"), [])', errors: [{ messageId: 'network' }] },
    { code: 'useEffect(() => HttpApiClient.make(Api), [])', errors: [{ messageId: 'network' }] },
    {
      code: 'import { useEffect as effect } from "react"; effect(() => fetch("/api"), [])',
      errors: [{ messageId: 'network' }],
    },
    {
      code: 'import * as R from "react"; R.useLayoutEffect(() => fetch("/api"), [])',
      errors: [{ messageId: 'network' }],
    },
    {
      code: 'import R from "react"; R.useEffect(() => mutation["mutate"]({}), [])',
      errors: [{ messageId: 'network' }],
    },
    { code: 'const load = () => fetch("/api"); useEffect(load, [])', errors: [{ messageId: 'network' }] },
    { code: 'useLayoutEffect(load, []); function load() { fetch("/api") }', errors: [{ messageId: 'network' }] },
    {
      code: 'const load = () => mutation.mutateAsync({}); const alias = load; useEffect(alias, [])',
      errors: [{ messageId: 'network' }],
    },
    { code: 'useEffect(useCallback(() => fetch("/api"), []), [])', errors: [{ messageId: 'network' }] },
    {
      code: 'useEffect(() => custom.send(), [])',
      options: [{ callees: ['custom.send'] }],
      errors: [{ messageId: 'network' }],
    },
    {
      code: 'useEffect(() => mutation.mutate({}), [])',
      options: [{ callees: [] }],
      errors: [{ messageId: 'network' }],
    },
  ],
})

tester.run('no-loader-data', noLoaderData, {
  valid: [
    'const { data } = useSuspenseQuery(itemsQuery())',
    {
      code: 'const Route = createFileRoute("/")({ loader: () => getOrigin() }); const origin = Route.useLoaderData()',
      options: [{ mode: 'query-loaders' }],
    },
    { code: 'useLoaderData(); Route.useLoaderData()', options: [{ mode: 'query-loaders' }] },
    {
      code: 'const options = { loader: () => ({ origin: getOrigin() }) }; const { origin } = useLoaderData()',
      options: [{ mode: 'query-loaders' }],
    },
    {
      code: 'const Route = createFileRoute("/")({ loader: async ({ context }) => { await context.queryClient.query(itemsQuery); return { origin: await getOrigin() } } }); const { origin } = Route.useLoaderData()',
      options: [{ mode: 'query-loaders' }],
    },
    {
      code: 'const Route = createFileRoute("/")({ loader: async ({ context }) => { if (!context.me.eligible) return { origin: await getOrigin() }; const [origin] = await Promise.all([getOrigin(), context.queryClient.query(itemsQuery)]); return { origin } } }); const { origin } = Route.useLoaderData()',
      options: [{ mode: 'query-loaders' }],
    },
    { code: 'const { data } = useRouteContext()', options: [{ mode: 'all' }] },
    'function useLoaderData() { return "local" }; useLoaderData()',
  ],
  invalid: [
    { code: 'useLoaderData()', errors: [{ message: loaderMessage }] },
    { code: 'Route.useLoaderData()', errors: [{ messageId: 'loader' }] },
    { code: 'Route["useLoaderData"]?.()', errors: [{ messageId: 'loader' }] },
    {
      code: 'import { useLoaderData as read } from "@tanstack/react-router"; read()',
      errors: [{ messageId: 'loader' }],
    },
    {
      code: 'const Route = createFileRoute("/")({ loader: () => getOrigin() }); Route.useLoaderData()',
      options: [{ mode: 'all' }],
      errors: [{ messageId: 'loader' }],
    },
    {
      code: 'const options = { loader: ({ context }) => context.queryClient.query(itemsQuery) }; useLoaderData()',
      options: [{ mode: 'query-loaders' }],
      errors: [{ messageId: 'loader' }],
    },
    {
      code: 'const options = { loader: () => itemsQuery() }; Route.useLoaderData()',
      options: [{ mode: 'query-loaders' }],
      errors: [{ messageId: 'loader' }],
    },
    {
      code: 'const options = { loader: () => itemOptions() }; Route.useLoaderData()',
      options: [{ mode: 'query-loaders' }],
      errors: [{ messageId: 'loader' }],
    },
    {
      code: 'import * as queries from "../queries"; const options = { loader: () => queries.itemQuery() }; Route.useLoaderData()',
      options: [{ mode: 'query-loaders' }],
      errors: [{ messageId: 'loader' }],
    },
    {
      code: 'const options = { loader: ({ context }) => context["queryClient"].query(items) }; Route.useLoaderData()',
      options: [{ mode: 'query-loaders' }],
      errors: [{ messageId: 'loader' }],
    },
    {
      code: 'function itemsQuery() {}; const options = { loader: () => itemsQuery() }; Route.useLoaderData()',
      options: [{ mode: 'query-loaders' }],
      errors: [{ messageId: 'loader' }],
    },
    {
      code: 'const options = { loader: load }; const load = ({ queryClient }) => queryClient.query(itemsQuery); Route.useLoaderData()',
      options: [{ mode: 'query-loaders' }],
      errors: [{ messageId: 'loader' }],
    },
    {
      code: 'Route.useLoaderData(); function load() { return itemOptions() }; const options = { loader: load }',
      options: [{ mode: 'query-loaders' }],
      errors: [{ messageId: 'loader' }],
    },
    {
      code: 'const options = { loader: () => ({ data: itemsQuery() }) }; Route.useLoaderData()',
      options: [{ mode: 'query-loaders' }],
      errors: [{ messageId: 'loader' }],
    },
    {
      code: 'const options = { loader: ({ queryClient }) => ({ origin: "origin", data: queryClient.query(itemsQuery) }) }; Route.useLoaderData()',
      options: [{ mode: 'query-loaders' }],
      errors: [{ messageId: 'loader' }],
    },
    {
      code: 'const options = { loader: ({ queryClient }) => ({ origin: queryClient.query(itemsQuery) }) }; Route.useLoaderData()',
      options: [{ mode: 'query-loaders' }],
      errors: [{ messageId: 'loader' }],
    },
    {
      code: 'const options = { loader: async ({ queryClient }) => { const origin = await queryClient.query(itemsQuery); return { origin } } }; Route.useLoaderData()',
      options: [{ mode: 'query-loaders' }],
      errors: [{ messageId: 'loader' }],
    },
  ],
})
