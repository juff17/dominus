"""The agent hub's logger for Python (docs/logging.md): one line per event,

    <UTC time> <LEVEL> <component>: <message> <json fields>

appended to $XDG_STATE_HOME/agent-hub/logs/<component>.log, the same lines
the Node and shell loggers write. Never stdout or stderr: a watcher's stdout
lines are Monitor events in Claude's conversation. A log that can't be
written is dropped rather than break the script."""

import json
import os
import time
import traceback
from datetime import UTC, datetime
from pathlib import Path

LEVELS = {"debug": 10, "info": 20, "warn": 30, "error": 40}
# Past this a log moves to <component>.log.1, replacing the one there.
MAX_BYTES = 1024 * 1024
CHECK_EVERY = 100


def log_dir():
    if os.environ.get("AGENT_HUB_LOG_DIR"):
        return Path(os.environ["AGENT_HUB_LOG_DIR"])
    state = os.environ.get("XDG_STATE_HOME") or Path.home() / ".local" / "state"
    return Path(state) / "agent-hub" / "logs"


def threshold():
    level = os.environ.get("AGENT_HUB_LOG_LEVEL")
    if level in LEVELS:
        return LEVELS[level]
    return LEVELS["debug"] if os.environ.get("AGENT_HUB_DEBUG") == "1" else LEVELS["info"]


def _fields(fields):
    out = {}
    for k, v in fields.items():
        if v is None:
            continue
        if isinstance(v, BaseException):
            out["err"] = str(v) or type(v).__name__
            out["errType"] = type(v).__name__
            if v.__traceback__ is not None:
                out["stack"] = "".join(traceback.format_exception(type(v), v, v.__traceback__)).rstrip()
        else:
            out[k] = v
    return out


def with_session(fields):
    """The Claude session a line was written under, so it leads back to the
    transcript. Only programs Claude runs (hooks, skill scripts) have one."""
    session = os.environ.get("CLAUDE_CODE_SESSION_ID")
    if session and fields.get("claude_session") is None:
        return {**fields, "claude_session": session}
    return fields


def format_line(level, component, message, fields=None, now=None):
    now = now or datetime.now(UTC)
    stamp = now.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    try:
        data = json.dumps(_fields(fields or {}), separators=(",", ":"), ensure_ascii=False, default=str)
    except (TypeError, ValueError) as e:
        data = json.dumps({"logError": f"fields not serializable: {e}"}, separators=(",", ":"))
    return f"{stamp} {level.upper()} {component}: {message} {data}"


_writes = {}


def _write(component, line):
    try:
        folder = log_dir()
        folder.mkdir(parents=True, exist_ok=True)
        path = folder / f"{component}.log"
        count = _writes.get(component, 0)
        _writes[component] = count + 1
        if count % CHECK_EVERY == 0:
            try:
                if path.stat().st_size > MAX_BYTES:
                    path.replace(path.with_name(path.name + ".1"))
            except OSError:
                pass  # No file yet: nothing to rotate.
        with open(path, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except OSError:
        pass  # A log that can't be written mustn't break what it describes.


class Logger:
    """A logger for one component. Each level takes a fixed message and the
    values as keyword arguments; `span` traces an operation's start, end and
    failure; `child` adds fields to every line."""

    def __init__(self, component, base=None):
        self.component = component
        self.base = base or {}

    def enabled(self, level):
        return LEVELS[level] >= threshold()

    def _at(self, level, message, fields):
        if LEVELS[level] < threshold():
            return
        _write(self.component, format_line(level, self.component, message, with_session({**self.base, **fields})))

    def log(self, level, message, **fields):
        """At a level chosen at run time: "debug", "info", "warn" or "error"."""
        self._at(level, message, fields)

    def debug(self, message, **fields):
        self._at("debug", message, fields)

    def info(self, message, **fields):
        self._at("info", message, fields)

    def warning(self, message, **fields):
        self._at("warn", message, fields)

    warn = warning

    def error(self, message, **fields):
        self._at("error", message, fields)

    def child(self, **fields):
        return Logger(self.component, {**self.base, **fields})

    def span(self, name, level="info", **fields):
        """with log.span("poll", pr=key): ... logs the start at debug, the end
        at `level` with ms, and a failure at error with err, then re-raises."""
        return _Span(self, name, level, fields)


class _Span:
    def __init__(self, log, name, level, fields):
        self.log, self.name, self.level, self.fields = log, name, level, fields

    def __enter__(self):
        self.started = time.monotonic()
        self.log._at("debug", f"{self.name} start", self.fields)
        return self

    def __exit__(self, kind, error, _tb):
        ms = round((time.monotonic() - self.started) * 1000)
        if error is None:
            self.log._at(self.level, f"{self.name} done", {**self.fields, "ms": ms})
        else:
            self.log._at("error", f"{self.name} failed", {**self.fields, "ms": ms, "err": error})
        return False


def logger(component, **base):
    return Logger(component, base)
