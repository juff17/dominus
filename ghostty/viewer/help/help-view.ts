#!/usr/bin/env node
// Alt+H's keys overlay, run by bin/ghostty-help.
//   help-view.ts [place]   the tmux window Alt+H was pressed in (work, hub,
//                           diagrams), which picks the section it opens on
//
// This file wires the keys and the terminal; state.ts holds the state and
// what keys do, draw.ts draws it.

import { logger } from '../../core/log.ts'
import { KEY_ROWS } from '../../settings/keybinds.ts'
import { load } from '../../settings/settings.ts'
import { openOverlay } from '../../tui/overlay.ts'
import { tokens } from '../../tui/term.ts'
import { logCrashes } from '../logging.ts'
import { bodyRows, frame } from './draw.ts'
import { rebind } from './help.ts'
import { onKey, onMouse, onPaste, start } from './state.ts'

logCrashes(logger('help'))

rebind(load(), KEY_ROWS)
const s = start(process.argv[2])

const ov = openOverlay({
  name: 'help',
  key: 'keys.help',
  box: () => {
    const share = `${load()['layout.helpPercent']}%` as const
    return { w: share, h: share }
  },
})

function draw() {
  const f = frame(s, ov.size())
  s.scroll = f.scroll
  s.maxScroll = f.maxScroll
  ov.paint(f.lines, f.title)
}

ov.start(data => {
  for (const tok of tokens(data)) {
    if (tok.paste !== undefined) onPaste(s, tok.paste)
    else if (tok.mouse) {
      const m = ov.mouse(tok.mouse)
      if (m === 'close') return ov.quit()
      if (m) onMouse(s, m, bodyRows(ov.size().rows))
    } else if (ov.closes(tok.key ?? '') || onKey(s, tok.key ?? '', Math.max(1, Math.floor(bodyRows(ov.size().rows) / 2)))) ov.quit()
  }
  draw()
}, draw)
