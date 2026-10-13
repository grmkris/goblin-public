// The shelf of servers goblin suggests, typeset as a short list by what they are for. The names and groups are the
// shelf's own (apps/runtime/src/mcp/suggested.ts, titled as `components/server-add.tsx` titles its groups); this is
// a picture of it for visitors, so it reads nothing from the server.

const SHELF: readonly { readonly group: string; readonly servers: readonly string[] }[] = [
  { group: 'Your apps', servers: ['mysi: notes, browsers, Telegram, email, skills and terminals'] },
  { group: 'Pay and publish', servers: ['Goblin Wallet', 'Cloudflare'] },
  { group: 'Travel', servers: ['Kiwi.com', 'trivago', 'Ferryhopper'] },
  { group: 'Knowledge', servers: ['Wikidata', 'Microsoft Learn', 'AWS Knowledge', 'Hugging Face'] },
  { group: 'Crypto data', servers: ['CoinGecko', 'Etherscan'] },
  { group: 'Views in the chat', servers: ['Excalidraw', 'SubwayInfo.nyc'] },
  { group: 'Code and docs', servers: ['DeepWiki', 'Context7', 'Cloudflare Docs', 'Svelte'] },
]

export function ServerList() {
  return (
    <dl className="landing-shelf" aria-label="Servers on goblin's shelf">
      {SHELF.map(({ group, servers }) => (
        <div key={group}>
          <dt>{group}</dt>
          <dd>{servers.join(', ')}</dd>
        </div>
      ))}
    </dl>
  )
}
