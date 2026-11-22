#!/usr/bin/env python3
"""Watch a GitHub PR or GitLab MR and print one line per event worth acting on.

Polls through `gh api` / `glab api`, authenticated only by GITHUB_TOKEN (or
GH_TOKEN) / GITLAB_TOKEN. What has been reported is kept in a cache file, so
re-arming the watcher after a Monitor timeout never repeats an event.

Events: [watch] [saved] [setup] [busy] [auth] [error] [push] [failed] [manual] [stuck]
        [stage] [pipeline] [behind] [conflict] [comment] [review] [merged] [closed]
        [unwatched]

Facts the babysitting agent must not lose (lease_sha, worktree, clone) are
kept with --set in a notes file beside the state, and printed again on the
[watch] line, so a re-arm or a summarized conversation gets them back.

Pipeline events end with "| <progress>": every stage in pipeline order with
its state, e.g. "CI ✓ · QA ⏳ · EU". A stage is a GitLab stage, or on GitHub
the part of the check name before " / " (a reusable workflow call).
"""

import argparse
import json
import math
import os
import re
import subprocess
import sys
import time
import urllib.parse
from pathlib import Path

# The skills share the plugin's lib/py, found from this file's real path.
sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "lib" / "py"))
from agent_hub import files, stops
from agent_hub import forge as hub_forge
from agent_hub import notes as tray_notes
from agent_hub import settings as hub_settings
from agent_hub.forge import (
    UNFINISHED,
    ApiError,
    AuthError,
    age_minutes,
    duration,
    parse_remote,
    progress,
    stages,
)
from agent_hub.log import logger

LOG = logger("watch_pr")

# The hub's Settings panel keeps the defaults for --interval, --stuck-after
# and what the babysitter may do on its own here (agent_hub/settings.py).
SETTINGS = hub_settings.default_path()


def setting(key, default, low, high):
    return hub_settings.number(SETTINGS, key, default, low, high)


def choice(key, default, allowed):
    return hub_settings.choice(SETTINGS, key, default, allowed)


def babysit_settings():
    """What Settings say the babysitting agent may do on its own, as the
    [settings] event tells it."""
    fix = choice("prBabysit.autoFix", True, (True, False))
    rebase = choice("prBabysit.autoRebase", "off", ("off", "clean", "always"))
    reply = choice("approvals.reply", "draft", ("off", "draft", "post"))
    return ", ".join([
        "auto-fix on" if fix else "auto-fix off: ask before fixing any comment",
        {"off": "auto rebase off: rebase only for a conflict or when the host requires it",
         "clean": "auto rebase when clean: rebase whenever behind, but abort and ask on a conflict",
         "always": "auto rebase always: rebase whenever behind, resolving conflicts"}[rebase],
        {"off": "replies off: never propose replies, keep them for the briefing",
         "draft": "replies drafted: propose each reply for approval",
         "post": "replies posted: propose each reply, it posts without asking"}[reply],
    ])


def tray_note(title, message):
    """A Needs-you row in the Agents tray, as notify.sh writes one."""
    tray_notes.tray_note(title, message, LOG)


APPROVAL_CHECK = 2


def approval_module():
    # approval.py imports this file, so it's imported here, not at the top.
    here = str(Path(__file__).resolve().parent)
    if here not in sys.path:
        sys.path.insert(0, here)
    import approval

    return approval


def approval_outcomes(forge, number, session):
    # A broken approvals folder mustn't end the watch; the next check tries
    # again, and the same error is told once.
    try:
        return approval_module().outcomes(f"{forge.host}/{forge.project}#{number}", session)
    except (OSError, ValueError, KeyError) as e:
        said = f"couldn't read the approvals folder: {e}"
        if said in TOLD:
            return []
        TOLD.add(said)
        return [said]


TOLD = set()


def emit(tag, msg):
    print(f"[{tag}] {msg}", flush=True)
    LOG.info("event", tag=tag, text=msg)


def flat(text, limit=240):
    text = " ".join((text or "").split())
    return text if len(text) <= limit else text[: limit - 1] + "…"


def run(cmd, cwd=None):
    return hub_forge.run(cmd, cwd, log=LOG)


