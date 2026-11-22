"""Folders the hub and the scripts share, and writing files so a reader never
sees half of one."""

import fcntl
import os
from pathlib import Path


def runtime_dir():
    """$XDG_RUNTIME_DIR/agent-hub (or /tmp/agent-hub): approvals, notes, and
    what agentd writes. Read on each call, so a test can move it."""
    return Path(os.environ.get("XDG_RUNTIME_DIR") or "/tmp") / "agent-hub"


def with_session(data):
    """`data` marked with the Claude session writing it, so a file leads back
    to that session's transcript. Outside Claude it keeps the one it has."""
    session = os.environ.get("CLAUDE_CODE_SESSION_ID")
    return {**data, "claude_session": session} if session else data


def write_atomic(path, text, tmp=None):
    path = Path(path)
    tmp = Path(tmp) if tmp else Path(f"{path}.tmp")
    tmp.write_text(text)
    tmp.replace(path)


def try_lock(path):
    """An exclusive lock on `path`, or None when another process holds it. The
    lock lasts while the returned file stays open.

    Whoever holds the lock may unlink the file to clean up: a process that
    opened it before then and got the lock after finds the path no longer
    names its file, and locks the new one instead."""
    while True:
        handle = open(path, "w")
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            handle.close()
            return None
        held = os.fstat(handle.fileno())
        try:
            now = os.stat(path)
        except FileNotFoundError:
            now = None
        if now and (now.st_dev, now.st_ino) == (held.st_dev, held.st_ino):
            return handle
        handle.close()
