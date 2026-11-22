#!/usr/bin/env bash
# Puts a babysit event that needs the user in the Agents tray as a ▲ item whose
# Go button opens this session; no desktop pop-up. The tray (tray/tray.mjs)
# drops the note once the user goes to it or dismisses it.
# Usage: notify.sh TITLE MESSAGE
#   TITLE    what it's about, e.g. "jstack !123"
#   MESSAGE  one line: what needs them

title=${1:-PR babysit}
msg=${2:-Needs your attention}

# The hub's bash logger, from the repo this plugin lives in.
here=$(readlink -f "${BASH_SOURCE[0]}")
log_sh=${here%/*}/../../../../ghostty/bin/lib/log.sh
if [[ -f $log_sh ]]; then
  # shellcheck source=/dev/null
  source "$log_sh"
else
  ah_log() { :; }
fi

dir=${XDG_RUNTIME_DIR:-/tmp}/agent-hub/notes
mkdir -p "$dir"
# Bash's own clock: uutils date prints %N unpadded, which put `at` up to a
# second off. Digits only, as the decimal point follows the locale.
us=${EPOCHREALTIME//[!0-9]/}
name=${us}000-$$
# $TMUX names the tmux server $TMUX_PANE is on: a pane id is unique only on
# one server, so the tray matches by pane only on the tab server's.
jq -n --arg title "$title" --arg message "$msg" \
  --arg session "${CLAUDE_CODE_SESSION_ID:-}" --arg pane "${TMUX_PANE:-}" --arg tmux "${TMUX:-}" \
  --argjson at "$((us / 1000))" \
  '{title: $title, message: $message, session: $session, pane: $pane, tmux: $tmux, at: $at}' >"$dir/.$name"
status=$?
if ((status != 0)); then
  rm -f "$dir/.$name"
  ah_log error notify "tray note failed" exit "$status" title "$title"
  echo "notify.sh: the tray note wasn't written: jq failed (exit $status)" >&2
  exit 1
fi
# Renamed into place, so the tray never reads half a note.
mv "$dir/.$name" "$dir/$name.json"
ah_log info notify "tray note written" title "$title"
exit 0
