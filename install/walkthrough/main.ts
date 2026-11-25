// install.sh's walkthrough. Asks what to set up (pages.ts; once, then only
// with --reconfigure), saves the answers, works out what's missing
// (probe.ts, plan.ts), shows it the way apt does, and asks before anything is
// installed. It installs nothing itself: approved, it writes the plan to the
// --plan file for install.sh to carry out.
//
//   node main.ts --plan <file> [--reconfigure] [--yes] [--links]
//     --reconfigure  ask every page again
//     --yes          approve the review without asking (no terminal needed)
//     --links        no pages, no review: only what install.sh needs to link
//
// Exit codes: 0 go ahead (the plan file is written), 10 not approved, 130
// stopped with Ctrl+C (nothing saved), 1 something failed.

import { writeFileSync } from 'node:fs'

import { checkbox, confirm, input, select, Separator } from '@inquirer/prompts'

import { errorMessage, logger } from '../../ghostty/core/log.ts'
import { ACCENT, BOLD, fg, P } from '../../ghostty/tui/palette.ts'
import { load, row, set } from '../../ghostty/settings/settings.ts'
import { type Answers, loadAnswers, saveAnswers } from './answers.ts'
import { type Current, type Picked, type Prompts, runPages } from './pages.ts'
import { type Line, nothingToInstall, packagesFor, planFile, planOf, reviewLines } from './plan.ts'
import { plasma6, probe } from './probe.ts'

const log = logger('install')
const RESET = '\x1b[0m'
const c = (hex: string, s: string): string => `${fg(hex)}${s}\x1b[39m`

// The hub's palette (tui/palette.ts), in the theme colour.
const theme = {
  prefix: { idle: c(ACCENT, '?'), done: c(P.green, '✔') },
  icon: { checked: c(ACCENT, '◉'), unchecked: c(P.overlay2, '◯'), cursor: c(ACCENT, '❯') },
  style: {
    highlight: (s: string) => c(ACCENT, s),
    description: (s: string) => c(P.sub, s),
    disabled: (s: string) => c(P.overlay2, s),
    answer: (s: string) => c(ACCENT, s),
    keysHelpTip: (keys: [string, string][]) =>
      keys.map(([key, action]) => `${BOLD}${key}${RESET} ${c(P.overlay2, action)}`).join(c(P.overlay2, ' • ')),
  },
}

const prompts: Prompts = {
  checkbox: c => checkbox({ ...c, theme }),
  select: c => select({ ...c, theme }),
  confirm: c => confirm({ ...c, theme }),
  input: c => input({ ...c, theme }),
  separator: text => new Separator(c(P.overlay2, text)),
}

const tty = process.stdin.isTTY && process.stdout.isTTY
const out = (s = '') => process.stdout.write(`${s}\n`)

const screen = {
  page(n: number, of: number, notes: string[] = []) {
    if (tty) process.stdout.write('\x1b[2J\x1b[H')
    out(c(P.overlay2, `dominus setup  ·  page ${n} of ${of}`))
    for (const note of notes) out(c(P.sub, note))
    out()
  },
}

function current(saved: Answers, desktop: boolean): Current {
  const s = load()
  return {
    header: s['layout.header'],
    sidePanel: s['layout.sidePanel'],
    widget: desktop && (saved.widget ?? true),
    editor: s['editor.app'],
    editors: row('editor.app').choices.map(ch => ({ value: ch.value, name: ch.label, description: `runs ${ch.value}; it has to be on PATH` })),
    restartStopped: s['hub.restartStopped'],
    folder: s['general.folder'],
    sandbox: SANDBOXED.some(k => s[k]),
  }
}

// The settings the sandbox question sets.
const SANDBOXED = ['newAgent.task.sandbox', 'todo.handoff.sandbox', 'tickets.handoff.sandbox'] as const