class GitHub(hub_forge.GitHub):
    log = LOG

    def snapshot(self, number):
        pr = self.api(f"{self.repo()}/pulls/{number}")
        sha = pr["head"]["sha"]
        snap = {
            "state": "merged" if pr.get("merged") else ("closed" if pr["state"] == "closed" else "open"),
            "url": pr["html_url"],
            "title": pr["title"],
            "branch": pr["head"]["ref"],
            "base": pr["base"]["ref"],
            "sha": sha,
            "fork": (pr["head"].get("repo") or {}).get("full_name") != pr["base"]["repo"]["full_name"],
            "checks": [],
            "comments": [],
            "reviews": [],
        }
        if snap["state"] != "open":
            return snap

        ms = pr.get("mergeable_state")
        known = pr.get("mergeable") is not None and ms != "unknown"
        snap["conflict"] = ms == "dirty" if known else None
        snap["needs_rebase"] = ms == "behind" if known else None
        cmp = self.api(f"{self.repo()}/compare/{urllib.parse.quote(snap['base'])}...{sha}")
        snap["behind"] = cmp.get("behind_by", 0)

        for c in self.pages(f"{self.repo()}/commits/{sha}/check-runs", key="check_runs"):
            snap["checks"].append(self.check(c))
        for s in self.api(f"{self.repo()}/commits/{sha}/status").get("statuses", []):
            state = {"success": "success", "pending": "pending"}.get(s["state"], "failed")
            snap["checks"].append({
                "id": f"status:{s['context']}",
                "name": s["context"],
                "group": s["context"],
                "job": s["context"],
                "status": state,
                "url": s.get("target_url") or "",
                "waited": age_minutes(s.get("created_at")) if state == "pending" else 0,
                "started": s.get("created_at"),
                "finished": s.get("updated_at") if state != "pending" else None,
                "allow_failure": False,
            })
        # A run waiting for first-time-contributor approval has no check runs
        # yet. Environment approvals are already a "waiting" check run.
        runs = self.api(f"{self.repo()}/actions/runs?head_sha={sha}&per_page=100")
        for r in runs.get("workflow_runs", []):
            if r["status"] == "action_required":
                snap["checks"].append({
                    "id": f"run:{r['id']}",
                    "name": f"workflow {r['name']} ({r['status'].replace('_', ' ')})",
                    "status": "manual",
                    "url": r["html_url"],
                    "waited": 0,
                    "allow_failure": False,
                })

        for t in self.review_threads(number):
            line = t.get("line") or t.get("originalLine")
            for c in t["comments"]["nodes"]:
                author = c.get("author") or {}
                # GraphQL drops the "[bot]" suffix that REST logins carry.
                bot = "[bot]" if author.get("__typename") == "Bot" else ""
                snap["comments"].append({
                    "id": f"rc:{c['databaseId']}",
                    "author": author.get("login", "ghost") + bot,
                    "where": f"{t['path']}:{line}" if line else t["path"],
                    "body": c["body"],
                    "url": c["url"],
                    "resolved": t["isResolved"],
                })
        # Conversation comments and review summaries cannot be resolved, so
        # they always count as open.
        for c in self.pages(f"repos/{self.project}/issues/{number}/comments"):
            snap["comments"].append({
                "id": f"ic:{c['id']}",
                "author": c["user"]["login"],
                "where": "",
                "body": c["body"],
                "url": c["html_url"],
                "resolved": False,
            })
        for r in self.pages(f"{self.repo()}/pulls/{number}/reviews"):
            if r["state"] in ("APPROVED", "CHANGES_REQUESTED"):
                snap["reviews"].append({
                    "id": f"rv:{r['id']}",
                    "author": r["user"]["login"],
                    "state": r["state"].replace("_", " ").lower(),
                    "url": r["html_url"],
                })
            if r.get("body"):
                snap["comments"].append({
                    "id": f"rv:{r['id']}",
                    "author": r["user"]["login"],
                    "where": "review summary",
                    "body": r["body"],
                    "url": r["html_url"],
                    "resolved": False,
                })
        return snap

    THREADS_QUERY = """
    query($owner: String!, $name: String!, $number: Int!, $after: String) {
      repository(owner: $owner, name: $name) {
        pullRequest(number: $number) {
          reviewThreads(first: 100, after: $after) {
            pageInfo { hasNextPage endCursor }
            nodes {
              id isResolved path line originalLine
              comments(first: 100) { pageInfo { hasNextPage endCursor } nodes { databaseId author { login __typename } body url } }
            }
          }
        }
      }
    }"""

    THREAD_COMMENTS_QUERY = """
    query($id: ID!, $after: String) {
      node(id: $id) {
        ... on PullRequestReviewThread {
          comments(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { databaseId author { login __typename } body url } }
        }
      }
    }"""

    def graphql(self, query, **fields):
        cmd = [self.cli, "api", "graphql", "--hostname", self.host, "-f", f"query={query}"]
        for k, v in fields.items():
            # -F types numbers; -f keeps a cursor a string.
            cmd += ["-F" if isinstance(v, int) else "-f", f"{k}={v}"]
        return json.loads(run(cmd))["data"]

    def review_threads(self, number):
        # Resolved state exists only in GraphQL, not on the REST comments API.
        owner, name = self.project.split("/", 1)
        threads, after = [], None
        while True:
            fields = {"owner": owner, "name": name, "number": number, **({"after": after} if after else {})}
            page = self.graphql(self.THREADS_QUERY, **fields)["repository"]["pullRequest"]["reviewThreads"]
            for t in page["nodes"]:
                more = t["comments"]
                while (more.get("pageInfo") or {}).get("hasNextPage"):
                    more = self.graphql(self.THREAD_COMMENTS_QUERY, id=t["id"],
                                        after=more["pageInfo"]["endCursor"])["node"]["comments"]
                    t["comments"]["nodes"] += more["nodes"]
            threads += page["nodes"]
            if not page["pageInfo"]["hasNextPage"]:
                return threads
            after = page["pageInfo"]["endCursor"]

