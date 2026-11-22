#!/usr/bin/env bash
# dominus installer.
#
#   ./install.sh                 asks what to set up (the first time), shows
#                                what it will install, and installs it once you
#                                say yes
#   ./install.sh --reconfigure   asks every page again
#   ./install.sh --yes           says yes to the review for you (no terminal)
#   ./install.sh --links         only the links: no questions, sudo or installers
#
# The walkthrough (install/walkthrough, Node with @inquirer/prompts) has four
# pages: the optional parts (the btop header, the side panel, the KDE widget),
# the editor Alt+E opens, restarting stopped agents, and the default folder.
# Agent Hub itself, and the skills and hooks it needs from Claude Code (the
# dominus plugin in hub-plugin/), are always installed; the side panel adds
# the diagram-pane plugin (diagram-plugin/) for its Diagrams. Answers go to the
# hub's Settings and to ~/.config/dominus/install.json, so a later run asks
# nothing. Nothing is installed until you approve the review, and your own
# Claude settings are never touched.
#
# Needs Node.js 24 or later (the hub runs on it), on PATH or from fnm.
#
# Linking is per file, so ~/.config/ghostty can hold files of your own. A file
# already in the way is moved into a timestamped backup folder, keeping its
# relative path. A link into this repo, or one left from the dotfiles repo's
# layout (…/modules/ghostty/home/.config/ghostty/…), is replaced without a
# backup. In ~/.config/ghostty and the folders below it, a link into this repo
# whose file is gone (moved or deleted here) is removed, and so is any link
# still into the dotfiles layout once this repo has no such file.
#   DOMINUS_TARGET=/path  with --links: link under this instead of $HOME (a dry run)
#   DOMINUS_BACKUP=/path  backup root (default <repo>/.install-backup, gitignored)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="${DOMINUS_TARGET:-$HOME}"
BACKUP_ROOT="${DOMINUS_BACKUP:-$HERE/.install-backup}/$(date +%Y%m%d%H%M%S)"
export DEST
CONFIG="$HERE/ghostty"
CONFIG_DEST="$DEST/.config/ghostty"
# Where the dotfiles repo kept this config, to recognise links left from it.
LEGACY='*/modules/ghostty/home/.config/ghostty/*'
# This repo's plugins and the marketplace they come from (.claude-plugin/ here).
MARKETPLACE=dominus
PLUGIN=dominus@$MARKETPLACE
DIAGRAMS=diagram-pane@$MARKETPLACE

