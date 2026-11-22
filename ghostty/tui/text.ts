// Widths are in terminal cells: a CJK character or an emoji takes two.

import { head } from './line.ts'
import { width as cells } from './term.ts'

export const tidy = (text: unknown): string => String(text).replace(/\t/g, '  ').replace(/[\x00-\x1f\x7f]/g, '')

// Exactly w cells: padded, or cut with an ellipsis. A wide character that
// would straddle the edge goes, and a space fills its place.
export const fit = (text: unknown, w: number): string => {
  const clean = tidy(text)
  if (cells(clean) <= w) return clean + ' '.repeat(w - cells(clean))
  const cut = head(clean, Math.max(0, w - 1))
  return `${cut}…${' '.repeat(Math.max(0, w - 1 - cells(cut)))}`
}

export const wrapText = (text: unknown, w: number): string[] =>
  String(text)
    .split('\n')
    .flatMap(para => {
      const lines: string[] = []
      let line = ''
      for (const word of tidy(para).split(' ')) {
        if (line && cells(line) + 1 + cells(word) > w) {
          lines.push(line)
          line = word
        } else line = line ? `${line} ${word}` : word
        // At least one character a line, so a wide one in a narrow column
        // can't stall it.
        while (cells(line) > w && [...line].length > 1) {
          const cut = head(line, w) || [...line][0]
          lines.push(cut)
          line = line.slice(cut.length)
        }
      }
      return [...lines, line]
    })

export const visible = (text: string): number => cells(text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ''))
