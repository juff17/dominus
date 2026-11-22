# shellcheck shell=bash
# The layout of a Ghostty window: its sizes, its viewer and its hub, and
# which windows Ghostty has. Sourced through ghostty-lib.sh, after core.sh.
#
# Each Ghostty window runs an outer tmux (layout.conf) that lays the window
# out: btop on top, the viewer on the left and the tab session on the right.
# The tab session is a second tmux (tmux.conf) inside that pane. tmux sizes
# panes exactly; Ghostty's own splits can't be sized from a script, since its
# global keybinds act on every split of every window.

viewer_percent() { setting layout.viewerPercent GHOSTTY_VIEWER_SHARE 30; }
rail_cols() { setting layout.railCols GHOSTTY_RAIL_COLS 6; }
top_rows() { setting layout.topRows GHOSTTY_TOP_ROWS 10; }

# One state folder per Ghostty process, so a restart starts clean. The first
# call for a new process removes the folders of those no longer running.
state_dir() {
  local pid old
  pid=$(pgrep -o -x ghostty) || return 1
  local root="${XDG_RUNTIME_DIR:-/tmp}/ghostty-layout"
  local dir="$root/$pid"
  if [[ ! -d $dir ]]; then
    for old in "$root"/*/; do
      old=${old%/}
      [[ ${old##*/} =~ ^[0-9]+$ && ! -e /proc/${old##*/} ]] || continue
      rm -rf -- "$old" 2>/dev/null || ah_log warn "$AH_COMPONENT" "state dir not removed" path "$old"
    done
  fi
  mkdir -p "$dir" && echo "$dir"
}

# Ghostty's window numbers, from its D-Bus objects.
windows() {
  gdbus introspect --session --dest com.mitchellh.ghostty \
    --object-path /com/mitchellh/ghostty/window 2>/dev/null |
    sed -n 's/^ *node \([0-9][0-9]*\) .*/\1/p' | sort -n
  local status=${PIPESTATUS[0]}
  ((status == 0)) || ah_log error "$AH_COMPONENT" "gdbus introspect failed" exit "$status"
}

# window_lock <win> <what>: holds a lock on <what> in window <win> until the
# script exits. A double press can run a run-shell -b script twice at once,
# and both would act on what they saw before the other's change (two
# viewers). The second waits, and goes on regardless after 5s or without flock.
window_lock() {
  local dir="${XDG_RUNTIME_DIR:-/tmp}/ghostty-layout"
  mkdir -p "$dir" 2>/dev/null && exec {WINDOW_LOCK_FD}>"$dir/$2-$1.lock" &&
    flock -w 5 "$WINDOW_LOCK_FD" 2>/dev/null && return 0
  ah_log warn "$AH_COMPONENT" "window not locked" win "$1" lock "$2"
}

# yazi's client id in window <win>'s viewer, which `ya emit-to` sends actions
# to. Window numbers are unique within the Ghostty process.
viewer_id() {
  echo $((4200000 + $1))
}

# The folder Files shows next in window <win>'s viewer, for when yazi isn't
# running to be told now.
viewer_dir_file() {
  echo "${XDG_RUNTIME_DIR:-/tmp}/ghostty-layout/viewer-$(viewer_id "$1").dir"
}

