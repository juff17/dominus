"""Approvals: an action an agent proposes that goes out under the user's name
runs only once the user approves it in the Alt+A popup or the Agents tray.

A proposal is one JSON file in $XDG_RUNTIME_DIR/agent-hub/approvals/,
holding exactly what will run, and the `script` that settles it. Each skill
that proposes things has its own approval.py for its own kinds (pr-babysit's
replies, pushes and jobs; review's PR comments; test's Jira comment); the tray
and Alt+A run the one a proposal names. This is what they share: the store,
one approval at a time, the time limit the tray holds them to, settling a
proposal, the forge calls, and the command line the tray speaks."""

import argparse
import contextlib
import json
import os
import re
import secrets
import signal
import subprocess
import time
from pathlib import Path

from agent_hub import files
from agent_hub import forge as hub_forge
from agent_hub import watch as hub_watch
from agent_hub.log import logger

LOGGER = logger("approval")

ROOT = files.runtime_dir() / "approvals"
LOG = ROOT / "log.jsonl"
RUNNING = "Already running"

emit = hub_watch.emitter(LOGGER)


# ------------------------------------------------------------ the store

def path_of(pid):
    if not re.fullmatch(r"[A-Za-z0-9_-]+", pid or ""):
        raise SystemExit(f"Not an approval id: {pid!r}")
    return ROOT / f"{pid}.json"


def load(pid):
    try:
        return json.loads(path_of(pid).read_text())
    except (OSError, ValueError):
        return None


def save(p):
    ROOT.mkdir(parents=True, exist_ok=True)
    files.write_atomic(path_of(p["id"]), json.dumps(p, indent=2), tmp=ROOT / f".{p['id']}.tmp")


def remove(pid):
    """Removes a proposal, unless an approval of it is running."""
    with locked(pid) as mine:
        if mine:
            path_of(pid).unlink(missing_ok=True)
        return mine


def every():
    out = []
    with contextlib.suppress(OSError):
        for f in sorted(ROOT.glob("*.json")):
            with contextlib.suppress(OSError, ValueError):
                out.append(json.loads(f.read_text()))
    return out


@contextlib.contextmanager
def locked(pid):
    """One approval runs once, however many buttons were pressed. Yields
    False when another process holds the proposal."""
    proposal = path_of(pid)
    ROOT.mkdir(parents=True, exist_ok=True)
    lock = ROOT / f"{pid}.lock"
    handle = files.try_lock(lock)
    if handle is None:
        LOGGER.warning("approval already running", id=pid)
        yield False
        return
    with handle:
        try:
            yield True
        finally:
            # files.try_lock lets the holder unlink it, so a lock outlives
            # its proposal only while held.
            if not proposal.exists():
                lock.unlink(missing_ok=True)


def new(kind, session, pr, script):
    """A proposal's common fields: who proposed it, from which pane, and the
    approval.py (`script`) that settles it."""
    return {"id": f"{int(time.time() * 1000)}-{kind}-{secrets.token_hex(3)}", "kind": kind,
            "at": int(time.time() * 1000), "session": session, "pr": pr, "status": "pending",
            "claude_session": os.environ.get("CLAUDE_CODE_SESSION_ID", ""), "pane": os.environ.get("TMUX_PANE", ""),
            # Which tmux server the pane is on: pane ids are unique only per server.
            "tmux": os.environ.get("TMUX", ""),
            "script": str(script)}


def replace_older(p):
    """A new proposal replaces an older one about the same thing, unless that
    one is being approved right now."""
    for old in every():
        if old.get("pr", {}).get("key") == p["pr"]["key"] and old.get("key") == p["key"] \
                and old.get("status") in ("pending", "failed") and not remove(old["id"]):
            raise SystemExit(f"{old['id']} is being approved right now; wait for its [approval] event")


# The tray and the Alt+A popup stop an approval at 180 s (APPROVAL_MS in
# ghostty/tray/approvals.ts) by killing its process group. Every step here
# fits inside this deadline instead, so none is cut off half way by that.
DEADLINE_S = 170
# What a step that sends something needs left to start: gh's own timeout
# (agent_hub.forge.run), which also covers a push.
SEND_S = 90
_deadline = None


def time_left():
    """Seconds until the running approval's deadline; plenty outside one."""
    return 3600 if _deadline is None else _deadline - time.monotonic()


def in_time(what):
    """Refuses to start a step that sends something unless it can finish
    before the deadline, so nothing goes out after the tray said it stopped."""
    if time_left() < SEND_S:
        raise RuntimeError(f"Ran out of time before {what}; nothing was sent")


