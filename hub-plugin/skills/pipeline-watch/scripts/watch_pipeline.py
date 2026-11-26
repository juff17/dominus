#!/usr/bin/env python3
"""Watch one GitHub Actions workflow run or GitLab pipeline and print one line
per change, until it finishes (or, with --until fails, until a job fails).

The target is a pipeline URL
  https://github.com/<owner>/<repo>/actions/runs/<id>
  https://<gitlab host>/<group>/<project>/-/pipelines/<id>
or <host>/<project>@<ref>: the newest pipeline on that branch (or tag, or
full commit sha on GitHub) when the watch starts. A re-arm keeps watching
that same pipeline, not a newer one.

Polls through `gh api` / `glab api`, authenticated only by GITHUB_TOKEN (or
GH_TOKEN) / GITLAB_TOKEN. Read-only: it never runs, retries, cancels or
approves anything. What has been reported is kept in a cache file per
session, so re-arming the watcher never repeats an event.

Events: [watch] [setup] [auth] [busy] [error] [stage] [failed] [manual]
        [pipeline] [stopped] [unwatched]

[stage], [failed], [manual] and [pipeline] end with "| <progress>": every
stage in pipeline order with its state, e.g. "build ✓ · test ⏳ · deploy".
A [manual] wait, a finished pipeline, and the failure that ends an
--until fails watch also put a Needs-you note in the Agents tray.
"""

import argparse
import math
import re
import subprocess
import sys
import time
from pathlib import Path

# The skills share the plugin's lib/py, found from this file's real path.
sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "lib" / "py"))
from agent_hub import forge as hub_forge
from agent_hub import notes as tray_notes
from agent_hub import settings as hub_settings
from agent_hub import stops
from agent_hub import watch as hub_watch
from agent_hub.forge import ApiError, AuthError, duration, progress, stages
from agent_hub.log import logger

LOG = logger("watch_pipeline")

INTERVAL = 30
SETTINGS = hub_settings.default_path()


def setting(key, default, low, high):
    return hub_settings.number(SETTINGS, key, default, low, high)


FORGES = {"github": hub_forge.GitHub, "gitlab": hub_forge.GitLab}


class SetupError(Exception):
    pass


emit = hub_watch.emitter(LOG)


def give_up(args, tag, msg):
    """The [setup] or [auth] line the watch ends on. A watch with a session
    may have been started from the Monitors popup with nobody reading the
    chat, so it also leaves a note in the Agents tray."""
    emit(tag, msg)
    if not args.once:
        tray_notes.tray_note(f"pipeline-watch {args.target}", f"Watch stopped: {msg}", LOG)
    return 2


def flat(text, limit=120):
    return hub_watch.flat(text, limit)


def parse_target(text, kind=None):
    """(forge, pipeline id or None, ref or None) for a pipeline URL or
    host/project@ref. `kind` ("github"/"gitlab") says which host a
    self-managed name is, when the name doesn't."""
    text = text.strip()
    bare = text if "://" in text else f"https://{text}"
    parts = hub_forge.split_url(bare)
    if not parts or not parts[1] or any(c.isspace() for c in text):
        raise SetupError(f"not a pipeline URL or host/project@ref: {text}")
    host, path = parts

    project, at, ref = path.partition("@")
    if at:
        project = project.strip("/")
        if "/" not in project or not ref or "/-/" in project:
            raise SetupError(f"not a pipeline URL or host/project@ref: {text}")
        cls = FORGES.get(kind) or hub_forge.for_host(host)
        if cls is None:
            raise SetupError(f"can't tell whether {host} is GitHub or GitLab: give the pipeline's URL, "
                             "or pass --forge github|gitlab")
        return cls(host, project, log=LOG), None, ref

    m = re.match(r"(.+?)/actions/runs/(\d+)(?:/|$)", path)
    if m:
        return hub_forge.GitHub(host, m.group(1), log=LOG), int(m.group(2)), None
    m = re.match(r"(.+?)/-/pipelines/(\d+)(?:/|$)", path)
    if m:
        return hub_forge.GitLab(host, m.group(1), log=LOG), int(m.group(2)), None
    if re.search(r"/pull/\d+|/-/merge_requests/\d+", path):
        raise SetupError(f"{text} is a PR or MR, not a pipeline: watch it with /pr-babysit, "
                         "or give its pipeline's URL")
    raise SetupError(f"not a pipeline URL or host/project@ref: {text}")


def resolve(forge, ref):
    found = forge.latest_run(ref) if isinstance(forge, hub_forge.GitHub) else forge.latest_pipeline(ref)
    if not found:
        raise SetupError(f"no pipeline on {ref} in {forge.host}/{forge.project}")
    return found["id"]


# A finished pipeline's result, in the words the events use.
GITHUB_RESULT = {"success": "passed", "neutral": "passed", "skipped": "skipped", "cancelled": "canceled"}
GITLAB_RESULT = {"success": "passed", "failed": "failed", "canceled": "canceled", "skipped": "skipped"}