# open_viewer <win> <dir> [keep]: opens window <win>'s viewer left of the tab
# session, in Files at <dir>. With keep, the viewer keeps focus afterwards.
# yazi asks Ghostty about the terminal through tmux, and tmux hands Ghostty's
# answers to whichever pane has focus; in a Claude pane one reads as Alt+P
# (the model picker). So the viewer holds focus while yazi starts. yazi sets
# allow-passthrough on its pane between its first round of questions, which
# tmux answers, and its second, which Ghostty answers a moment later.
open_viewer() {
  local win=$1 dir=$2 keep=${3:-} tabs viewer share left i
  tabs=$(layout show -t "layout-$win" -v @tabs 2>/dev/null) || return
  share=$(viewer_percent)
  # DV_TABS tells Diagrams and Diff whose active tab to follow.
  viewer=$(layout split-window -d -h -b -l "$share%" \
    -t "$tabs" -P -F '#{pane_id}' -c "$dir" \
    -e "DV_TABS=$TABS_SOCKET:ghostty-$win" -e "VIEWER_ID=$(viewer_id "$win")" \
    "$GHOSTTY_CONF/bin/ghostty-viewer" "$dir" 2>/dev/null) || {
    pane_failed "$?" viewer "$win"
    return
  }
  # Ghostty opens a window small and the window manager grows it after, and
  # tmux shares that growth out between the panes, so the viewer would end
  # up far from its share of the row. This puts it back after every resize,
  # which also undoes a drag of its divider. The hook's [0] is add_hub's.
  left=$(layout display -p -t "$viewer" '#{pane_left}')
  layout set-hook -t "layout-$win" 'window-resized[1]' \
    "run -C 'resize-pane -t $viewer -x #{e|/:#{e|*:#{e|-:#{window_width},$left},$share},100}'"
  if ! command -v yazi >/dev/null; then
    [[ -n $keep ]] && layout select-pane -t "$viewer"
    return 0
  fi
  layout select-pane -t "$viewer"
  for ((i = 0; i < 40; i++)); do
    [[ $(layout show -p -t "$viewer" -v allow-passthrough) == all ]] && break
    sleep 0.05
  done
  sleep 1
  [[ -n $keep ]] || layout select-pane -t "$tabs"
}

# Adds the agent hub to window <win>'s outer session: the rail down the left
# of the workspace, and a second tmux window, hub, with its own rail and the
# hub itself. The rail's work and hub buttons, and Ctrl+Shift+W, A and B,
# switch between the two (layout.conf).
add_hub() {
  local win=$1 session="layout-$1" cols rows tabs top rail hub hub_rail
  [[ ${GHOSTTY_RAIL:-1} == 0 ]] && return 0
  cols=$(rail_cols)
  rows=$(top_rows)
  [[ -n $(layout show -t "$session" -v @hub 2>/dev/null) ]] && return 0
  tabs=$(layout show -t "$session" -v @tabs 2>/dev/null) || return
  local bin="$GHOSTTY_CONF/bin/ghostty-hub"
  layout rename-window -t "$tabs" work
  rail=$(layout split-window -d -h -b -f -l "$cols" -t "$tabs" -P -F '#{pane_id}' \
    "$bin rail $win work") || { pane_failed "$?" rail "$win"; return; }
  layout set -p -t "$rail" @rail 1
  hub=$(layout new-window -d -t "$session:" -n hub -P -F '#{pane_id}' "$bin hub $win") ||
    { pane_failed "$?" hub "$win"; return; }
  layout set -p -t "$hub" @hub 1
  hub_rail=$(layout split-window -d -h -b -f -l "$cols" -t "$hub" -P -F '#{pane_id}' \
    "$bin rail $win hub") || { pane_failed "$?" 'hub rail' "$win"; return; }
  layout set -p -t "$hub_rail" @rail 1
  layout set -t "$session" @hub "$hub"
  # tmux shares a resize out between the panes; this puts btop's height and
  # the rails' width back after one.
  top=$(layout list-panes -s -t "$session" -F '#{pane_id} #{@top}' | awk '$2 == 1 { print $1; exit }')
  layout set-hook -t "$session" window-resized \
    "${top:+resize-pane -t $top -y $rows ; }resize-pane -t $rail -x $cols ; resize-pane -t $hub_rail -x $cols"
}

# pane_failed <status> <pane> <win>: returns <status>, so the caller's bare
# return passes tmux's failure on.
pane_failed() {
  ah_log error "$AH_COMPONENT" "pane not opened" exit "$1" pane "$2" win "$3"
  return "$1"
}
