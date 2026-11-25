// The walkthrough's four pages, one question each, asked through Inquirer's
// prompts (passed in, so a test can answer them): the optional parts, the
// editor, restarting stopped agents, and the default folder. Each page
// clears the screen and says where you are.

export type Separator = { readonly separator: string; readonly type: string }
export type CheckChoice<V> = { value: V; name: string; description?: string; checked?: boolean; disabled?: string | boolean }
export type SelectChoice<V> = { value: V; name: string; description?: string }

// The subset of @inquirer/prompts the pages use.
export type Prompts = {
  checkbox: <V>(c: { message: string; choices: (CheckChoice<V> | Separator)[] }) => Promise<V[]>
  select: <V>(c: { message: string; choices: SelectChoice<V>[]; default?: V }) => Promise<V>
  confirm: (c: { message: string; default: boolean }) => Promise<boolean>
  input: (c: { message: string; default: string }) => Promise<string>
  separator: (text: string) => Separator
}

export type Screen = {
  // Clears the terminal and draws the page header (and any grey lines under it).
  page: (n: number, of: number, notes?: string[]) => void
}

export type Current = {
  header: boolean
  sidePanel: boolean
  widget: boolean
  editor: string
  editors: SelectChoice<string>[]
  restartStopped: boolean
  // The default folder as saved; '' is the hub's own default.
  folder: string
  // New agent, todo hand-offs and tickets run in Claude Code's sandbox.
  sandbox: boolean
}

export type Picked = Omit<Current, 'editors'>

export const PAGES = 5
export const DEFAULT_FOLDER = '~/projects'

const ALWAYS = [
  'Always installed: Agent Hub (the hub, its rail, the tray and agentd, in Ghostty with tmux)',
  'and the skills it runs on: pr-babysit, pipeline-watch, log-watcher, todo.',
]

export async function runPages(ask: Prompts, screen: Screen, now: Current, plasma6: boolean): Promise<Picked> {
  screen.page(1, PAGES, ALWAYS)
  const parts = await ask.checkbox<'header' | 'sidePanel' | 'widget'>({
    message: 'Optional parts',
    choices: [
      ask.separator('── Workspace ──'),
      {
        value: 'header',
        name: 'Header: btop',
        checked: now.header,
        description: 'btop across the top of every window, showing CPU use, so you can see when agents are busy. Without it, your tabs take the full height.',
      },
      {
        value: 'sidePanel',
        name: 'Side panel: files, diagrams, diff, todo',
        checked: now.sidePanel,
        description: 'A panel on the left that Alt+V shows and hides: Files (yazi, with previews), the Diagrams Claude draws, a Diff of your changes, and your Todo list.',
      },
      ask.separator('── Desktop ──'),
      plasma6
        ? { value: 'widget', name: 'KDE panel widget', checked: now.widget, description: 'An Agents panel widget for KDE Plasma that raises what needs you.' }
        : { value: 'widget', name: 'KDE panel widget', disabled: '(skipped: needs KDE Plasma 6)' },
    ],
  })

  screen.page(2, PAGES)
  const editor = await ask.select({ message: 'Editor that Alt+E opens', choices: now.editors, default: now.editor })

  screen.page(3, PAGES, ['Background agents left with no process, as after a reboot: restarted once each per login.'])
  const restartStopped = await ask.confirm({ message: 'Restart stopped background agents after a reboot?', default: now.restartStopped })

  screen.page(4, PAGES, ['Where an agent starts when nothing names a folder: New agent, Logs, a todo with no repo.'])
  const typed = (await ask.input({ message: 'Default folder for new agents', default: now.folder || DEFAULT_FOLDER })).trim()

  screen.page(5, PAGES, [
    'Agents from New agent, todo hand-offs and tickets work without asking you, so they can run in',
    "Claude Code's sandbox: their shell commands write only in their own folder, can't read your keys",
    'or .env files, and reach the network through a proxy. Installs bubblewrap and socat. Monitors never',
    'run in it. Settings › New agent, Todo and Tickets can each turn it off later.',
  ])
  const sandbox = await ask.confirm({ message: 'Run the agents the hub starts in the sandbox?', default: now.sandbox })

  return {
    header: parts.includes('header'),
    sidePanel: parts.includes('sidePanel'),
    widget: plasma6 && parts.includes('widget'),
    editor,
    restartStopped,
    sandbox,
    // The hub's own default stays unset, so a later change to it applies.
    folder: !typed || (typed === DEFAULT_FOLDER && !now.folder) ? now.folder : typed,
  }
}
