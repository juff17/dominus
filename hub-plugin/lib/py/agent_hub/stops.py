"""Watches the user stopped from the hub's Monitors. The hub ends the
watcher's process, which the session can't tell from a Monitor timeout, so
the skill re-arms it. The hub also leaves a request in
$XDG_RUNTIME_DIR/agent-hub/stop-requests/<session id>.<task id> holding the
monitor's command (markStopped in ghostty/agents/client.ts); the re-armed
watcher takes it and says it was stopped instead of watching again."""

import os
import shlex
import time

from agent_hub import files

# One the session never re-armed for must not block a watch started later.
MAX_AGE = 3600


def runs(command, argv):
    """Whether `command` (a shell line) runs this script with these args."""
    try:
        words = shlex.split(command)
    except ValueError:
        return False
    script, rest = os.path.basename(argv[0]), list(argv[1:])
    return any(os.path.basename(w) == script and words[i + 1:i + 1 + len(rest)] == rest
               for i, w in enumerate(words))


def stopped_by_user(argv, log, now=time.time):
    """True once for each stop the user made on this session's watch with
    these args. Taking the request means a start the user asks for later runs."""
    session = os.environ.get("CLAUDE_CODE_SESSION_ID")
    if not session:
        return False
    folder = files.runtime_dir() / "stop-requests"
    try:
        names = sorted(n for n in os.listdir(folder) if n.startswith(f"{session}."))
    except FileNotFoundError:
        return False
    except OSError as e:
        log.warning("stop requests unreadable", path=str(folder), err=e)
        return False
    for name in names:
        path = folder / name
        try:
            age = now() - path.stat().st_mtime
            command = path.read_text()
        except FileNotFoundError:
            continue
        except OSError as e:
            log.warning("stop request unreadable", path=str(path), err=e)
            continue
        if age <= MAX_AGE and not runs(command, argv):
            continue
        try:
            path.unlink(missing_ok=True)
        except OSError as e:
            log.warning("stop request not removed", path=str(path), err=e)
        if age <= MAX_AGE:
            log.info("watch not restarted", id=name, path=str(path))
            return True
    return False