class Stopped(Exception):
    """SIGTERM: the tray's time limit, or the popup closed."""


def _stopped(signum, frame):
    raise Stopped()


def log(p, result):
    ROOT.mkdir(parents=True, exist_ok=True)
    job = p.get("job") or {}
    entry = {"at": int(time.time() * 1000), "pr": p["pr"]["key"], "kind": p["kind"],
             "job": job.get("id"), "name": job.get("name"), "ok": result["ok"], "auto": result.get("auto", False),
             "claude_session": p.get("claude_session", "")}
    with open(LOG, "a") as f:
        f.write(json.dumps(entry) + "\n")


def history():
    """The log's entries. A line that doesn't parse (half written, edited by
    hand) is skipped alone, so the rest still limit auto retries."""
    try:
        lines = LOG.read_text().splitlines()
    except FileNotFoundError:
        return []
    except OSError as e:
        LOGGER.warning("history unreadable", path=str(LOG), err=e)
        return []
    out, bad = [], 0
    for line in lines:
        if not line.strip():
            continue
        try:
            entry = json.loads(line)
        except ValueError:
            entry = None
        if isinstance(entry, dict):
            out.append(entry)
        else:
            bad += 1
    if bad:
        LOGGER.warning("history lines skipped", path=str(LOG), count=bad)
    return out


# ------------------------------------------------------------ git and the forge

def git(cwd, *args):
    p = subprocess.run(["git", "-C", cwd, *args], capture_output=True, text=True, timeout=min(120, max(1, time_left())))
    if p.returncode != 0:
        err = (p.stderr or p.stdout).strip()
        raise RuntimeError(err.splitlines()[-1] if err else f"git {args[0]} failed")
    return p.stdout.strip()


def parse_url(url):
    """The forge and number of a PR or MR link."""
    host, path = hub_forge.split_url(url) or ("", "")
    m = re.match(r"(.+?)/pull/(\d+)", path)
    if m:
        return hub_forge.GitHub(host, m.group(1), log=LOGGER), int(m.group(2))
    m = re.match(r"(.+?)/-/merge_requests/(\d+)", path)
    if m:
        return hub_forge.GitLab(host, m.group(1), log=LOGGER), int(m.group(2))
    raise SystemExit(f"Not a PR or MR link: {url}")


def pr_info(url, parse=parse_url):
    forge, number = parse(url)
    github = isinstance(forge, hub_forge.GitHub)
    return {
        "key": f"{forge.host}/{forge.project}#{number}",
        "url": url,
        "host": forge.host,
        "project": forge.project,
        "number": number,
        "forge": "github" if github else "gitlab",
        "repo": forge.project.rsplit("/", 1)[-1],
        "ref": f"{'#' if github else '!'}{number}",
    }


def api(forge, path, method="GET", fields=None, typed=None):
    if method != "GET":
        in_time("sending it")
    cmd = [forge.cli, "api", "--hostname", forge.host, "-X", method, path]
    for k, v in (fields or {}).items():
        cmd += ["-f", f"{k}={v}"]
    for k, v in (typed or {}).items():
        cmd += ["-F", f"{k}={v}"]
    out = hub_forge.run(cmd, log=forge.log)
    return json.loads(out) if out.strip() else None


def head_now(forge, number):
    if isinstance(forge, hub_forge.GitHub):
        return forge.api(f"repos/{forge.project}/pulls/{number}")["head"]["sha"]
    return forge.api(f"{forge.proj()}/merge_requests/{number}")["sha"]


def token_hint(p):
    pr = p.get("pr") or {}
    return (hub_forge.GitHub if pr.get("forge") == "github" else hub_forge.GitLab)(pr.get("host", ""), "").login_hint()


# ------------------------------------------------------------ settling

def finish(p, status, ok, message, auto=False, **extra):
    fields = {"id": p["id"], "kind": p["kind"], "status": status, "ok": ok, "auto": auto, "text": message}
    if ok:
        LOGGER.info("proposal settled", **fields)
    else:
        LOGGER.error("proposal failed", **fields)
    p["status"] = status
    p.pop("running", None)
    p["result"] = {"ok": ok, "message": message, "at": int(time.time() * 1000), "auto": auto, **extra}
    # The session already heard about what it ran itself.
    p["reported"] = auto
    if path_of(p["id"]).exists():
        save(p)
    if status in ("done", "failed"):
        log(p, p["result"])
    return {"ok": ok, "message": message, "id": p["id"], "status": status}


