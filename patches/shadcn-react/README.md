# @shadcn/react MessageScroller patch

`patches/@shadcn%2Freact@0.3.1.patch` replaces `dist/message-scroller/index.js` of the published `@shadcn/react` 0.3.1
(the latest release) with the same component built from upstream source plus the fixes below. bun applies it on
install (root `package.json` `patchedDependencies`); `bun run check:patches` proves the installed file is the patched
one, because bun skips a patch silently when it does not match (oven-sh/bun#40110, #33520).

Nothing else of the package changes: the questionnaire, its shared chunk and the public types stay as published.

## What is in it

Base: shadcn-ui/ui `63c1308d112b6b1205d86244a156cca1abef5087` (#11714, the 0.3.1 release; nothing in `packages/react`
has changed since). Its build is byte-identical to the published `dist/message-scroller/index.js`.

`message-scroller.diff` is everything applied on top, tests included, in this order:

| Change                                                                                                          | Upstream                                                     | Head         |
| --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ------------ |
| A same-count row swap (a streamed reply committing) no longer scrolls the oldest turn to the top                | [#11182](https://github.com/shadcn-ui/ui/pull/11182), #11181 | `7dcbb3b528` |
| Trackpad momentum at the bottom, or a pan inside a nested scroller, no longer turns follow-output off for good  | [#11223](https://github.com/shadcn-ui/ui/pull/11223), #11224 | `689c51af39` |
| Scrolling while a just-sent turn is held drains the reserved space instead of yanking to the live end           | [#11465](https://github.com/shadcn-ui/ui/pull/11465), #11125 | `bd850c4b9e` |
| Narrowing the transcript (a pane resized, an App opened beside it) keeps a reader resting at the end at the end | [#11506](https://github.com/shadcn-ui/ui/pull/11506)         | `14b28a872e` |
| Each streamed chunk is corrected before paint, not one frame late                                               | [#11808](https://github.com/shadcn-ui/ui/pull/11808), #11577 | `6e12421a53` |
| Prepends are told by the first message row, so a persistent "Earlier messages" row no longer hides them         | [#12150](https://github.com/shadcn-ui/ui/pull/12150) (ours)  |              |

Each PR was applied as its own diff against its merge base (`git apply -3`). Resolved by hand:

- #11465 and #11182 add browser tests at the same place; both are kept.
- #11506 and #11465 both extend `handleResize`: the spacer drain runs first, then the rewrap re-pin.
- #11808 runs `handleResize` synchronously in the content `ResizeObserver` and suspends the observer only while a turn
  is held. #11465's drain also writes the spacer, so the observer is suspended whenever a spacer is reserved, too.

Ours (upstream as [#12150](https://github.com/shadcn-ui/ui/pull/12150), without the anchor-scan part, which needs
#11182), in `handleContentChange`: a prepend is recognised when the previous first **message** row (one with a
`messageId`) is no longer the first message row, rather than when the previous first child moved. Rows that are not
messages, such as goblin's "Earlier messages" button or a thread's lead, can stay first or come and go without hiding
a prepend. New scroll anchors are the ones not yet handled, wherever they were inserted, rather than whatever sits
after the previous item count. Three browser tests cover a persistent load-earlier row, the last page landing as that
row goes away (same count), and a lead item; each fails without the change.

Applied with `bun patch` directly on `dist/message-scroller/index.js`, **not in `message-scroller.diff` yet** (so a
regeneration with the script drops it until it is ported into the source diff, and `check:patches` cannot notice): a
turn that arrives together with more than a screen of its reply (the stream starting again from a snapshot after the
tab was away, a Telegram turn, a queued one starting) used to stay pinned at the top for the whole stream with the
jump-to-end arrow on, because the only hand-off from the held turn to following the bottom needed the reserved space
under it to shrink to 0, and here it was 0 from the start. `followAnsweredTurn` (called after a new turn is pinned and
after every re-pin) hands off as soon as the held turn has a message row after it and more of the transcript is below
the fold than in view; a long message of the owner's with no reply yet stays pinned. Proved by
`heavy bun apps/web/test/ui-follow.ts` (scenarios `same-batch` and `resnapshot`: the newest row ended 2,835px, phone
4,102px, below the view before). Port it into the source diff, with a browser test, when the diff is next regenerated.

Not in it yet, candidates for the next regeneration: the open PRs #11183 (a held turn jitters while its reply streams,
when the content briefly shrinks under an exact-fit spacer) and #12029 (Home/PageUp from the end re-arms follow-output
mid-animation, #12021; a row resizing then pulls the view back, most often a `content-visibility` row, which goblin's
items no longer are).

## Regenerating

```sh
heavy bun scripts/patch-shadcn-react.ts --test
bun install
bun run check:patches
```

The script checks out the base in a temporary directory, applies `message-scroller.diff`, installs with upstream's
pinned pnpm and lockfile, runs upstream's jsdom and browser suites (`--test`), proves the public types are unchanged,
builds the message-scroller entry unminified and self-contained, and writes the patch with a marker line that carries
the hash of `message-scroller.diff`. To change the fix, edit the source in such a checkout, regenerate
`message-scroller.diff` with `git diff 63c1308d -- packages/react/src/message-scroller`, then run the script.

A new `@shadcn/react` version means a new patch: rebase the diff onto that release, drop what upstream merged, update
`VERSION` and `BASE` in the script and the key in `package.json` and `tools/patches.ts`. Until then the version stays
pinned at 0.3.1.