def snapshot(forge, pid):
    """The pipeline and its jobs, the same shape from either host."""
    if isinstance(forge, hub_forge.GitHub):
        r = forge.workflow_run(pid)
        done = r["status"] == "completed"
        return {
            "id": pid,
            "url": r["html_url"],
            "name": r.get("name") or r.get("display_title") or f"run {pid}",
            "ref": r.get("head_branch") or "",
            "sha": r.get("head_sha") or "",
            "status": r["status"].replace("_", " "),
            "result": GITHUB_RESULT.get(r.get("conclusion"), "failed") if done else None,
            # A first-time contributor's run waits for a maintainer before any job starts.
            "approval": r["status"] == "action_required",
            "jobs": forge.run_jobs(pid),
        }
    p = forge.pipeline(pid)
    result = GITLAB_RESULT.get(p["status"])
    return {
        "id": pid,
        "url": p["web_url"],
        "name": p.get("name") or f"pipeline {pid}",
        "ref": p.get("ref") or "",
        "sha": p.get("sha") or "",
        "status": p["status"].replace("_", " "),
        "result": result,
        "approval": False,
        "jobs": forge.pipeline_jobs(pid),
    }


once = hub_watch.once


def title(forge, snap):
    return f"{forge.project.rsplit('/', 1)[-1]} {snap['ref'] or snap['name']}"


def report(forge, snap, state, until, note):
    """Prints what is new since the last poll. Returns why the watch is over
    ("finished" or "stopped"), or None to go on. `note(title, message)`
    puts a row in the Agents tray."""
    groups = stages(snap["jobs"])
    tail = f" | {progress(groups)}" if groups else ""
    # Stages that started or finished before this session first looked are
    # not news; the [watch] line's progress already shows them.
    first = not state.get("seen")
    state["seen"] = True

    if snap["approval"] and once(state, "run:approval"):
        emit("manual", f"workflow run \"{flat(snap['name'])}\" needs a maintainer's approval to run "
                       f"id=run:{snap['id']} {snap['url']}{tail}")
        note(title(forge, snap), "Workflow run needs approval to run")

    finished = snap["result"] is not None
    for g in groups:
        if g["started"] and once(state, f"stage:{g['name']}:started") and not (first or finished):
            emit("stage", f"{g['name']} started | {progress(groups, g['name'])}")
        if g["done"] and once(state, f"stage:{g['name']}:done") and not (first or finished):
            emit("stage", f"{g['name']} {g['status']} | {progress(groups, g['name'])}")

    stop_on = None
    for j in snap["jobs"]:
        optional = " (allowed to fail)" if j["allow_failure"] else ""
        if j["status"] == "failed" and once(state, f"{j['id']}:failed"):
            emit("failed", f"{j['name']}{optional} id={j['id']} {j['url']}{tail}")
        if j["status"] == "failed" and not j["allow_failure"] and stop_on is None:
            stop_on = j
        if j["status"] == "manual" and once(state, f"{j['id']}:manual"):
            what = ("is waiting for a deployment approval" if isinstance(forge, hub_forge.GitHub)
                    else "is waiting for someone to run it")
            optional = " (optional)" if j["allow_failure"] else ""
            emit("manual", f"{j['name']}{optional} {what} id={j['id']} {j['url']}{tail}")
            note(title(forge, snap), f"{j['job']} {what}")

    if finished:
        if once(state, f"pipeline:{snap['result']}"):
            counted = [j for j in snap["jobs"] if not j["allow_failure"]]
            failed = [j["name"] for j in counted if j["status"] == "failed"]
            detail = f", {len(failed)} of {len(counted)} jobs failed: {', '.join(failed)}" if failed else ""
            emit("pipeline", f"{snap['result']} \"{flat(snap['name'])}\" on {snap['ref']} at {snap['sha'][:8]}"
                             f"{duration(snap['jobs'])}{detail} {snap['url']}{tail}")
            note(title(forge, snap), f"Pipeline {snap['result']}")
        return "finished"
    if until == "fails" and stop_on is not None:
        if once(state, "stopped"):
            emit("stopped", f"{stop_on['name']} failed, so the watch ends as asked (until it fails) "
                            f"id={stop_on['id']} {stop_on['url']}{tail}")
            note(title(forge, snap), f"Pipeline failing: {stop_on['job']} failed")
        return "stopped"
    return None


# ------------------------------------------------------------------ state

def base_path(forge, pid, ref):
    target = str(pid) if pid else f"@{ref}"
    return hub_watch.cache_base("pipeline-watch", f"{forge.host}_{forge.project}_{target}", safe="A-Za-z0-9_.@-")


session_state = hub_watch.session_state
load_state = hub_watch.load_state
save_state = hub_watch.save_state


