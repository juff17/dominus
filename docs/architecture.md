# Agent hub architecture

How the code behind the Ghostty layout, the agent hub, the tray and the viewer
pane is laid out, and where new things go. `docs/ghostty.md` describes what it
does; this page describes how the code is organized. `docs/logging.md` covers
logging.

## Layers

Everything under `ghostty/` is in one of five
layers. A module imports only from its own layer or the layers below it;
`tests/contract/layers.test.mjs` fails on any import that
points up.

| Layer | Folder | What's in it | Imports |
|---|---|---|---|
| 1. core | `core/` | No UI and no app logic: logging, crash logging, paths (and which `claude` to run), running programs (`run`, and `runSync` for a screen that must wait), JSON files (checking, coercing, atomic writes), the tmux servers (`tmux.ts`), gh and glab (`forge.ts`), escape-key codes, pasted images (`images.ts`), the git repos under a folder (`repos.ts`), and every word the screens show (`text.json`) | node only |
| 2. settings | `settings/` | The Settings rows (`rows.ts`), every setting (`catalog.ts`) and the store (`settings.ts`), the model list, keybinds, prompts, the install's `.env` (`env.ts`) | core |
| 3. tui | `tui/` | The terminal kit: palette, rendering, input, screen, line editor, path completion, lists, footers, the controls (radio, select, field, chips, button, confirm, header, frame, card, lane header), the overlay every popup runs in, the app shell | core, settings |
| 4. agents | `agents/` | The model of Claude sessions: agentd and its scan, transcripts, classifying, lanes, launching, the client, answering a permission prompt, starting `claude --bg` (`launch.ts`), and the babysit proposal files (`proposals.ts`) | core, settings, tui (glyphs only) |
| 5. apps | `hub/`, `tray/`, `viewer/` | Programs you see: the hub and rail, the tray command, the viewer modes and popups | everything below; never each other, except through `tray/approvals.ts` and `tray/navigate.ts`, which are libraries |

`bin/` holds the entry scripts tmux, Ghostty and KDE run. Their shared shell
lives in `bin/lib/` (`log.sh`, `core.sh`, `layout.sh`, `tabs.sh`).

## Folders

```
.config/ghostty/
├── bin/                     entry scripts (names are part of layout.conf, the hooks and the widget)
│   └── lib/                 sourced shell: core (node, settings, overlays), layout, tabs, log
├── core/                    log (and warnOnce), crash, paths (and claudeBin), proc (run, pool,
│                            openUrl), json (checks, coercers, writeAtomic, readJsonFile), keys,
│                            tmux (the servers, cell size, a tab's folder), forge (gh and glab:
│                            installed, logged in, one API call),
│                            text (text.json: every word on screen),
│                            images (pasted images: the clipboard, their files, placeholders),
│                            repos (the git repos under a folder),
│                            prompts/ (the hub's sentences to agents: shared.ts holds the
│                            blocks several agents get, then one file per kind of agent)
├── settings/                settings (the store), rows (the kinds of row and their builders),
│                            catalog (every setting: SECTIONS), models, keybinds, prompts,
│                            prefs (New agent's recent folders), env (.env, where tokens live)
├── tui/                     palette (colours), term (rendering spans), input (tokenizer, clicks),
│                            screen (enter, leave, paint, startPane for a view in its own pane,
│                            outside for $EDITOR), note (a footer note that expires),
│                            text (fit, wrap), list (scrolling),
│                            chrome (mode header, key hints), line (the line editor),
│                            complete (path completion for path fields),
│                            controls (the shared radio, select, field, chips, button,
│                            confirm, header, frame, and the hub's card and lane
│                            header, which Tickets draws too), overlay (every popup's frame,
│                            keys and clicks), backdrop (the window behind it, dimmed),
│                            kitty (the graphics protocol), png, gear and gear-art (the
│                            Dominus gear the rail and the empty board draw)
├── agents/                  agentd (the process), tick (one tick), daemon (pid file, sessions,
│                            monitors, reviews, clients), procfs (/proc), tail (following
│                            transcripts), panes (the tmux panes agentd reads),
│                            transcript, classify, board (lanes), launch (and startBg), client, text,
│                            permission (answering a permission prompt, for the hub and the tray),
│                            locate (the read-only claude -p that picks an agent's repo),
│                            stop (stopping one monitor, for the hub and Monitors),
│                            proposals (babysit proposal files: read and run them),
│                            orphans (agentd dropping proposals whose session ended);
│                            model re-exports transcript, classify, board and launch
├── hub/                     hub (entry), view (pure frames), peek (the open session),
│   │                        actions, board (selection), keys
│   ├── newagent/            the New agent form
│   └── rail/                the rail and its drawing
├── tray/                    tray (the command), items, rows (row types), approvals, links,
│                            navigate, permission
└── viewer/                  modes, view, logging, tab (the tab-changed watch), and one folder
    │                        per mode or popup:
    ├── todo/                todo-view (entry), state, draw, effects, todo-ui (keys), todo (store),
    │                        tabs (where an item's agent or tab is)
    ├── diff/                diff-view (entry), effects, diff (parsing), diff-rows (drawing)
    ├── diagrams/            diagram-view (entry), state, draw, effects, diagram (pane file,
    │                        keys)
    ├── approvals/           approvals (state and keys), draw, effects: the approvals panel
    │                        Monitors opens beside Running
    ├── help/                help-view (entry), state, draw, help (the sections)
    ├── settings/            settings-view (entry), state, draw
    ├── tickets/             tickets-view (entry), state, draw, effects: the Alt+J popup;
    │                        tracker (the words any tracker fills), jira (the one adapter:
    │                        reads Jira, never writes); its token is in settings/env's .env
    └── monitors/            monitors-view (entry), state, draw, effects: the Alt+M popup;
                             draw-running and draw-prs (the Running and PRs views), look (their
                             colours), cache (what it keeps between openings),
                             rows (Running's and PRs' rows, and the proposals on each), forge (gh and glab: PRs),
                             checkout (clones), attach (the drawer's options and their records),
                             pipelines (gh and glab: pipelines, and running a gate),
                             pipe-rows, pipe-state, draw-pipes (the Pipelines view),
                             sources (which of Docker, Kubernetes, Elastic it can watch from), logs-state, draw-logs (the Logs form)
```

