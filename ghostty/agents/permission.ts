// Answering a permission prompt from outside the session, as the hub's and
// the tray's allow and deny keys do: 1 (Yes) or Esc (No) is pressed in the
// agent's pane only while Claude says it waits and the dialog on screen is
// the row's own tool call, so a key never lands in the input box or answers
// a dialog the row wasn't about.

import { readFileSync } from 'node:fs'
import { basename, join } from 'node:path'

import { isRecord } from '../core/json.ts'
import { type Logger, errorMessage } from '../core/log.ts'
import type { RunResult } from '../core/proc.ts'
import * as text from '../core/text.ts'

// The tool call in an agents.cmd.allow line, without the words round it.
export function permissionTool(cmd: string | null | undefined): string {
  const [before, after = ''] = text.t('agents.cmd.allow').split('{tool}')
  const s = cmd ?? ''
  return s.startsWith(before) && s.endsWith(after) && s.length >= before.length + after.length ? s.slice(before.length, s.length - after.length) : s
}

// The dialog may print a file relative, whole or by its name alone ("make
// this edit to board.ts?"), so only the name counts.
const FILE_TOOLS = new Set(['Read', 'Write', 'Edit', 'NotebookEdit'])
// Enough of the argument to tell one call from another, and short enough
// that it's on screen before the dialog cuts a long command off.
const MARK_CHARS = 24
// How far above its first choice a dialog's tool call can be, in non-blank
// lines, and the rule Claude Code draws across the top of the dialog (or the
// corner of its box), above which is the conversation.
const DIALOG_LINES = 15
const DIALOG_TOP = /^\s*(─{8,}\s*$|╭─)/
const squash = (s: string): string => s.replace(/\s+/g, '')

// What of the tool call its dialog surely shows, without whitespace, as the
// dialog wraps and indents it.
function promptMark(cmd: string): string {
  const call = permissionTool(cmd)
  const mcp = call.match(/^(.+) \(MCP\)$/)
  if (mcp) return squash(mcp[1])
  const m = call.match(/^([^(]+)\((.+)\)$/s)
  if (!m) return squash(call)
  // describeTool cut a long one short with an ellipsis the dialog doesn't have.
  const [, name, arg] = m
  const whole = arg.replace(/…$/, '')
  return squash(FILE_TOOLS.has(name) ? basename(whole) : whole).slice(0, MARK_CHARS)
}

// Only when this dialog is on screen does 1 or Esc answer it: otherwise the
// key lands in Claude's input box, or answers another dialog whose first
// choice is Yes too (a plan, a question, or the next prompt, come since the
// row was read).
export function showsPermission(screen: string, cmd: string): boolean {
  const lines = screen.split('\n').filter(l => l.trim())
  const yes = lines.findLastIndex(l => /❯\s*1\.\s*Yes/.test(l))
  // In the last 15 non-blank lines, so not one scrolled up past output.
  if (yes < 0 || yes < lines.length - 15) return false
  const top = lines.slice(0, yes).findLastIndex(l => DIALOG_TOP.test(l))
  const dialog = lines.slice(Math.max(top + 1, yes - DIALOG_LINES), yes + 1)
  return squash(dialog.join('')).includes(promptMark(cmd))
}

// Whether Claude's session file (<claude dir>/sessions/<pid>.json) says it
// waits on you. One it can't read says no.
export function sessionWaiting(claudeDir: string, a: { id: string; pid: number }, log: Pick<Logger, 'warn'>): boolean {
  const path = join(claudeDir, 'sessions', `${a.pid}.json`)
  try {
    const session: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (isRecord(session)) return session.status === 'waiting'
    log.warn('session file unreadable', { id: a.id, path, err: 'not a session object' })
  } catch (err) {
    log.warn('session file unreadable', { id: a.id, path, err: errorMessage(err) })
  }
  return false
}

type Tabs = (...args: string[]) => Promise<RunResult>

// The pane's screen, and whether the agent's prompt is on it: why not when
// it isn't.
export async function promptShown(tabs: Tabs, pane: string, cmd: string, waiting: boolean): Promise<{ screen: string; why: '' | 'not waiting' | 'no prompt on screen' }> {
  const screen = await tabs('capture-pane', '-p', '-t', pane)
  if (!waiting) return { screen: screen.out, why: 'not waiting' }
  return { screen: screen.out, why: showsPermission(screen.out, cmd) ? '' : 'no prompt on screen' }
}

export const answerKey = (allow: boolean): string => (allow ? '1' : 'Escape')
