"""What the skills' watchers (pr-babysit's watch_pr.py, pipeline-watch's
watch_pipeline.py) share: the [tag] event lines Claude Code's Monitor turns
into notifications, the per-session state file under the cache folder, the
lock that keeps one watcher per session, and the failures a poll retries."""

import json
import os
import re
import subprocess
from pathlib import Path

from agent_hub import files
from agent_hub.forge import ApiError

# A failed call, the network, or a body of an unexpected shape (None, a
# list): the next poll tries again rather than the watcher crashing.
RETRYABLE = (ApiError, subprocess.TimeoutExpired, ValueError, KeyError, IndexError, TypeError,
             AttributeError, OSError)


def emitter(log):
    """emit(tag, msg): one "[tag] msg" line on stdout, which the Monitor
    reads, and the same event in the script's log."""
    def emit(tag, msg):
        print(f"[{tag}] {msg}", flush=True)
        log.info("event", tag=tag, text=msg)
    return emit


def flat(text, limit):
    """text on one line, cut to limit characters."""
    text = " ".join((text or "").split())
    return text if len(text) <= limit else text[: limit - 1] + "…"


def once(state, key):
    """True the first time key is seen in state["events"], which keeps it."""
    if key in state["events"]:
        return False
    state["events"].add(key)
    return True


def cache_base(skill, name, safe="A-Za-z0-9_.-"):
    """Where a watcher keeps a target's files: name, with any character
    outside `safe` made _, in the skill's folder under XDG_CACHE_HOME."""
    root = Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache")) / skill
    return root / re.sub(f"[^{safe}]", "_", name)


def session_state(base, session, keep=()):
    """The state file for this session. Other sessions' files for the same
    target, but those in keep, are removed, so a new session starts clean."""
    mine = Path(f"{base}.{session}.json")
    kept = {mine, *keep}
    for old in base.parent.glob(f"{base.name}.*.json"):
        if old not in kept:
            old.unlink(missing_ok=True)
    return mine


def load_state(path, sets=("events",)):
    """The saved state, its `sets` lists back as sets; None for none or one
    that can't be read."""
    try:
        data = json.loads(path.read_text())
        for key in sets:
            data[key] = set(data[key])
        return data
    except (OSError, ValueError, KeyError, TypeError):
        return None


def save_state(path, state, sets=("events",)):
    path.parent.mkdir(parents=True, exist_ok=True)
    out = dict(state, **{key: sorted(state[key]) for key in sets})
    files.write_atomic(path, json.dumps(files.with_session(out)))


def take_lock(lock_path):
    """The lock for one watcher, or None while another holds it."""
    Path(lock_path).parent.mkdir(parents=True, exist_ok=True)
    return files.try_lock(str(lock_path))