Inside an app folder a screen splits this way. Todo, Diagrams and Alt+M
have all four parts; Alt+M's Pipelines and Logs views keep their state and
drawing in files of their own (`pipe-state.ts`, `draw-pipes.ts`,
`logs-state.ts`, `draw-logs.ts`), which `state.ts` and `draw.ts` hand the
view to. Help and Settings run no programs, so they have no
`effects.ts`. Diff still draws its frame in its entry. Alt+M's approvals panel
has no entry: its state, drawing and effects (`approvals/approvals.ts`,
`draw.ts`, `effects.ts`) draw into the region Monitors gives them, and
Monitors' own files wire them.

| File | Holds | Tested by |
|---|---|---|
| `<name>.ts` | the entry point: reads the world, wires the shell, nothing else | running it |
| `state.ts` | the state and what each key does to it, pure | unit tests |
| `draw.ts` | `frame(state, size) → lines`, pure | snapshot tests |
| `effects.ts` | what touches the world (tmux, git, files), with the runner passed in | unit tests with a fake runner |

## Words and controls

Every word a screen shows is in `core/text.json`, one part per area (`hub`,
`todo`, `settings`, `help`, `widget`…), and code names it by its path:
`t('newAgent.start')`, `t('settings.ui.lines', { n })`. `{name}` in a string
is filled from the values passed; a string that differs for one and many is
`{ "one": …, "other": … }`. Settings' labels and descriptions are under
`settings.rows` by key, so a setting's code holds only its key, type, values
and default. The Agents widget gets its part through `ghostty-hub tray text`.
Key names, glyphs, colours, stored values and log messages stay in code.

Every radio, select, on/off, checkbox, text field, chip row, button,
question (answered by pressing its key again, `pressAgain`), popup header and rounded frame is drawn by `tui/controls.ts`, so
they look the same on every screen. A control returns spans for `render()`;
a screen that builds strings takes them through `ansi()`.

## Popups

Every popup is an overlay, built on `tui/overlay.ts`: Help (Alt+H),
Settings (Alt+S), Todo (Alt+T), Monitors (Alt+M,
and Alt+A, which opens it on its approvals panel), Tickets (Alt+J), New agent (Alt+N) and the
Diagrams window (Alt+D). Each is a rounded frame in the middle of the
screen, its title and the key that closes it in the top edge, over the
window it opened from, dimmed. A change to how popups look or close is made
there once.

- **Opening.** `bin/lib/core.sh`'s `overlay` opens a tmux popup over the
  whole window with no border (`display-popup -B -w 100% -h 100%`) and
  passes the window's id as `OV_UNDER`. The hub opens New agent the same way
  (`hub/actions.ts`). Diagrams is a tmux window instead, since tmux drops the
  passthrough its pictures need from a popup, but it draws the same frame.
- **Drawing.** tmux can't dim behind a popup, so the overlay captures the
  window's text as it opens (`tui/backdrop.ts`) and draws it dimmed round the
  frame. tmux doesn't redraw the panes behind a popup anyway, so a snapshot
  loses nothing. Node takes about 150ms to load a view, and the popup would
  sit blank over the whole window until then, so `core.sh`'s
  `paint_backdrop` draws the same dimmed window from the shell first: from
  `run_panel`, and from `bin/ghostty-backdrop` for New agent and Diagrams.
  The popup's own background is the dimmed one (crust) for the moment before
  it. A view's `draw.ts` draws only what's inside the frame, at
  the size it's given, and names the title. Its `\e[nG` column moves count
  from the frame's inside.
- **Size.** Each entry gives the frame's size in cells or percent: Settings'
  `layout.helpPercent`, `settingsPercent`, `todoWidth` and `todoHeight`,
  `layout.diagramsPercent`, 70% × 85% for Approvals, 90% × 85% for Monitors and Tickets, the form's size for
  New agent, and the tab list's height for the picker. A screen under 70 × 20
  gets the whole of it.
