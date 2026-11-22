#!/usr/bin/env bash
# Runs after ghostty/ is linked; install.sh sets DEST. The layout builds its tmux
# layout in any window it hasn't seen, so the windows already open are recorded
# as known (not for a dry-run target).
set -e

# The Agents panel widget is linked as one folder, not file by file like
# ghostty/: Plasma refuses a widget whose files are links that lead outside
# its folder ("path traversal"), and then says the package doesn't exist.
# DOMINUS_WIDGET=off (the walkthrough's answer, or no Plasma 6) leaves it
# out, and takes away the link to it made before.
repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
widgets="$DEST/.local/share/plasma/plasmoids"
widget="$widgets/dev.dotfiles.agents"
if [ "${DOMINUS_WIDGET:-on}" != off ]; then
  mkdir -p "$widgets"
  if [ -d "$widget" ] && [ ! -L "$widget" ]; then
    # A folder of per-file links into this repo, from before, is replaced;
    # anything else is kept aside.
    if [ -z "$(find "$widget" ! -type d ! -lname "$repo/*" -print -quit)" ]; then
      rm -r "$widget"
    else
      mv "$widget" "$widget.install-backup"
    fi
  fi
  ln -sfn "$repo/plasmoid/dev.dotfiles.agents" "$widget"
  echo "  link    ~/.local/share/plasma/plasmoids/dev.dotfiles.agents (the folder)"
elif [ -L "$widget" ] && [ "$(readlink "$widget")" = "$repo/plasmoid/dev.dotfiles.agents" ]; then
  rm "$widget"
  echo "  unlink  ~/.local/share/plasma/plasmoids/dev.dotfiles.agents (turned off)"
fi

source "$repo/ghostty/bin/ghostty-lib.sh"

copy_prompt_examples
echo "  copied  any missing prompts/*.md from their .example"

[ "$DEST" = "$HOME" ] && pgrep -x ghostty >/dev/null || exit 0

if state=$(state_dir); then
  windows >>"$state/known"
  echo "  marked open Ghostty windows as existing"
fi