class GitLab(hub_forge.GitLab):
    log = LOG

    def snapshot(self, iid):
        mr = self.api(f"{self.proj()}/merge_requests/{iid}?include_diverged_commits_count=true")
        state = {"merged": "merged", "closed": "closed"}.get(mr["state"], "open")
        snap = {
            "state": state,
            "url": mr["web_url"],
            "title": mr["title"],
            "branch": mr["source_branch"],
            "base": mr["target_branch"],
            "sha": mr["sha"],
            "fork": mr.get("source_project_id") != mr.get("target_project_id"),
            "checks": [],
            "comments": [],
            "reviews": [],
        }
        if state != "open":
            return snap

        dms = mr.get("detailed_merge_status")
        known = dms not in ("checking", "unchecked", "preparing", "approvals_syncing", None)
        snap["conflict"] = bool(mr.get("has_conflicts")) or dms == "conflict" if known else None
        snap["needs_rebase"] = dms == "need_rebase" if known else None
        snap["behind"] = mr.get("diverged_commits_count") or 0

        pipeline = mr.get("head_pipeline")
        if pipeline and pipeline.get("sha") == mr["sha"]:
            snap["checks"] += self.pipeline_jobs(pipeline["id"])

        for d in self.pages(f"{self.proj()}/merge_requests/{iid}/discussions"):
            for n in d["notes"]:
                if n.get("system"):
                    continue
                pos = n.get("position") or {}
                path = pos.get("new_path") or pos.get("old_path")
                line = pos.get("new_line") or pos.get("old_line")
                where = f"{path}:{line}" if path and line else (path or "")
                snap["comments"].append({
                    "id": f"note:{n['id']}",
                    "author": n["author"]["username"],
                    "where": where,
                    "body": n["body"],
                    "url": f"{mr['web_url']}#note_{n['id']}",
                    "resolved": bool(n.get("resolvable") and n.get("resolved")),
                })

        approvals = self.api(f"{self.proj()}/merge_requests/{iid}/approvals")
        for a in approvals.get("approved_by", []):
            user = a["user"]["username"]
            snap["reviews"].append({
                "id": f"approval:{user}",
                "author": user,
                "state": "approved",
                "url": mr["web_url"],
            })
        return snap

def parse_url(url):
    host, path = hub_forge.split_url(url) or ("", "")
    m = re.match(r"(.+?)/pull/(\d+)", path)
    if m:
        return GitHub(host, m.group(1)), int(m.group(2))
    m = re.match(r"(.+?)/-/merge_requests/(\d+)", path)
    if m:
        return GitLab(host, m.group(1)), int(m.group(2))
    emit("setup", f"not a PR or MR URL: {url}")
    sys.exit(2)


