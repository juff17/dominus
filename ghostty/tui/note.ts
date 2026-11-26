// A footer note that goes by itself: after `ms`, unless a key or a newer
// note has replaced it by then. Call the function it returns after each draw.
export function noteExpiry<N>(get: () => N | null, clear: () => void, redraw: () => void, ms: number): () => void {
  let shown: N | null = null
  let timer: NodeJS.Timeout | undefined
  return () => {
    const note = get()
    if (note === shown) return
    shown = note
    clearTimeout(timer)
    if (!note) return
    timer = setTimeout(() => {
      if (get() !== note) return
      clear()
      redraw()
    }, ms)
  }
}