place() { # place <src-file> <path under ~/.config/ghostty>
  local src="$1" rel="$2" dest="$CONFIG_DEST/$2" target=''
  if [ -L "$dest" ] && [ "$(readlink -f "$dest")" = "$(readlink -f "$src")" ]; then
    echo "  ok      ~/.config/ghostty/$rel"
    return
  fi
  if [ -L "$dest" ]; then target=$(readlink "$dest"); fi
  # shellcheck disable=SC2053 # $LEGACY is a pattern
  if [[ -n $target && ($target == "$HERE"/* || $target == $LEGACY) ]]; then
    rm "$dest"
  elif [ -e "$dest" ] || [ -L "$dest" ]; then
    mkdir -p "$(dirname "$BACKUP_ROOT/$rel")"
    mv "$dest" "$BACKUP_ROOT/$rel"
    echo "  backup  ~/.config/ghostty/$rel -> ${BACKUP_ROOT/#$HOME/\~}/$rel"
  fi
  mkdir -p "$(dirname "$dest")"
  ln -s "$src" "$dest"
  echo "  link    ~/.config/ghostty/$rel"
}

prune() {
  local link target
  if [ ! -d "$CONFIG_DEST" ] || [ -L "$CONFIG_DEST" ]; then return 0; fi
  while IFS= read -r -d '' link; do
    target=$(readlink "$link")
    # shellcheck disable=SC2053 # $LEGACY is a pattern
    if [[ ($target == "$HERE"/* && ! -e $link) || $target == $LEGACY ]]; then
      rm "$link"
      echo "  unlink  ~/${link#"$DEST"/}"
    fi
  done < <(find "$CONFIG_DEST" -type l -print0)
}

link_ghostty() { # link_ghostty <on|off: the KDE widget>
  local f
  # A .example is copied by after-link.sh, not linked.
  while IFS= read -r -d '' f; do
    place "$f" "${f#"$CONFIG"/}"
  done < <(find "$CONFIG" -type f ! -name '.gitkeep' ! -name '*.example' -print0)
  prune
  DOMINUS_WIDGET=$1 bash "$HERE/install/after-link.sh"
}

node_runs_ts() { [[ $("$1" -p 'process.features.typescript' 2>/dev/null) == @(strip|transform) ]]; }

# A Node that runs TypeScript: the one on PATH, else fnm's newest.
find_node() {
  local n
  n=$(command -v node || true)
  if [[ -n $n ]] && node_runs_ts "$n"; then
    echo "$n"
    return
  fi
  for n in $(ls -d "${FNM_DIR:-$HOME/.local/share/fnm}"/node-versions/*/installation/bin/node 2>/dev/null | sort -rV); do
    if node_runs_ts "$n"; then
      echo "$n"
      return
    fi
  done
  return 1
}

# The walkthrough's one package, installed into this checkout's node_modules
# (gitignored) the first time. The dev tools come too: npm ci replaces
# node_modules whole, and leaving them out would take the type checker from a
# checkout you also work in.
ensure_prompts() {
  [ -d "$HERE/node_modules/@inquirer/prompts" ] && return 0
  echo "==> Installing the walkthrough's prompts (npm ci)"
  (cd "$HERE" && PATH="$(dirname "$NODE"):$PATH" npm ci --no-audit --no-fund >/dev/null)
}

claude_cmd() { command -v claude || echo "$HOME/.local/bin/claude"; }

# Adds this checkout as the plugins' marketplace when it isn't one yet, else
# re-reads it so a plugin added to it since is found.
ensure_marketplace() {
  local claude
  claude=$(claude_cmd)
  if "$claude" plugin marketplace list --json 2>/dev/null |
    "$NODE" -e 'const l = JSON.parse(require("fs").readFileSync(0, "utf8")); process.exit(l.some(m => m.name === process.argv[1]) ? 0 : 1)' "$MARKETPLACE"; then
    "$claude" plugin marketplace update "$MARKETPLACE"
  else
    "$claude" plugin marketplace add "$HERE"
  fi
}

# Each plugin loads in place from its folder here.
install_plugin() { # install_plugin <plugin@marketplace>
  echo "==> Claude Code plugin $1"
  "$(claude_cmd)" plugin install "$1" --scope user
}

# diagram-pane renders with mermaid-cli, from npm; it uses the system Chrome,
# so puppeteer's own copy isn't downloaded. Any npm will do, so one on PATH
# goes first and the Node found above is only the fallback.
install_diagrams() {
  echo "==> diagram-pane's npm packages (npm ci)"
  (cd "$HERE/diagram-plugin" && PATH="$PATH:$(dirname "$NODE")" PUPPETEER_SKIP_DOWNLOAD=1 npm ci --omit=dev --no-audit --no-fund >/dev/null)
  install_plugin "$DIAGRAMS"
}

mode=install
flags=()
for a in "$@"; do
  case "$a" in
    --links) mode=links flags+=(--links) ;;
    --reconfigure | --yes) flags+=("$a") ;;
    -h | --help)
      sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "unknown argument: $a (--reconfigure, --yes, --links)" >&2
      exit 1
      ;;
  esac
done
if [[ -n ${DOMINUS_TARGET:-} && $mode != links ]]; then
  echo "DOMINUS_TARGET only goes with --links: it moves where the links go, not what gets installed" >&2
  exit 1
fi

if ! NODE=$(find_node); then
  echo "install.sh needs Node.js 24 or later (the hub runs on it): install one, for example with fnm, then run this again" >&2
  exit 1
fi
ensure_prompts

plan=$(mktemp "${TMPDIR:-/tmp}/dominus-plan.XXXXXX")
trap 'rm -f "$plan"' EXIT
status=0
"$NODE" "$HERE/install/walkthrough/main.ts" --plan "$plan" "${flags[@]}" || status=$?
case $status in
  0) ;;
  10) exit 0 ;;
  *) exit "$status" ;;
esac

apt=() yazi=0 claude=0 plugin=0 diagrams=0 widget=off
while read -r step rest; do
  case $step in
    apt) read -ra apt <<<"$rest" ;;
    yazi) yazi=1 ;;
    claude) claude=1 ;;
    plugin) plugin=1 ;;
    diagrams) diagrams=1 ;;
    widget) widget=$rest ;;
  esac
done <"$plan"

# One password, asked before the first step that needs it.
if ((${#apt[@]} || yazi)); then sudo -v; fi
if ((${#apt[@]})); then
  echo "==> apt: ${apt[*]}"
  sudo apt-get install -y "${apt[@]}"
fi
if ((yazi)); then
  echo "==> yazi (snap)"
  sudo snap install yazi --classic
fi
if ((claude)); then
  echo "==> Claude Code"
  curl -fsSL https://claude.ai/install.sh | bash
fi
echo "==> [hub] link -> $DEST"
link_ghostty "$widget"
if ((plugin || diagrams)); then ensure_marketplace; fi
if ((plugin)); then install_plugin "$PLUGIN"; fi
if ((diagrams)); then install_diagrams; fi
echo "==> Done"