def find_remote(forge, cwd):
    try:
        out = run(["git", "remote", "-v"], cwd=cwd)
    except (ApiError, AuthError, OSError):
        return None
    # A remote's port is its ssh or https port, not the web one, so only the
    # host name is compared.
    want = (forge.host.partition(":")[0].lower(), forge.project.lower())
    for line in out.splitlines():
        name, url = line.split()[:2]
        host, project = parse_remote(url)
        if (host.lower(), project.lower()) == want:
            return name
    return None


def take_lock(base):
    base.parent.mkdir(parents=True, exist_ok=True)
    return files.try_lock(f"{base}.lock")


def preflight(forge):
    problem = forge.problem()
    if problem:
        emit("setup", problem)
        sys.exit(2)


def pr_base(forge, number):
    root = Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache")) / "pr-babysit"
    return root / re.sub(r"[^A-Za-z0-9_.-]", "_", f"{forge.host}_{forge.project}_{number}")


def session_state(base, session):
    """State file for this session. Other sessions' files for the PR (state and
    notes) are removed, so a new session starts clean and reports everything
    still open."""
    keep = (Path(f"{base}.{session}.json"), notes_path(base, session))
    for old in base.parent.glob(f"{base.name}.*.json"):
        if old not in keep:
            old.unlink(missing_ok=True)
    return keep[0]


# What the agent records with --set. A file apart from the state, because the
# running watcher rewrites the state on every poll and would undo a --set.
NOTE_KEYS = ("lease_sha", "worktree", "clone", "branch", "remote")


def notes_path(base, session):
    return Path(f"{base}.{session}.notes.json")


def load_notes(path):
    try:
        data = json.loads(path.read_text())
    except (OSError, ValueError):
        return {}
    return {k: v for k, v in data.items() if k in NOTE_KEYS and isinstance(v, str)}


def set_notes(path, pairs):
    notes = load_notes(path)
    for pair in pairs:
        key, sep, value = pair.partition("=")
        if not sep or key not in NOTE_KEYS:
            raise ValueError(f"--set takes KEY=VALUE with KEY one of {', '.join(NOTE_KEYS)}: {pair!r}")
        if value:
            notes[key] = value
        else:
            notes.pop(key, None)
    path.parent.mkdir(parents=True, exist_ok=True)
    files.write_atomic(path, json.dumps(files.with_session(notes)))
    return notes


def show_notes(notes):
    return ", ".join(f"{k} {notes[k]}" for k in NOTE_KEYS if k in notes)


def load_state(path):
    try:
        data = json.loads(path.read_text())
    except (OSError, ValueError):
        return None
    data["comments"] = set(data["comments"])
    data["events"] = set(data["events"])
    return data


def save_state(path, state):
    path.parent.mkdir(parents=True, exist_ok=True)
    out = dict(state, comments=sorted(state["comments"]), events=sorted(state["events"]))
    files.write_atomic(path, json.dumps(files.with_session(out)))


def once(state, key):
    if key in state["events"]:
        return False
    state["events"].add(key)
    return True


