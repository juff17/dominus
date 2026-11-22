// Its own file because draw-pipes.ts uses it too, and draw.ts imports
// draw-pipes.ts.

import { BOLD, P, type Span, fg } from '../../tui/term.ts'

const LIT = BOLD + fg(P.yellow)

// `hits` are code point indexes (rows.ts hitsIn).
export function lit(text: string, hits: readonly number[], style: string): Span[] {
  if (!hits.length) return [[text, style]]
  const on = new Set(hits)
  const out: Span[] = []
  let run = ''
  let runLit = false
  let i = 0
  for (const ch of text) {
    const l = on.has(i++)
    if (run && l !== runLit) {
      out.push([run, runLit ? LIT : style])
      run = ''
    }
    run += ch
    runLit = l
  }
  if (run) out.push([run, runLit ? LIT : style])
  return out
}
