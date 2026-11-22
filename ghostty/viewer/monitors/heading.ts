// The title over a group of rows, and the rule under a column header: a rule
// to the list's edge so neither reads as another row. Running and Pipelines
// share it so their groups look the same.

import { spanWidth } from '../../tui/controls.ts'
import { P, type Span, bg, fg, render } from '../../tui/term.ts'

const BASE = bg(P.base)
const RULE = fg(P.surface1)

export function heading(head: readonly Span[], w: number): string {
  const lead: Span[] = [['  '], ...head, [' ']]
  return render([...lead, ['─'.repeat(Math.max(0, w - 1 - spanWidth(lead))), RULE]], w, BASE)
}

export const rule = (w: number): string => render([['  '], ['─'.repeat(Math.max(0, w - 3)), RULE]], w, BASE)
