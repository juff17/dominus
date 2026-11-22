# Dominus

A home for your Claude Code agents. A Ghostty + tmux layout keeps a hub of
every running session (what each one is doing, what needs you, the monitors
they armed) beside your terminal tabs. A Plasma panel widget raises what
needs you, and a viewer pane holds files, diffs, diagrams and a todo list.
It also carries what the hub needs from Claude Code, as one plugin: its skills
and hooks.

## Layout

| Folder | What's in it | Installed to |
|---|---|---|
| [`ghostty/`](ghostty) | the layout's config, and the hub, rail, tray, viewer and `agentd` (Node.js); see [`docs/architecture.md`](docs/architecture.md) | `~/.config/ghostty/`, file by file |
| [`plasmoid/`](plasmoid) | the Agents panel widget (QML) | `~/.local/share/plasma/plasmoids/`, as one folder |
| [`hub-plugin/`](hub-plugin) | the `dominus` Claude Code plugin: the hub's skills (pr-babysit, pipeline-watch, log-watcher, todo) and hooks; see [The hub plugin](docs/ghostty.md#the-hub-plugin) | loaded in place, by `claude plugin install` |
| [`diagram-plugin/`](diagram-plugin) | the `diagram-pane` Claude Code plugin: the mod that draws the Side panel's Diagrams, and the make-diagram skill | loaded in place, by `claude plugin install`, with the Side panel |
| [`install/`](install) | the install walkthrough (`install/walkthrough`, Node) and what runs after linking | |
| [`tests/`](tests) | contract tests, and the fixtures and golden screens unit tests share | |
| [`docs/`](docs) | [what it does](docs/ghostty.md), [how the code is laid out](docs/architecture.md), [logging](docs/logging.md) | |

## Install

Ubuntu or Kubuntu, with Node.js 24 or later (the hub, tray and viewer run on it; fnm works).

```bash
./install.sh                  # asks what to set up (first time), shows what it'll install, installs on yes
./install.sh --reconfigure    # asks every page again
./install.sh --yes            # approves the review for you (no terminal)
./install.sh --links          # only the links, no questions or sudo: after a pull that adds or moves files
```

- **Asks first, installs after.** A short walkthrough (Inquirer, in the hub's colours) asks four
  things: the optional parts (the btop Header, the Side panel, the KDE widget under Plasma 6), the
  editor Alt+E opens (VS Code or Zed), whether to restart stopped agents after a reboot, and the
  default folder. Agent Hub and its plugin are always installed. Then a review lists, like apt,
  what's missing: packages with versions and sizes, yazi, Claude Code, the plugin. Nothing is
  installed until you say yes, and sudo asks once.
- **Answers are kept.** The hub's own settings go to its Settings (change them there later); the
  rest to `~/.config/dominus/install.json`. A later run asks nothing and only installs what's
  missing.
- **Your Claude setup stays yours.** The only Claude Code change is the `dominus` plugin; your
  settings, skills and other plugins aren't touched.
- **Live.** The Ghostty files are symlinks into this checkout, and the plugin loads in place from
  it, so edits apply at once. Install from the main checkout, not a worktree.
- **Safe.** A file of yours in the way is moved to `.install-backup/<timestamp>/` (gitignored),
  keeping its path. A link left from the dotfiles repo's old layout is replaced, and one whose file
  is gone is removed.
- **Idempotent.** Re-running reports `ok` for links already in place.
- Overrides: `DOMINUS_TARGET=/path` with `--links` (link under this instead of `$HOME`, for a dry run) ·
  `DOMINUS_BACKUP=/path` (backup root).

The hub's skills need one MCP connector, and only for log-watcher's Kibana links and deep dives:
Elastic, added by hand once per machine ([elastic.md](hub-plugin/skills/log-watcher/references/elastic.md)).
Claude Code sends no desktop notifications: what needs you
shows in the Agents widget (see [docs/ghostty.md](docs/ghostty.md#agents-widget)).

## Tests

Run every suite before committing a change, agents included:

```bash
./test.sh                # every suite
./test.sh ghostty contract    # one or more of: ghostty, contract, hub, mods
```

| Suite | Covers | Runner |
|---|---|---|
| `ghostty` | unit tests beside each `ghostty/**/*.ts` | `node --test`, nothing to install |
| `contract` | `tests/contract`: what the Node, Python, shell and QML sides must agree on | `node --test` |
| `hub` | the hub plugin's skill scripts, `agent_hub` and its fetch hook, `hub-plugin/tests/test_<tool>.py` | Python's `unittest`, nothing to install |
| `mods` | the diagram-pane mod's `diagram-plugin/hooks/*.test.tsx` | `claude plugin test`, skipped when `claude` isn't installed |

A new test file in one of those places is picked up without changing `test.sh`. When you change a
behaviour, add or update the test that pins it in the same commit.

## Pre-commit

[pre-commit](https://pre-commit.com) lints the staged files, then runs the test suite for each part
they touch. Set it up once per clone:

```bash
uv tool install pre-commit
pre-commit install
pre-commit run --all-files   # every hook on every file, by hand
```

| Hook | Checks | Config |
|---|---|---|
| `pre-commit-hooks` | JSON, YAML and TOML parse; no merge markers, private keys or large files; trailing whitespace and final newlines (fixed in place) | |
| `ruff check` | Python | [`ruff.toml`](ruff.toml) |
| `shellcheck` | shell scripts, warnings and errors only | [`.shellcheckrc`](.shellcheckrc) |
| `biome lint` | JS and TS | [`biome.json`](biome.json) |
| `typecheck (tsc)` | the types in `ghostty/`, the whole program whenever a `.ts` file is staged; needs `npm install` once | [`tsconfig.json`](tsconfig.json) |
| `tests (ghostty / contract / hub / mods)` | `./test.sh <suite>`, only when a file that suite covers is staged | |

The linter configs leave out rules the existing code breaks on purpose; each config says why. CI
runs the lint hooks in its `lint` job, and the type check and the `ghostty` and `hub` suites in
their own jobs.

## History

This repo was split out of the dotfiles repo with its history: every commit that touched these files
is here, with the paths renamed to this layout.
