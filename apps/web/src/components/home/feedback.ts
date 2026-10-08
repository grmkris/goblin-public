const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches

/** Temporary, inert feedback only; resident App frames are never copied or moved. */
export class HomeFeedback {
  readonly #root: HTMLElement
  readonly #highlights = new Map<string, () => void>()
  readonly #exits = new Set<() => void>()
  constructor(root: HTMLElement) {
    this.#root = root
  }
  highlight(ids: readonly unknown[]): void {
    for (const cancel of this.#highlights.values()) cancel()
    this.#highlights.clear()
    for (const tile of this.#root.querySelectorAll<HTMLElement>('[data-home-tile]')) {
      const id = tile.dataset.homeTile
      if (id === undefined || !ids.includes(id)) continue
      const ring = document.createElement('span')
      ring.className = 'home-tile-locator'
      ring.setAttribute('aria-hidden', 'true')
      tile.appendChild(ring)
      const animation = reduced()
        ? undefined
        : ring.animate([{ opacity: 1 }, { opacity: 0 }], {
            delay: 900,
            duration: 200,
            fill: 'forwards',
          })
      const cancel = () => {
        clearTimeout(timer)
        animation?.cancel()
        ring.remove()
      }
      const timer = setTimeout(() => {
        cancel()
        this.#highlights.delete(id)
      }, 1200)
      this.#highlights.set(id, cancel)
    }
  }
  remove(ids: readonly string[]): void {
    const origin = this.#root.getBoundingClientRect()
    for (const tile of this.#root.querySelectorAll<HTMLElement>('[data-home-tile]')) {
      if (!ids.includes(tile.dataset.homeTile ?? '') || tile.dataset.kind === 'app' || tile.querySelector('iframe'))
        continue
      const ghost = tile.cloneNode(true)
      if (!(ghost instanceof HTMLElement)) continue
      const rect = tile.getBoundingClientRect()
      ghost.removeAttribute('data-home-tile')
      ghost.removeAttribute('id')
      for (const child of ghost.querySelectorAll('[id]')) child.removeAttribute('id')
      ghost.querySelectorAll('.home-tile-locator').forEach((ring) => ring.remove())
      ghost.classList.add('home-tile-exit')
      ghost.inert = true
      ghost.setAttribute('aria-hidden', 'true')
      Object.assign(ghost.style, {
        left: `${rect.left - origin.left}px`,
        top: `${rect.top - origin.top}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`,
        transform: '',
      })
      this.#root.appendChild(ghost)
      const animation = ghost.animate(
        reduced()
          ? [{ opacity: 1 }, { opacity: 0 }]
          : [
              { opacity: 1, scale: 1 },
              { opacity: 0, scale: 0.97 },
            ],
        { duration: 150, easing: 'cubic-bezier(0.23, 1, 0.32, 1)', fill: 'forwards' },
      )
      const cancel = () => {
        clearTimeout(timer)
        animation.cancel()
        ghost.remove()
        this.#exits.delete(cancel)
      }
      const timer = setTimeout(cancel, 180)
      this.#exits.add(cancel)
    }
  }
  dispose(): void {
    for (const cancel of this.#highlights.values()) cancel()
    this.#highlights.clear()
    for (const cancel of this.#exits) cancel()
  }
}
