// Views differ in what their tokenizer splits out on its own:
//
//   paste     bracketed paste as { paste } tokens, not its keys. A paste
//             the terminal splits across reads goes on into the next one,
//             so each tokenizer keeps whether it's inside one
//   ss3       ESC O and a letter (F1–F4 and the arrows in application
//             mode) as one key
//   alt       ESC and the key after it as one key (Alt+key): 'any' key
//             but another ESC, 'letters', 'lowercase' letters, or 'none'
//             (ESC alone, then the key)
//   replies   the cell size (CSI 6;h;w t) as { cell: { ch, cw } } and the
//             DECRQM answer for pixel mouse reports as { pixels }
//   unicode   a character outside the BMP is one key, not two halves
//   release   what a mouse report calls its release: 'up' or 'released'
//
// A sequence never takes in an ESC: Esc pressed just before an arrow or a
// click, read together, is still Esc and then the arrow or the click.
//
// A read's tokens come back all at once, so what the tokenizer carries to
// the next read (a paste going on) is settled whether or not the caller looks
// at them all.

import { StringDecoder } from 'node:string_decoder'

export type Alt = 'any' | 'letters' | 'lowercase' | 'none'
export type Release = 'up' | 'released'
export type TokenizerOptions = {
  paste?: boolean
  ss3?: boolean
  alt?: Alt
  replies?: boolean
  unicode?: boolean
  release?: Release
}

// button carries the wheel, drag and modifier bits; x and y count from 1.
// The release is `up` or `released`, as the tokenizer's option names it.
export type Mouse = { button: number; x: number; y: number; up?: boolean; released?: boolean }
// In pixels: ch high, cw wide.
export type CellSize = { ch: number; cw: number }

// The other fields are there as never, so a view can test t.mouse or t.paste
// on any token and have it narrowed.
type TokenFields = { key: string; paste: string; mouse: Mouse; cell: CellSize; pixels: boolean }
type Only<K extends keyof TokenFields> = Pick<TokenFields, K> & { [O in Exclude<keyof TokenFields, K>]?: never }
export type Token = Only<'key'> | Only<'paste'> | Only<'mouse'> | Only<'cell'> | Only<'pixels'>
// A string is for tests, and callers that still decode each read themselves.
export type Tokenizer = (chunk: string | Uint8Array) => Token[]

// Control keys as the terminal sends them.
export const CTRL_C = '\x03'
export const CTRL_E = '\x05'
export const CTRL_S = '\x13'
export const CTRL_V = '\x16'
// Focus reports (1004): turning them on and off, and the two reports.
export const FOCUS_ON = '\x1b[?1004h'
export const FOCUS_OFF = '\x1b[?1004l'
export const FOCUS_IN = '\x1b[I'
export const FOCUS_OUT = '\x1b[O'

const PASTE_END = '\x1b[201~'

const ALT: Record<Alt, string[]> = { any: ['\\x1b[^\\x1b]?'], letters: ['\\x1b[a-zA-Z]'], lowercase: ['\\x1b[a-z]'], none: [] }

// One pattern for everything a token can be, tried in this order. Sticky, so
// each match starts where the last one ended; [\s\S] last means one always
// does.
function pattern({ paste = false, ss3 = false, alt = 'none', replies = false, unicode = false }: TokenizerOptions): RegExp {
  const parts = [
    ...(paste ? ['(?<paste>\\x1b\\[200~)'] : []),
    '\\x1b\\[<(?<button>\\d+);(?<x>\\d+);(?<y>\\d+)(?<end>[Mm])',
    ...(replies ? ['\\x1b\\[6;(?<ch>\\d+);(?<cw>\\d+)t', '\\x1b\\[\\?1016;(?<mode>\\d)\\$y'] : []),
    '\\x1b\\[[^a-zA-Z~\\x1b]*[a-zA-Z~]',
    ...(ss3 ? ['\\x1bO[a-zA-Z]'] : []),
    ...ALT[alt],
    '[\\s\\S]',
  ]
  return new RegExp(parts.join('|'), unicode ? 'yu' : 'y')
}

function tokenOf(m: RegExpExecArray, release: Release): Token {
  const g = m.groups ?? {}
  if (g.button !== undefined) {
    const at = { button: Number(g.button), x: Number(g.x), y: Number(g.y) }
    const up = g.end === 'm'
    return { mouse: release === 'up' ? { ...at, up } : { ...at, released: up } }
  }
  if (g.ch !== undefined) return { cell: { ch: Number(g.ch), cw: Number(g.cw) } }
  if (g.mode !== undefined) return { pixels: g.mode === '1' || g.mode === '3' }
  return { key: m[0] }
}

// How many of text's last characters could be the start of the paste's end
// marker, held back until the next read shows whether they are.
const endStarts = (text: string): number => {
  for (let n = Math.min(PASTE_END.length - 1, text.length); n > 0; n--) if (PASTE_END.startsWith(text.slice(-n))) return n
  return 0
}

export function tokenizer(opts: TokenizerOptions = {}): Tokenizer {
  const input = pattern(opts)
  const release = opts.release ?? 'up'
  // Inside a paste, and whether it has yielded any of it yet: an empty
  // paste is still one { paste: '' }.
  let pasting = false
  let pasted = false
  let held = ''
  // A long paste comes in several reads, and one can end inside a
  // character: decoding each read alone would make both halves U+FFFD.
  const decoder = new StringDecoder('utf8')
  return chunk => {
    const data = held + (typeof chunk === 'string' ? chunk : decoder.write(chunk))
    held = ''
    const out: Token[] = []
    let at = 0
    while (at < data.length) {
      if (pasting) {
        const end = data.indexOf(PASTE_END, at)
        const stop = end >= 0 ? end : data.length - endStarts(data.slice(at))
        if (stop > at || (end >= 0 && !pasted)) out.push({ paste: data.slice(at, stop) })
        pasted ||= stop > at
        if (end < 0) {
          held = data.slice(stop)
          break
        }
        pasting = false
        at = end + PASTE_END.length
        continue
      }
      input.lastIndex = at
      const m = input.exec(data)
      // Never null: the pattern ends in [\s\S].
      if (!m) break
      at = input.lastIndex
      if (m.groups?.paste !== undefined) [pasting, pasted] = [true, false]
      else out.push(tokenOf(m, release))
    }
    return out
  }
}

// unicode, as the caret counts code points: an emoji typed mid-line as two
// halves would leave the caret one place past it.
export const tokens = tokenizer({ paste: true, ss3: true, alt: 'any', unicode: true })

// Not a release, the wheel (64) or a drag (32). Shift, Alt and Ctrl held with
// it still count.
export const leftPress = ({ button, up, released }: Pick<Mouse, 'button' | 'up' | 'released'>): boolean =>
  !(up || released) && (button & 3) === 0 && (button & 96) === 0
