# shellcheck shell=bash
# The shell the bin/ scripts share. Each sources this file from beside its
# own real path; it's sourced, not run. The helpers are in lib/:
#   log.sh     ah_log, the logger (docs/logging.md)
#   core.sh    the sockets, layout and tab_server, node, setting, popups
#   layout.sh  a window's layout: sizes, the viewer, the hub, Ghostty's windows
#   tabs.sh    the hub's tab session on the tab server

# The config folder this file is in, through the link install.sh makes.
GHOSTTY_CONF=$(readlink -f "${BASH_SOURCE[0]}")
GHOSTTY_CONF=${GHOSTTY_CONF%/bin/*}

# The source= lines let shellcheck -x follow them (.pre-commit-config.yaml).
# shellcheck source=lib/log.sh
source "$GHOSTTY_CONF/bin/lib/log.sh"
# shellcheck source=lib/core.sh
source "$GHOSTTY_CONF/bin/lib/core.sh"
# shellcheck source=lib/layout.sh
source "$GHOSTTY_CONF/bin/lib/layout.sh"
# shellcheck source=lib/tabs.sh
source "$GHOSTTY_CONF/bin/lib/tabs.sh"