def report(snap, state, me, stuck_after):
    sha, short = snap["sha"], snap["sha"][:8]
    # Stages already finished when a head is first seen are not news.
    fresh = state.get("sha") != sha
    groups = stages(snap["checks"])
    line = progress(groups)
    tail = f" | {line}" if line else ""

    if state.get("sha") and state["sha"] != sha:
        emit("push", f"head moved to {short}")
    state["sha"] = sha

    behind, rebase, conflict = snap.get("behind"), snap.get("needs_rebase"), snap.get("conflict")
    if conflict is not None and conflict != state.get("conflict"):
        if conflict:
            emit("conflict", f"{snap['branch']} has merge conflicts with {snap['base']}")
        state["conflict"] = conflict
    lagging = bool(behind) or bool(rebase)
    if rebase is not None and (lagging, rebase) != tuple(state.get("lagging") or (False, False)):
        if lagging:
            need = ", and the host requires a rebase before merge" if rebase else ""
            emit("behind", f"{snap['branch']} is {behind} commit(s) behind {snap['base']}{need}")
        state["lagging"] = [lagging, rebase]

    blocking = [c for c in snap["checks"] if not c["allow_failure"]]
    for c in snap["checks"]:
        tag = None
        if c["status"] == "failed":
            tag = "failed"
        elif c["status"] == "manual" and not c["allow_failure"]:
            tag = "manual"
        if tag and once(state, f"{sha}:{c['id']}:{c['status']}"):
            note = " (allowed to fail)" if c["allow_failure"] else ""
            emit(tag, f"{c['name']}{note} id={c['id']} {c['url']}{tail}")
        if (c["status"] == "pending" and c["waited"] >= stuck_after
                and once(state, f"{sha}:{c['id']}:stuck")):
            emit("stuck", f"{c['name']} has waited {int(c['waited'])} min for a runner "
                          f"id={c['id']} {c['url']}{tail}")

    finished = bool(blocking) and not any(c["status"] in UNFINISHED for c in blocking)
    for g in groups:
        # The pipeline event carries the last stages, so they are not sent twice.
        if g["done"] and once(state, f"{sha}:stage:{g['name']}") and not (fresh or finished):
            emit("stage", f"{g['name']} {g['status']} for {short} | {progress(groups, g['name'])}")
            if choice("prBabysit.notifyStage", False, (True, False)):
                tray_note(f"{snap['branch']}: {g['name']} {g['status']}", progress(groups, g["name"]))
    if finished:
        failed = [c["name"] for c in blocking if c["status"] == "failed"]
        canceled = [c["name"] for c in blocking if c["status"] == "canceled"]
        result, names = ("failed", failed) if failed else ("canceled", canceled) if canceled else ("passed", [])
        if once(state, f"{sha}:pipeline:{result}"):
            detail = f": {', '.join(names)}" if names else ""
            emit("pipeline", f"{result} for {short}{duration(blocking)}, {len(names)} of "
                             f"{len(blocking)} checks {result if names else 'failed'}{detail}{tail}")

    for r in snap["reviews"]:
        if r["author"] != me and once(state, f"review:{r['id']}"):
            emit("review", f"@{r['author']} {r['state']} {r['url']}")

    for c in snap["comments"]:
        if c["resolved"] or c["id"] in state["comments"]:
            continue
        state["comments"].add(c["id"])
        if c["author"] == me:
            continue
        where = f" on {c['where']}" if c["where"] else ""
        emit("comment", f"@{c['author']}{where}: \"{flat(c['body'])}\" id={c['id']} {c['url']}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("url", help="PR or MR URL")
    ap.add_argument("-C", dest="cwd", default=".", help="local clone of the PR's repo (default: .)")
    interval = setting("prBabysit.interval", 60, 15, 600)
    stuck = setting("prBabysit.stuckAfter", 30, 5, 240)
    ap.add_argument("--interval", type=int, default=interval,
                    help=f"seconds between polls (default {interval}, from Settings)")
    ap.add_argument("--stuck-after", type=int, default=stuck,
                    help=f"minutes a job may wait for a runner before [stuck] (default {stuck}, from Settings)")
    ap.add_argument("--session", help="babysit session id; reuse it on every re-arm (required unless --once)")
    ap.add_argument("--once", action="store_true",
                    help="poll once and print events; no lock, state not saved")
    ap.add_argument("--set", action="append", metavar="KEY=VALUE",
                    help=f"save a fact for this session ({', '.join(NOTE_KEYS)}; empty VALUE clears it), "
                         "print what is saved, and exit; repeatable")
    args = ap.parse_args()
    if not args.once and not args.session:
        ap.error("--session is required unless --once")

    forge, number = parse_url(args.url)
    if args.set:
        if not args.session:
            ap.error("--set needs --session")
        try:
            notes = set_notes(notes_path(pr_base(forge, number), args.session), args.set)
        except ValueError as e:
            ap.error(str(e))
        emit("saved", show_notes(notes) or "nothing")
        return 0
    if not args.once and stops.stopped_by_user(sys.argv, LOG):
        emit("unwatched", "stopped by the user from Monitors; do not re-arm")
        return 0
    remote = find_remote(forge, args.cwd)
    if remote is None:
        emit("setup", f"{os.path.abspath(args.cwd)} has no git remote for {forge.host}/{forge.project}. "
                      "Run from a clone of that repo, or pass -C <path>.")
        sys.exit(2)
    preflight(forge)

    base = pr_base(forge, number)
    lock = None if args.once else take_lock(base)
    if not args.once and lock is None:
        emit("busy", f"{args.url} is already being babysat by another session")
        sys.exit(2)

    try:
        me = forge.me()
    except AuthError as e:
        emit("auth", f"{forge.login_hint()} ({e})")
        sys.exit(2)
    except (ApiError, subprocess.TimeoutExpired, ValueError, KeyError, TypeError) as e:
        emit("setup", f"cannot reach {forge.host} through {forge.cli}: {e}")
        sys.exit(2)

    path = None if args.once else session_state(base, args.session)
    state = (load_state(path) if path else None) or {"comments": set(), "events": set()}
    notes = load_notes(notes_path(base, args.session)) if path else {}

    failures, attached, said = 0, False, None
    # Settings may hold a fraction; 2.5 failed polls means the third.
    error_after = math.ceil(setting("prBabysit.errorAfter", 5, 1, 20))
    log = LOG.child(pr=f"{forge.host}/{forge.project}#{number}", session=args.session)
    log.info("watch started", interval=args.interval, stuckAfter=args.stuck_after, once=args.once)
    while True:
        try:
            started = time.monotonic()
            snap = forge.snapshot(number)
            if log.enabled("debug"):
                log.debug("poll done", ms=round((time.monotonic() - started) * 1000), sha=snap["sha"], state=snap["state"])
            failures = 0
            if not attached:
                fork = " (from a fork)" if snap["fork"] else ""
                emit("watch", f"{'resumed' if state.get('sha') else 'attached'} {snap['url']} "
                              f"\"{flat(snap['title'], 80)}\", branch {snap['branch']}{fork} -> {snap['base']}, "
                              f"head {snap['sha']}, remote {remote}, "
                              f"{sum(not c['resolved'] and c['author'] != me for c in snap['comments'])} open comment(s), polling every {args.interval}s"
                              f"{f' | saved: {show_notes(notes)}' if notes else ''}")
                attached = True
                # What approval.py needs to propose a push.
                if path and (notes.get("branch"), notes.get("remote")) != (snap["branch"], remote):
                    notes = set_notes(notes_path(base, args.session), [f"branch={snap['branch']}", f"remote={remote}"])
            if not args.once and babysit_settings() != said:
                said = babysit_settings()
                emit("settings", said)
            report(snap, state, me, args.stuck_after)
            if path:
                save_state(path, state)
            if snap["state"] != "open":
                # Nothing waiting on the user can still apply to a merged or
                # closed PR, so it leaves the tray and Monitors with the watch.
                try:
                    expired = approval_module().expire(f"{forge.host}/{forge.project}#{number}", snap["state"])
                except OSError as e:
                    expired = []
                    log.warning("proposals not expired", err=e)
                emit(snap["state"], snap["url"])
                log.info("watch ended", state=snap["state"], expired=len(expired))
                return 0
        except AuthError as e:
            emit("auth", f"{forge.login_hint()} ({e})")
            log.error("token refused", err=e)
            return 2
        # A body of an unexpected shape (None, a list) or a state file that
        # can't be written is retried like a failed call, not a crash.
        except (ApiError, subprocess.TimeoutExpired, ValueError, KeyError, IndexError, TypeError,
                AttributeError, OSError) as e:
            failures += 1
            log.warning("poll failed", failures=failures, err=e)
            if failures == error_after:
                emit("error", f"API calls failed {error_after} polls in a row, still retrying: {e}")
        if args.once:
            return 0
        # Approvals are reported within a couple of seconds, not a poll. One
        # that ran (a push, a retry) changed the PR, so it's polled at once
        # rather than showing the old head for up to a poll.
        for _ in range(max(1, int(args.interval // APPROVAL_CHECK))):
            settled = approval_outcomes(forge, number, args.session)
            for msg in settled:
                emit("approval", msg)
            if any(") approved" in msg for msg in settled):
                break
            time.sleep(min(APPROVAL_CHECK, args.interval))


if __name__ == "__main__":
    sys.exit(main())
