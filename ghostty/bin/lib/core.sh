# shellcheck shell=bash
# What every bin/ script may need: the two tmux servers, Node.js and the
# Settings it reads, the popups, and the session names. Sourced through
# ghostty-lib.sh, which sets GHOSTTY_CONF first. Nothing here runs another
# program as it's sourced.

# The sockets can be moved for tests, which then never touch the real servers.
LAYOUT_SOCKET=${GHOSTTY_LAYOUT_SOCKET:-ghostty-layout}
TABS_SOCKET=${AGENT_HUB_TABS_SOCKET:-ghostty}
# Where ghostty-claude-start saves where node and claude are, which Ghostty's
# own PATH usually lacks.
GHOSTTY_CACHE=${XDG_CACHE_HOME:-$HOME/.cache}/ghostty-layout
AH_COMPONENT=${0##*/}
AH_COMPONENT=${AH_COMPONENT#ghostty-}

layout() {
  tmux -L "$LAYOUT_SOCKET" -f "$GHOSTTY_CONF/layout.conf" "$@"
}

tab_server() {
  tmux -L "$TABS_SOCKET" -f "$GHOSTTY_CONF/tmux.conf" "$@"
}

# session_window <session> <prefix>: sets WIN to the window number of a
# session named <prefix><n> (ghostty-3, layout-3), and fails for any other
# name (hubtabs-3, peek-12).
session_window() {
  WIN=${1#"$2"}
  [[ $WIN =~ ^[0-9]+$ ]]
}

# find_node: sets NODE to the Node.js on PATH, else the one
# ghostty-claude-start last saw. Fails when there's neither. Some builds can't
# run TypeScript (Ubuntu's own node has no type stripping), so when both are
# there and differ, each is used only if it runs TypeScript; an upgrade can
# also remove the saved one. hash and read, not command -v and cat in a
# subshell, since the tray runs this every poll.
find_node() {
  NODE=''
  local on_path='' cached=''
  hash node 2>/dev/null && on_path=${BASH_CMDS[node]}
  { IFS= read -r -d '' cached <"$GHOSTTY_CACHE/node"; } 2>/dev/null
  while [[ $cached == *$'\n' ]]; do cached=${cached%$'\n'}; done
  if [[ -n $on_path ]] && [[ -z $cached || $on_path == "$cached" ]]; then
    NODE=$on_path
  elif [[ -n $on_path ]] && node_runs_ts "$on_path"; then
    NODE=$on_path
  elif [[ -x $cached ]] && node_runs_ts "$cached"; then
    NODE=$cached
  else
    # Neither runs TypeScript: the one on PATH, if any, can still say so.
    NODE=$on_path
  fi
  [[ -n $NODE ]] && return 0
  ah_log warn "$AH_COMPONENT" "node not found" path "$GHOSTTY_CACHE/node" cached "$cached"
  return 1
}

# node_runs_ts <node>: whether that node can run .ts files, kept in
# $GHOSTTY_CACHE/node-ts/ until that node changes.
node_runs_ts() {
  local memo="$GHOSTTY_CACHE/node-ts/${1//\//%}" answer=no
  if [[ -f $memo && ! $1 -nt $memo ]]; then
    read -r answer <"$memo"
    [[ $answer == yes ]]
    return
  fi
  case $("$1" -p 'process.features.typescript' 2>/dev/null) in
    strip | transform) answer=yes ;;
  esac
  ah_log info "$AH_COMPONENT" "node checked" path "$1" ts "$answer"
  mkdir -p "${memo%/*}" && echo "$answer" >"$memo"
  [[ $answer == yes ]]
}

# words <path> [name=value …]: a message from core/text.json, its {name}s
# filled; the bare path when Node can't be found to read it.
words() {
  local NODE
  find_node && "$NODE" "$GHOSTTY_CONF/core/text.ts" "$@" && return
  echo "$1"
}

# setting <key> <env var> <fallback>: a value from Settings (settings/settings.ts).
# The environment variable wins when it's set (pass '' for none); the
# fallback stands in when Node can't be found or can't read it.
setting() {
  local key=$1 env=$2 fallback=$3 NODE status
  if [[ -n $env && -n ${!env:-} ]]; then
    echo "${!env}"
    return
  fi
  if find_node; then
    "$NODE" --input-type=module -e \
      "const v = (await import(process.argv[1])).get(process.argv[2]); if (v === undefined) process.exit(1); console.log(v)" \
      "$GHOSTTY_CONF/settings/settings.ts" "$key" 2>/dev/null && return
    status=$?
    ah_log warn "$AH_COMPONENT" "setting fell back" key "$key" exit "$status" fallback "$fallback"
  fi
  echo "$fallback"
}

# popup_opens <mode>: whether the popup key of viewer mode <mode> (todo,
# diagrams) opens it, which Settings › Workspace can turn off with the mode.
# It opens when Node can't be found or can't say: only a plain "off" keeps it
# shut, so a modes.ts that crashes never reads as the mode turned off.
popup_opens() {
  local NODE answer status
  find_node || return 0
  answer=$("$NODE" "$GHOSTTY_CONF/viewer/modes.ts" popup "$1" 2>/dev/null)
  status=$?
  [[ $status == 0 && $answer == off ]] && return 1
  ((status == 0)) || ah_log warn "$AH_COMPONENT" "popup check failed" exit "$status" mode "$1"
  return 0
}

# overlay <client> [-d <dir>] <script> [arg]...: opens bin/<script> with its
# args as an overlay (tui/overlay.ts) on that client: a borderless tmux popup
# over the whole window, where the view draws its own frame over the window
# under it (OV_UNDER), dimmed.
overlay() {
  local client=$1 under status
  local -a start_in=()
  shift
  if [[ $1 == -d ]]; then
    start_in=(-d "$2")
    shift 2
  fi
  under=$(layout display -p -c "$client" '#{window_id}' 2>/dev/null)
  # The popup's own background is the dimmed window's, for the moment before
  # paint_backdrop draws it.
  layout display-popup -c "$client" -E -B -w 100% -h 100% -s "bg=#0a0b0b" -e "OV_UNDER=$under" "${start_in[@]}" \
    "$(printf '%q ' "$GHOSTTY_CONF/bin/$1" "${@:2}")" && return
  status=$?
  ah_log error "$AH_COMPONENT" "overlay failed" exit "$status" client "$client"
  return "$status"
}

# paint_backdrop <window>: draws layout window <window> (an id: @5) dimmed on
# the alternate screen, as tui/overlay.ts draws it round its frame. Node
# takes 150ms or so to load a view, and until then the overlay would be
# blank. tmux answers in milliseconds, and the view, entering the alternate
# screen it's already on, draws over this.
paint_backdrop() {
  local win=$1 panes id left top width height text line run out r
  # Kitty's image placeholder, U+10EEEE, as UTF-8 bytes.
  local placeholder=$'\xf4\x8e\xbb\xae'
  [[ -n $win && -t 1 ]] || return 0
  panes=$(layout list-panes -t "$win" -F '#{pane_id} #{pane_left} #{pane_top} #{pane_width} #{pane_height}' 2>/dev/null) || return 0
  # Synchronized output, the alternate screen, no cursor, then the screen
  # cleared to tui/overlay.ts's DIM: surface1 on crust.
  out=$'\e[?2026h\e[?1049h\e[?25l\e[38;2;55;61;60m\e[48;2;10;11;11m\e[2J'
  while read -r id left top width height; do
    [[ -n $id ]] || continue
    # The dividers tmux draws left of and above the pane, the top one from
    # the left one's column so they meet, as tui/backdrop.ts's compose.
    if ((left > 0)); then
      for ((r = 0; r < height; r++)); do out+=$'\e['"$((top + r + 1));${left}H│"; done
    fi
    if ((top > 0)); then
      printf -v run '%*s' "$((width + (left > 0)))" ''
      out+=$'\e['"${top};$((left + (left == 0)))H${run// /─}"
    fi
    text=$(layout capture-pane -p -t "$id" 2>/dev/null) || continue
    # A picture's placeholder cells would name an image here: blanks
    # instead, each with the marks that number its row and column.
    if [[ $text == *"$placeholder"* ]]; then
      text=$(perl -CSD -pe 's/\x{10EEEE}\p{Mn}*/ /g' <<<"$text" 2>/dev/null) || text=''
    fi
    r=0
    while IFS= read -r line && ((r < height)); do
      out+=$'\e['"$((top + r + 1));$((left + 1))H$line"
      r=$((r + 1))
    done <<<"$text"
  done <<<"$panes"
  printf '%s' "$out"$'\e[0m\e[?2026l'
}

# run_panel <name> <view.ts> [arg]...: what runs inside an overlay.
run_panel() {
  local name=$1 NODE
  shift
  if ! find_node; then
    echo "$name needs Node.js, and none was found."
    read -rsn1 -p "Press any key to close."
    exit 1
  fi
  paint_backdrop "${OV_UNDER:-}"
  exec "$NODE" "$@"
}

# copy_prompt_examples [examples] [dest]: each <name>.md.example in prompts/
# copied to <name>.md in ~/.config/dominus/prompts, the file the agents read
# (settings/prompts.ts), where it isn't there yet. A <name>.md an older install
# kept beside the example, where it may be a link into the repo, is moved there
# instead, so its edits carry over. Outside the repo, nothing tracks them.
copy_prompt_examples() {
  local src=${1:-$GHOSTTY_CONF/prompts} dest=${2:-${XDG_CONFIG_HOME:-$HOME/.config}/dominus/prompts} example name old
  mkdir -p "$dest"
  for example in "$src"/*.md.example; do
    [[ -e $example ]] || continue
    name=$(basename "${example%.example}")
    [[ -e $dest/$name ]] && continue
    old=$(readlink -f "$src/$name" 2>/dev/null)
    if [[ -n $old && -f $old ]]; then
      mv "$old" "$dest/$name"
    else
      cp "$example" "$dest/$name"
    fi
  done
}

# copy_env_example [root]: .env.example at the repo root copied to .env, kept
# to you alone (0600), where there's no .env yet. A .env there already keeps
# every line you wrote, and gets each key the example has that it lacks,
# empty, at its end. Git ignores .env; Tickets reads it (viewer/tickets/env.ts).
copy_env_example() {
  local root=${1:-$(cd "$GHOSTTY_CONF/.." && pwd)} key
  local example=$root/.env.example env=$root/.env
  [[ -e $example ]] || return 0
  if [[ ! -e $env ]]; then
    (umask 077 && cp "$example" "$env")
    chmod 600 "$env"
    echo "  copied  .env from .env.example: fill in the JIRA_ lines for Alt+J"
    return 0
  fi
  while IFS= read -r key; do
    grep -qE "^[[:space:]]*(export[[:space:]]+)?$key=" "$env" || printf '%s=\n' "$key" >>"$env"
  done < <(sed -nE 's/^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*)=.*/\1/p' "$example")
  if [[ -n $(find "$env" -perm /077 2>/dev/null) ]]; then
    echo "  warning .env can be read by others: chmod 600 $env" >&2
  fi
}