- **Closing.** Inside a popup tmux's own bindings don't apply, so the
  overlay reads its own key (wherever Settings › Keybinds put it) and Ctrl+C
  as close. A view says when they may not (`mayClose`): while Settings
  captures a key or takes a path, while Approvals edits a reply, and Ctrl+C
  while Todo has a prompt open. A click outside the frame or on its close
  hint closes it too. Esc and q are each view's to decide.
- **The entry.** `openOverlay({ name, key, box })` gives `size()`,
  `paint(lines, title)`, `mouse(m)` (the click inside the frame, or
  `'close'`), `closes(key)`, `start(onData, draw)` (raw keys, resize, signals)
  and `quit()`. `viewer/help/help-view.ts` is the shortest to copy.

## TypeScript

The code is TypeScript that Node runs as it is: Node strips the types and
runs the file, with no build step and nothing in `node_modules` at run time.
`tsc` only checks it (`npm install` once, then `npm run typecheck`; CI and
pre-commit run it too). The settings are in `tsconfig.json`, with `strict` on.

- **Only syntax Node can strip:** no `enum`, `namespace`, constructor
  parameter properties or `import x = require()`; `erasableSyntaxOnly`
  rejects them. For a fixed set of values, use a union of string literals,
  or an `as const` object and `(typeof X)[keyof typeof X]`.
- **Imports name the file:** `from './board.ts'`. A type-only import is
  `import type { Lane } from './board.ts'`, which `verbatimModuleSyntax`
  enforces, since Node can't tell otherwise that it's erased.
- **A type lives with the code that owns the data:** `agents/board.ts`
  exports `Lane`, `tui/term.ts` exports `Span`, and others import them from
  there. There is no catch-all types file.
- **Options are a named type:** a function taking `{ a, b = 1 } = {}` gets
  a `type FooOptions = { a?: string; b?: number }` beside it, so a caller
  passing a field the function doesn't read is an error.
- **No `any` in the app code:** what comes from outside (JSON, files, tmux
  and git output, argv) is `unknown` until it's checked, by the function that
  reads it. Tests may cast a partial fake with `as`.
- **`// @ts-nocheck`** at the top marks a file not converted yet. Remove it
  when you type the file; don't add it to a new one.

## Extending

- **A string:** a key in `core/text.json` under its area, named for what it
  means; `t()` it from the code. The text contract test fails on a path the
  code names that the file doesn't have.
- **A control:** an export in `tui/controls.ts` with a test beside it,
  when a second screen needs the same thing drawn.

- **A viewer mode:** a folder under `viewer/` with the four files above, and
  an entry in `viewer/modes.ts`'s list. Settings › Workspace and the mode
  header pick it up from there.
- **A setting:** a row in `settings/catalog.ts`'s SECTIONS, in the
  section it belongs to. The store validates it, the Settings panel draws it, and the
  settings-parity contract test checks any Python reader of the same key.
- **A model:** a row in `settings/models.ts`. New agent, Settings, the todo
  hand-off and (with `filer`) the todo filer offer it from there; a test
  fails if any other source file lists model names.
- **A tray item kind:** its row type in `tray/rows.ts`, a row builder in
  `tray/items.ts`; its buttons' actions in `tray/tray.ts`'s `ACTS` table;
  its glyph and colour in `tui/palette.ts`, which the tray's `palette.js` must match
  (contract test).
- **The theme colour:** `ACCENT` (and `ACCENT_INK`, the text on it) in
  `tui/palette.ts`. Focus, selection, titles, frames, buttons and keys use
  it, never a hue from `P`; the state colours (`STATE`, `MONITOR`) stay
  their own. The copies outside TypeScript are tmux's `@accent` in
  `theme.conf`, yazi's `init.lua` and `theme.toml`, the tray's `palette.js`,
  and Ghostty's colours in `config.ghostty`; the colours contract test holds
  each to the palette.
- **A tracker:** an adapter beside `viewer/tickets/jira.ts` that fills
  `tracker.ts`'s types, a value of `tickets.provider`, and a reference file
  for the ticket-work skill (`hub-plugin/skills/ticket-work/references/`).
  The popup, the hand-off and the skill read only the neutral types.
- **A babysit proposal kind:** a kind in pr-babysit's `approval.py`, and
  a row in `tray/approvals.ts`'s `APPROVE` table. `ProposalKind` is that
  table's keys, so tsc then points at each other table (`GLYPH`, `DETAIL`,
  `OWN_ACTIONS`) that needs a row for it. Its body goes in
  `viewer/approvals/draw.ts`. The
  approvals contract test runs `approval.py` and reads its output in Node.

## Tests

| Where | What | Run |
|---|---|---|
| next to each module, `*.test.ts` (and in `install/walkthrough/`) | unit tests | `./test.sh ghostty` |
| `tests/contract/` | files different parts must agree on: keys, colours, settings keys, log format, layers, text paths; and `install.sh` against stub sudo, apt, snap and claude | `./test.sh contract` |
| `hub-plugin/tests/` | the hub's skill scripts and `agent_hub`, with fake `gh`, `glab`, `kubectl` and `docker` | `./test.sh hub` |
