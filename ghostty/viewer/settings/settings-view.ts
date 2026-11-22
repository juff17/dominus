#!/usr/bin/env node
// The rail's ⚙ settings panel, in an overlay (bin/ghostty-settings) sized by
// layout.settingsPercent. Every change is saved as it's made.
//   settings-view.ts [section id]   the section it opens on
//
// This file wires the keys and the terminal; state.ts holds the state and
// what keys do, draw.ts draws it.

import { logger } from '../../core/log.ts'
import { load } from '../../settings/settings.ts'
import { openOverlay } from '../../tui/overlay.ts'
import { tokens } from '../../tui/term.ts'
import { logCrashes } from '../logging.ts'
import { frame } from './draw.ts'
import { follow, mayClose, onKey, start, typeText } from './state.ts'

logCrashes(logger('settings-panel'))

const s = start(process.argv[2])

const ov = openOverlay({
  name: 'settings-panel',
  key: 'keys.settings',
  box: () => {
    const share = `${load()['layout.settingsPercent']}%` as const
    return { w: share, h: share }
  },
})

function draw() {
  // A resize draws with no key first, and the file may have changed since.
  follow(s)
  const f = frame(s, ov.size())
  s.scroll = f.scroll
  ov.paint(f.lines, f.title)
}

ov.start(data => {
  for (const tok of tokens(data)) {
    if (tok.paste !== undefined) typeText(s, tok.paste)
    else if (tok.mouse) {
      if (ov.mouse(tok.mouse) === 'close') ov.quit()
    } else if (tok.key && ((mayClose(s) && ov.closes(tok.key)) || onKey(s, tok.key) === 'quit')) ov.quit()
  }
  draw()
}, draw)
