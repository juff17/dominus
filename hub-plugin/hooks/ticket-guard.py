#!/usr/bin/env python3
"""PreToolUse hook (the tracker's transition and edit tools): holds a session
the hub started for a ticket to the ticket-work skill's tracker rules. It
allows one move per session and edits that set only the assignee, and denies
the rest with a reason the model reads.

A ticket session is one whose first prompt holds /dominus:ticket-work, which
is how the Tickets popup (Alt+J) starts it. Any other session is left alone.
A bug here must never block the user, so any error allows the call and logs."""

import fcntl
import json
import os
import re
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lib" / "py"))
from agent_hub.log import logger

LOG = logger("ticket_guard")
MARK = "/dominus:ticket-work"
MOVE, EDIT = "transitionJiraIssue", "editJiraIssue"
# editJiraIssue arguments that name the issue or shape the call, not a field it sets.
NOT_FIELDS = {"cloudId", "issueIdOrKey", "issueKey", "issueId", "contentFormat", "responseContentFormat",
              "notifyUsers", "returnIssue", "expand"}
# executeWrite runs a deferred tool by name, so a move or edit can come through it too.
INNER_NAME = ("toolName", "tool_name", "tool", "name")
INNER_ARGS = ("arguments", "args", "input", "toolInput", "params", "parameters")

MOVE_REASON = ("This session already moved the ticket once, and the ticket-work skill allows one move: to the "
               "started column. People move it on after review, so leave its status as it is. If the user wants "
               "it moved, tell them to move it in the tracker.")
EDIT_REASON = ("The ticket-work skill only sets the assignee, and this edit also sets {fields}. Leave the ticket's "
               "other fields as they are. If the user wants them changed, tell them to change them in the tracker.")


def parsed(value):
    """MCP clients sometimes pass an object argument as a JSON string."""
    if isinstance(value, str):
        try:
            return json.loads(value)
        except ValueError:
            return value
    return value


def unwrap(tool, args):
    """The tracker tool a call runs and its arguments, looking inside executeWrite."""
    name = tool.rsplit("__", 1)[-1]
    if name != "executeWrite":
        return name, args
    inner = next((args[k] for k in INNER_NAME if isinstance(args.get(k), str)), "")
    inner_args = next((parsed(args[k]) for k in INNER_ARGS if k in args), {})
    return inner.rsplit("__", 1)[-1], inner_args if isinstance(inner_args, dict) else {}


def entries(path):
    with open(path, encoding="utf-8") as f:
        for line in f:
            try:
                entry = json.loads(line)
            except ValueError:
                continue  # A half-written last line while Claude appends.
            if isinstance(entry, dict):
                yield entry


def blocks(entry):
    message = entry.get("message")
    content = message.get("content") if isinstance(message, dict) else None
    if isinstance(content, str):
        return [{"type": "text", "text": content}]
    return [b for b in content if isinstance(b, dict)] if isinstance(content, list) else []


def ticket_session(transcript):
    """Whether the first prompt the user (or the hub) sent holds the mark.
    Meta entries and tool results are user entries too, so they're skipped."""
    if not transcript:
        return False
    for entry in entries(transcript):
        if entry.get("type") != "user" or entry.get("isMeta"):
            continue
        texts = [b.get("text", "") for b in blocks(entry) if b.get("type") == "text"]
        if texts:
            return any(MARK in t for t in texts)
    return False


def failed(transcript, tool_use_id):
    """Whether a call's result came back as an error: the tracker refused it,
    or the user rejected it. A move that failed doesn't use up the one move."""
    if not tool_use_id or not transcript:
        return False
    for entry in entries(transcript):
        for b in blocks(entry):
            if b.get("type") == "tool_result" and b.get("tool_use_id") == tool_use_id:
                return bool(b.get("is_error"))
    return False


def set_fields(args):
    """The fields an editJiraIssue call sets, whichever shape it takes:
    {fields: {...}}, {update: {...}} or the fields at the top level."""
    keys = set()
    for k, v in args.items():
        if k in NOT_FIELDS:
            continue
        if k in ("fields", "update"):
            v = parsed(v)
            if isinstance(v, dict):
                keys |= set(v)
                continue
            if not v:
                continue
        keys.add(k)
    return keys


def state_file(session):
    run = os.environ.get("XDG_RUNTIME_DIR") or "/tmp"
    folder = Path(run) / "agent-hub" / "ticket-guard"
    folder.mkdir(parents=True, exist_ok=True)
    return folder / (re.sub(r"[^A-Za-z0-9_.-]", "_", session) + ".json")


def check_move(event, args, started):
    session = event.get("session_id")
    if not isinstance(session, str) or not session:
        raise ValueError("no session_id")
    transcript = event.get("transcript_path")
    issue = args.get("issueIdOrKey") or args.get("issueKey")
    move = parsed(args.get("transition"))
    transition = move.get("id") if isinstance(move, dict) else move
    # Locked, so two moves sent in one turn can't both read "none yet".
    fd = os.open(state_file(session), os.O_RDWR | os.O_CREAT, 0o600)
    with os.fdopen(fd, "r+", encoding="utf-8") as f:
        fcntl.flock(f, fcntl.LOCK_EX)
        text = f.read()
        moves = json.loads(text) if text.strip() else []
        done = [m for m in moves if not failed(transcript, m.get("toolUseId"))]
        if done:
            LOG.info("move denied", id=issue, transition=transition, before=done[0].get("id"),
                     ms=round((time.monotonic() - started) * 1000))
            return MOVE_REASON
        moves.append({"id": issue, "transition": transition, "toolUseId": event.get("tool_use_id"),
                      "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())})
        f.seek(0)
        f.truncate()
        json.dump(moves, f)
    LOG.info("move allowed", id=issue, transition=transition, ms=round((time.monotonic() - started) * 1000))
    return None


def check_edit(args, started):
    issue = args.get("issueIdOrKey") or args.get("issueKey")
    others = sorted(set_fields(args) - {"assignee"})
    ms = round((time.monotonic() - started) * 1000)
    if others:
        LOG.info("edit denied", id=issue, fields=others, ms=ms)
        return EDIT_REASON.format(fields=", ".join(others))
    LOG.info("edit allowed", id=issue, ms=ms)
    return None


def check(event, started):
    """The reason to deny the call, or None to let it through."""
    tool, args = event.get("tool_name"), event.get("tool_input")
    if not isinstance(tool, str) or not isinstance(args, dict):
        raise TypeError("tool_name or tool_input missing")
    name, args = unwrap(tool, args)
    if name not in (MOVE, EDIT):
        return None
    if not ticket_session(event.get("transcript_path")):
        LOG.debug("not a ticket session", tool=tool)
        return None
    return check_move(event, args, started) if name == MOVE else check_edit(args, started)


def main():
    started = time.monotonic()
    try:
        event = json.load(sys.stdin)
        if not isinstance(event, dict):
            raise TypeError("hook input is not an object")
        reason = check(event, started)
    except Exception as e:
        LOG.warning("check failed", err=e, ms=round((time.monotonic() - started) * 1000))
        return 0
    if reason:
        print(json.dumps({"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny",
                                                 "permissionDecisionReason": reason}}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
