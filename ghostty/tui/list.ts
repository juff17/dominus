export const clampScroll = (scroll: number, count: number, height: number): number => Math.max(0, Math.min(scroll, Math.max(0, count - height)))

// Moves as little as it can; the first row wins when first..last doesn't fit.
export function keepInView(scroll: number, first: number, last: number, height: number): number {
  if (last >= scroll + height) scroll = last - height + 1
  if (first < scroll) scroll = first
  return scroll
}