def approve(pid, run, body=None, editable=(), before=None, auto=False):
    """Runs a proposal as proposed, once. `run(p)` sends it and returns what
    happened, or (that, extra result fields). A `body` replaces the text of an
    `editable` kind first. `before(p)` may settle it without running it (a
    hand-back to the session), by returning finish()'s result."""
    global _deadline
    with locked(pid) as mine:
        if not mine:
            return {"ok": False, "message": RUNNING, "id": pid}
        p = load(pid)
        if not p:
            return {"ok": False, "message": "That approval is gone"}
        if p["status"] not in ("pending", "failed"):
            return {"ok": False, "message": f"Already {p['status']}"}
        if body is not None and p["kind"] in editable and body != p.get("body"):
            p["body"], p["edited"] = body, True
        if before:
            settled = before(p)
            if settled is not None:
                return settled
        # `running` is cleared by finish(). Found here, with the lock now
        # ours, the run that wrote it was killed before it could say how far
        # it got, so it may have sent something: running it again blind could
        # post twice.
        if p.get("running"):
            LOGGER.warning("approval was cut off", id=pid, started=p["running"].get("at"))
            return finish(p, "failed", False, "An earlier approval of this was cut off part way; check the PR, then try again", auto)
        p["running"] = {"at": int(time.time() * 1000), "pid": os.getpid()}
        save(p)
        _deadline = time.monotonic() + DEADLINE_S
        # SIGTERM (the tray's limit, which signals the whole group, so git
        # and gh go too) is recorded as a failure rather than left `running`.
        previous = signal.signal(signal.SIGTERM, _stopped)
        extra, failed, message = {}, None, ""
        try:
            done = run(p)
            message, extra = done if isinstance(done, tuple) else (done, {})
        except Stopped:
            failed = "Stopped part way, past its time limit or with the popup closed; check the PR, then try again"
        except hub_forge.AuthError as e:
            failed = f"{token_hint(p)} ({e})"
        except (hub_forge.ApiError, RuntimeError, subprocess.TimeoutExpired, OSError) as e:
            failed = str(e)
        # Whatever else goes wrong must still reach the tray and the session.
        except Exception as e:
            failed = f"{type(e).__name__}: {e}"
        finally:
            signal.signal(signal.SIGTERM, previous)
            _deadline = None
        if failed is not None:
            return finish(p, "failed", False, failed, auto)
        return finish(p, "done", True, message, auto, **extra)


def reject(pid):
    with locked(pid) as mine:
        if not mine:
            return {"ok": False, "message": RUNNING, "id": pid}
        p = load(pid)
        if not p:
            return {"ok": False, "message": "That approval is gone"}
        if p["status"] != "pending":
            return {"ok": False, "message": f"Already {p['status']}"}
        return finish(p, "rejected", True, "Rejected")


def dismiss(pid):
    if not path_of(pid).exists():
        return {"ok": False, "message": "That approval is gone"}
    gone = remove(pid)
    return {"ok": gone, "message": "Dismissed" if gone else "It's being approved right now"}


# ------------------------------------------------------------ command line

def cli(argv, doc, kinds, propose_args, propose, approve_one, approve_args=None):
    """The command line every skill's approval.py speaks, as the tray and
    Alt+A call it: propose, approve [--body-file], reject, dismiss, list.
    `propose(args)` returns the exit code; `approve_one(pid, body, args)`
    returns approve()'s result."""
    ap = argparse.ArgumentParser(description=doc, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    pr = sub.add_parser("propose", help="ask the user to approve an action")
    pr.add_argument("kind", choices=kinds)
    pr.add_argument("url")
    pr.add_argument("--session", required=True, help="this agent's session id, the same on every proposal")
    propose_args(pr)
    ok = sub.add_parser("approve", help="run an approval as proposed")
    ok.add_argument("id")
    ok.add_argument("--body-file", help="post this file's text instead")
    if approve_args:
        approve_args(ok)
    no = sub.add_parser("reject", help="turn a proposal down")
    no.add_argument("id")
    gone = sub.add_parser("dismiss", help="forget a failed or pending proposal")
    gone.add_argument("id")
    sub.add_parser("list", help="every proposal, as JSON")
    args = ap.parse_args(argv)

    if args.cmd == "propose":
        return propose(args)
    if args.cmd == "approve":
        body = Path(args.body_file).read_text().rstrip("\n") if args.body_file else None
        result = approve_one(args.id, body, args)
    elif args.cmd == "reject":
        result = reject(args.id)
    elif args.cmd == "dismiss":
        result = dismiss(args.id)
    else:
        print(json.dumps(every(), indent=2))
        return 0
    print(json.dumps(result))
    return 0 if result["ok"] else 1
