import type { AppView } from '@goblin/contracts'
import { withPendingApps } from './slices.ts'

/** Whether the feed shows `app` as a change left it: listed, and open or closed alike. */
const agrees = (told: AppView | undefined, app: AppView): boolean =>
  told !== undefined && (told.closedAt === undefined) === (app.closedAt === undefined)

/**
 * One App change of the owner's (keep, close, reopen): what it shows, while its call is on its way and, once the
 * server answered, until the feed agrees.
 */
export class AppChange {
  #shown: AppView
  #answered = false

  constructor(shown: AppView) {
    this.#shown = shown
  }

  get shown(): AppView {
    return this.#shown
  }

  get answered(): boolean {
    return this.#answered
  }

  answer(app: AppView): void {
    this.#shown = app
    this.#answered = true
  }
}

/**
 * The App changes the feed has not caught up with, oldest first, shown over the feed's Apps so that nothing it sends
 * meanwhile (a change about something else, a change to the App the server made before this one, a reconnect's
 * snapshot taken while the call was on its way) shows the App as it was. A change ends when the feed agrees with
 * its answer, or removes its App; a refused one ends at once and the feed's App shows again.
 */
export class PendingApps {
  #changes: readonly AppChange[] = []

  /** A change on its way, shown as `shown` until it is answered or refused. */
  start(shown: AppView): AppChange {
    const change = new AppChange(shown)
    this.#changes = [...this.#changes, change]
    return change
  }

  /** The server answered with `app`: shown until the feed (`feed`, its Apps now) agrees, which it may already. */
  answered(app: AppView, feed: readonly AppView[], change?: AppChange): void {
    const answered = change ?? this.start(app)
    answered.answer(app)
    if (
      agrees(
        feed.find(({ id }) => id === app.id),
        app,
      )
    )
      this.#drop(answered)
  }

  /** The server refused the change: the feed's App shows again. */
  refused(change: AppChange): void {
    this.#drop(change)
  }

  /**
   * What the feed now says about the Apps (`feed`): an answered change it agrees with ends, and so does one whose App
   * it no longer lists and has removed (`gone`).
   */
  heard(feed: readonly AppView[], gone: (id: string) => boolean): void {
    const told = new Map(feed.map((app) => [app.id, app]))
    this.#changes = this.#changes.filter(({ answered, shown }) => {
      if (!answered) return true
      const app = told.get(shown.id)
      return app === undefined ? !gone(shown.id) : !agrees(app, shown)
    })
  }

  /** `feed` with every change still pending shown over it, the latest last; the same value when there is none. */
  over(feed: readonly AppView[]): readonly AppView[] {
    return withPendingApps(
      feed,
      this.#changes.map(({ shown }) => shown),
    )
  }

  #drop(change: AppChange): void {
    this.#changes = this.#changes.filter((each) => each !== change)
  }
}
