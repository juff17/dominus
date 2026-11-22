"""Needs-you rows in the Agents tray, as pr-babysit's notify.sh writes them:
one JSON file in $XDG_RUNTIME_DIR/agent-hub/notes/ naming this Claude session
and tmux pane, so the tray's Go button finds it."""

import json
import os
import time

from agent_hub import files


def tray_note(title, message, log):
    """Writes one note; a note that can't be written is logged to `log` and
    dropped, so the watch it reports on goes on."""
    notes = files.runtime_dir() / "notes"
    try:
        notes.mkdir(parents=True, exist_ok=True)
        name = f"{time.time_ns()}-{os.getpid()}"
        files.write_atomic(notes / f"{name}.json",
                           json.dumps({"title": title, "message": message, "at": int(time.time() * 1000),
                                       "session": os.environ.get("CLAUDE_CODE_SESSION_ID", ""),
                                       "pane": os.environ.get("TMUX_PANE", ""),
                                       "tmux": os.environ.get("TMUX", "")}),
                           tmp=notes / f".{name}")
        log.info("tray note written", title=title)
        return True
    except OSError as e:
        log.warning("tray note failed", title=title, err=e)
        return False