# ------------------------------------------------------------------ main

def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("target", help="pipeline URL, or host/project@ref")
    ap.add_argument("--until", choices=("finished", "fails"), default="finished",
                    help="stop when the pipeline finishes (default), or at the first failed job")
    ap.add_argument("--forge", choices=tuple(FORGES), help="which host a self-managed name in host/project@ref is")
    ap.add_argument("--interval", type=int, default=INTERVAL, help=f"seconds between polls (default {INTERVAL})")
    ap.add_argument("--session", help="watch session id; reuse it on every re-arm (required unless --once)")
    ap.add_argument("--once", action="store_true", help="poll once and print events; no lock, state not saved, no notes")
    args = ap.parse_args(argv)
    if not args.once and not args.session:
        ap.error("--session is required unless --once")
    if args.interval < 5:
        ap.error("--interval must be at least 5 seconds")
    if not args.once and stops.stopped_by_user([sys.argv[0], *(sys.argv[1:] if argv is None else argv)], LOG):
        emit("unwatched", "stopped by the user from Monitors; do not re-arm")
        return 0

    try:
        forge, pid, ref = parse_target(args.target, args.forge)
    except SetupError as e:
        return give_up(args, "setup", str(e))
    problem = forge.problem()
    if problem:
        return give_up(args, "setup", problem)

    if args.once:
        return watch(args, forge, pid, ref, None)
    base = base_path(forge, pid, ref)
    # One watcher per session, so a re-arm that overlaps the old one can't
    # tell an event twice.
    lock = hub_watch.take_lock(f"{base}.{args.session}.lock")
    if lock is None:
        emit("busy", f"{args.target} is already being watched by session {args.session}")
        return 2
    with lock:
        return watch(args, forge, pid, ref, session_state(base, args.session))


def watch(args, forge, pid, ref, path):
    """Polls until the watch is over; `path` is the session's state file,
    None with --once."""
    state = (load_state(path) if path else None) or {"events": set()}
    resumed = bool(state.get("pipeline"))

    log = LOG.child(target=args.target, session=args.session)
    try:
        if not state.get("pipeline"):
            state["pipeline"] = pid or resolve(forge, ref)
        snap = snapshot(forge, state["pipeline"])
    except SetupError as e:
        return give_up(args, "setup", str(e))
    except AuthError as e:
        return give_up(args, "auth", f"{forge.login_hint()} ({e})")
    except (ApiError, subprocess.TimeoutExpired, ValueError, KeyError, TypeError, AttributeError) as e:
        log.error("first poll failed", err=e)
        return give_up(args, "setup", f"cannot read the pipeline on {forge.host} through {forge.cli}: {e}")

    groups = stages(snap["jobs"])
    emit("watch", f"{'resumed' if resumed else 'attached'} {snap['url']} \"{flat(snap['name'], 80)}\" "
                  f"on {snap['ref']} at {snap['sha'][:8]}, {snap['status']}, "
                  f"until it {'fails' if args.until == 'fails' else 'finishes'}, polling every {args.interval}s"
                  f"{f' | {progress(groups)}' if groups else ''}")
    log.info("watch started", pipeline=state["pipeline"], until=args.until, interval=args.interval, once=args.once)

    def note(title, message):
        if not args.once:
            tray_notes.tray_note(title, message, log)

    failures = 0
    # Settings may hold a fraction; 2.5 failed polls means the third.
    # Failed polls in a row before [error] tells the user, as for pr-babysit;
    # it keeps retrying.
    error_after = math.ceil(setting("prBabysit.errorAfter", 5, 1, 20))
    while True:
        over = None
        if snap is not None:
            try:
                over = report(forge, snap, state, args.until, note)
                if path:
                    save_state(path, state)
            # A job of an unexpected shape, or a state file that can't be
            # written, is tried again next poll, not a crash.
            except (OSError, ValueError, KeyError, TypeError, AttributeError) as e:
                log.warning("report failed", err=e)
        if over:
            log.info("watch ended", why=over, result=snap["result"])
            return 0
        if args.once:
            return 0
        time.sleep(args.interval)
        try:
            started = time.monotonic()
            snap = snapshot(forge, state["pipeline"])
            failures = 0
            if log.enabled("debug"):
                log.debug("poll done", ms=round((time.monotonic() - started) * 1000), status=snap["status"])
        except AuthError as e:
            log.error("token refused", err=e)
            return give_up(args, "auth", f"{forge.login_hint()} ({e})")
        # Off the network, a 5xx, or a body of an unexpected shape: retried.
        except hub_watch.RETRYABLE as e:
            snap = None
            failures += 1
            log.warning("poll failed", failures=failures, err=e)
            if failures == error_after:
                emit("error", f"API calls failed {error_after} polls in a row, still retrying: {e}")


if __name__ == "__main__":
    sys.exit(main())
