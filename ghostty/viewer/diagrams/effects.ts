// What dv reads from and writes to the world. tmux comes in through `io`, so
// tests can hand it a fake. dv reads before it goes on, so its runs are
// synchronous.

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'

import { errorMessage, logger } from '../../core/log.ts'
import type { SyncRunner } from '../../core/proc.ts'
import { t } from '../../core/text.ts'
import { failing } from '../logging.ts'
import { captureWindow } from '../../tui/backdrop.ts'
import { type PaneState, diagramKey, dropTab, jobFile, newestPane, paneFile, paneState, reread, tabTitle } from './diagram.ts'
import { type DiagramState, type Size, diagram, select } from './state.ts'

const log = logger('diagrams')

export type DiagramsIo = { run: SyncRunner; schedule: () => void; say: (text: string) => void }

export type DiagramEffects = {
  readCell: () => void
  readState: () => void
  captureBackdrop: (size: Size) => void
  closeTab: (i: number) => void
}

type Source = { file: string; title: string; gone: boolean }
const GONE: Source = { file: '', title: '', gone: true }

const noPanes = (): PaneState => ({ diagrams: [], current: 0 })

export function diagramEffects(s: DiagramState, io: DiagramsIo): DiagramEffects {
  const { config: c } = s
  // The followed tab is read on every change event: its failure is logged as it starts.
  const reads = failing(log)
  const tmux = (args: string[]) => io.run(['tmux', ...args])

  // tmux may not answer the cell size query, but it knows the size itself.
  function readCell(): void {
    if (!process.env.TMUX) return
    const r = tmux(['display', '-p', '#{client_cell_width} #{client_cell_height}'])
    // An older tmux without the formats; the size query or the default stands.
    if (!r.ok) {
      log.warn('cell size unread', { exit: r.exit, err: r.err })
      return
    }
    const [cw, ch] = r.out.trim().split(' ').map(Number)
    if (cw && ch) s.cell = { cw, ch }
  }

  function source(): Source {
    if (!c.follows) return { file: newestPane(c.panes), title: '', gone: false }
    if (c.job) return { file: jobFile(c.panes, c.job), title: c.jobTitle, gone: false }
    const [socket, target] = c.pinPane ? [c.pinSocket, c.pinPane] : [c.tabsSocket, `${c.tabsSession}:`]
    const r = tmux(['-L', socket, 'display', '-p', '-t', target, '#{pane_id}\t#{b:pane_current_path}\t#{window_index}\t#{window_name}'])
    if (!r.ok) {
      reads.failed('tab', 'followed tab unreadable', { cmd: ['tmux', '-L', socket, 'display', '-t', target], exit: r.exit, err: r.err })
      return GONE
    }
    reads.ok('tab')
    const [pane = '', dir = '', tab = '', name = ''] = r.out.trim().split('\t')
    if (!pane) return GONE
    return { file: paneFile(c.panes, socket, pane), title: tabTitle(dir, tab, name), gone: false }
  }

  function readPaneFile(path: string): PaneState | undefined {
    try {
      const list = paneState(JSON.parse(readFileSync(path, 'utf8')))
      if (!list) log.warn('pane file unreadable', { path, err: 'not a pane file' })
      return list
    } catch (err) {
      // Read while Claude Code was still writing it; the next change event reads it whole.
      log.warn('pane file unreadable', { path, err: errorMessage(err) })
      return undefined
    }
  }

  function readState(): void {
    const from = source()
    s.paneFile = from.file
    s.tabTitle = from.title
    s.gone = from.gone
    if (!s.paneFile || !existsSync(s.paneFile)) {
      const had = s.list.diagrams.length > 0
      s.list = noPanes()
      s.stateFile = ''
      if (had) select(s, 0)
      io.schedule()
      return
    }
    const next = readPaneFile(s.paneFile)
    if (!next) {
      // The list read last is another tab's: shown under this tab's title, a
      // close would write it into this tab's file. None shows until this
      // file reads whole, and that read still counts as the switch.
      if (s.paneFile !== s.stateFile) {
        s.list = noPanes()
        s.stateFile = ''
        select(s, 0)
      }
      io.schedule()
      return
    }
    const to = reread(s.list, next, s.index, s.paneFile !== s.stateFile)
    s.list = next
    s.stateFile = s.paneFile
    if (to !== undefined) select(s, to)
    io.schedule()
  }

  // When tmux can't say, as when the window closed meanwhile, the frame sits
  // on a blank screen.
  function captureBackdrop(size: Size): void {
    if (!c.frame) return
    s.backdrop = captureWindow(c.under, size.cols, size.rows, io.run, why => log.warn('backdrop not captured', { id: c.under, ...why }))
  }

  // The mod reads the pane file before its next change. It's written whole
  // and renamed in, so neither side reads half a file. It's read again first
  // and the diagram dropped by its key: the mod may have rewritten it since
  // dv's last read (whose change event is still waiting), and writing dv's
  // list back would take away a diagram it just added. A file the mod removed
  // as its session ended stays removed.
  function closeTab(i: number): void {
    const closing = s.list.diagrams[i]
    if (!s.paneFile || !closing || s.stateFile !== s.paneFile) return
    const { title } = closing
    const fresh = readPaneFile(s.paneFile)
    const at = fresh ? fresh.diagrams.findIndex(d => diagramKey(d) === diagramKey(closing)) : -1
    if (!fresh || at < 0) {
      log.warn('diagram not closed', { path: s.paneFile, index: i, title, err: fresh ? 'gone from the pane file' : 'pane file unreadable' })
      return
    }
    const showing = diagram(s)
    const index = showing ? fresh.diagrams.findIndex(d => diagramKey(d) === diagramKey(showing)) : -1
    const next = dropTab(fresh, at, index < 0 ? at : index)
    try {
      writeFileSync(`${s.paneFile}.tmp`, JSON.stringify(next))
      renameSync(`${s.paneFile}.tmp`, s.paneFile)
    } catch (err) {
      log.error('pane file not written', { path: s.paneFile, index: i, err: errorMessage(err), stack: err instanceof Error ? err.stack : undefined })
      const code = err instanceof Error && 'code' in err && typeof err.code === 'string' ? err.code : undefined
      io.say(t('diagrams.notClosed', { title, err: code ?? errorMessage(err) }))
      return
    }
    s.list = next
    log.info('diagram closed', { path: s.paneFile, index: i, title })
    select(s, next.current)
    io.schedule()
  }

  return { readCell, readState, captureBackdrop, closeTab }
}