// Only what changed, so a setting left alone keeps following its default.
function savePicked(now: Current, picked: Picked): void {
  const changes: [string, unknown, unknown][] = [
    ['layout.header', now.header, picked.header],
    ['layout.sidePanel', now.sidePanel, picked.sidePanel],
    ['editor.app', now.editor, picked.editor],
    ['hub.restartStopped', now.restartStopped, picked.restartStopped],
    ['general.folder', now.folder, picked.folder],
    // One answer for all three: each can differ later, in Settings.
    ...SANDBOXED.map((k): [string, unknown, unknown] => [k, now.sandbox, picked.sandbox]),
  ]
  for (const [key, before, after] of changes) if (before !== after) set(key as never, after as never)
}

function draw(line: Line): string {
  const parts = [line.tone === 'head' ? `${BOLD}${line.text}${RESET}` : line.tone === 'dim' ? c(P.overlay2, line.text) : line.text]
  if (line.dim) parts.push(c(P.overlay2, line.dim))
  if (line.size) parts.push(c(P.sub, line.size))
  return parts.join('  ')
}

async function main(argv: string[]): Promise<number> {
  const flag = (name: string) => argv.includes(name)
  const at = argv.indexOf('--plan')
  const planPath = at >= 0 ? argv[at + 1] : undefined
  if (!planPath) {
    process.stderr.write('usage: main.ts --plan <file> [--reconfigure] [--yes] [--links]\n')
    return 1
  }
  const saved = loadAnswers()
  const desktop = plasma6()
  const now = current(saved, desktop)
  let picked: Picked = { ...now }
  if (!flag('--links') && tty && (flag('--reconfigure') || !saved.asked)) {
    picked = await runPages(prompts, screen, now, desktop)
    savePicked(now, picked)
    saveAnswers({ asked: true, widget: picked.widget })
    log.info('answers saved', { header: picked.header, sidePanel: picked.sidePanel, widget: picked.widget, editor: picked.editor, sandbox: picked.sandbox })
  }

  const choices = { header: picked.header, sidePanel: picked.sidePanel, widget: picked.widget, sandbox: picked.sandbox }
  if (flag('--links')) {
    writeFileSync(planPath, planFile({ apt: [], byHand: [], yazi: false, claude: false, plugin: false, diagrams: false, chromeByHand: false, widget: choices.widget }))
    return 0
  }
  const found = probe(packagesFor(choices))
  const plan = planOf(choices, found)
  if (tty) process.stdout.write('\x1b[2J\x1b[H')
  out(c(P.overlay2, 'dominus setup  ·  review'))
  out()
  if (nothingToInstall(plan)) {
    out('Nothing to install: everything is already here. Linking only.')
  } else {
    for (const line of reviewLines(plan, found)) out(draw(line))
    out()
    const yes = flag('--yes') || (tty && (await confirm({ message: 'Install these?', default: true, theme })))
    if (!yes) {
      out(tty ? 'Nothing installed. Your answers are saved; ./install.sh comes back to this review.' : 'Run ./install.sh in a terminal to approve this, or pass --yes.')
      log.info('install declined', { apt: plan.apt, yazi: plan.yazi, claude: plan.claude, plugin: plan.plugin, diagrams: plan.diagrams })
      return 10
    }
  }
  writeFileSync(planPath, planFile(plan))
  log.info('install approved', { apt: plan.apt, yazi: plan.yazi, claude: plan.claude, plugin: plan.plugin, diagrams: plan.diagrams, widget: plan.widget })
  return 0
}

try {
  process.exitCode = await main(process.argv.slice(2))
} catch (err) {
  if (err instanceof Error && err.name === 'ExitPromptError') {
    out('\nStopped; nothing saved.')
    process.exitCode = 130
  } else {
    log.error('walkthrough failed', { err: errorMessage(err), stack: err instanceof Error ? err.stack : undefined })
    process.stderr.write(`install walkthrough failed: ${errorMessage(err)}\n`)
    process.exitCode = 1
  }
}
