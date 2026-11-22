# shellcheck shell=bash
# The hub's tab session on the tab server, and closing a tab. Sourced through
# ghostty-lib.sh, after core.sh.

# hub_tabs <win>: prints the name of window <win>'s hub tab session,
# hubtabs-<win>, which holds the tabs opened from the hub and only those. A
# workspace tab stays in the workspace, and the hub sends you there to see it
# (hub/peek.ts), so the two never share a tab. Fails when the hub has no tabs.
hub_tabs() {
  local own="hubtabs-$1"
  # Earlier versions linked every new workspace tab in with this hook; a tab
  # server started then still has it.
  tab_server set-hook -gu window-linked 2>/dev/null
  tab_server has-session -t "=$own" 2>/dev/null || return 1
  echo "$own"
}

# close_tab <tabs> <tab> [keep]: closes tab <tab> of tab session <tabs> (its
# number or window id; the active tab when empty), from every session that
# links it. A workspace (ghostty-<win>) left with no tab ends and takes its
# window with it (run_tabs in ghostty-surface). That's wanted only from the
# workspace itself: from anywhere else, or with keep, the workspace gets a
# fresh tab in the same folder first.
close_tab() {
  local tabs=$1 tab=$2 keep=${3:-} id path session count
  # Looked up in the session's own list, not through display -t: tmux
  # resolves a window id that isn't there to the session's active window, so
  # a tab closed meanwhile would take the active one with it.
  read -r id path < <(tab_server list-windows -t "=$tabs" -F '#{window_index} #{window_id} #{window_active} #{pane_current_path}' 2>/dev/null |
    awk -v tab="$tab" '(tab == "" && $3 == 1) || (tab != "" && ($1 == tab || $2 == tab)) { id = $2; sub(/^[^ ]+ [^ ]+ [^ ]+ /, ""); print id, $0; exit }')
  # A tab that isn't there is no error: the key just does nothing.
  [[ -n $id ]] || return 0
  while read -r session count; do
    session_window "$session" ghostty- || continue
    ((count == 1)) || continue
    [[ -z $keep && $session == "$tabs" ]] && continue
    if ! tab_server new-window -d -t "=$session:" -c "${path:-$HOME}"; then
      ah_log error "$AH_COMPONENT" "tab not closed" id "$id" session "$session" reason "workspace tab not opened"
      return 1
    fi
    ah_log info "$AH_COMPONENT" "workspace kept open" id "$id" session "$session"
  done < <(tab_server list-windows -a -F '#{window_id} #{session_name} #{session_windows}' 2>/dev/null |
    awk -v id="$id" '$1 == id { print $2, $3 }')
  tab_server kill-window -t "$id"
}
