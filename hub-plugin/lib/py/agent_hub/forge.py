"""GitHub and GitLab through the gh and glab CLIs, for the skill scripts that
watch them (pr-babysit's watch_pr.py, pipeline-watch's watch_pipeline.py).

Every call is `gh api` / `glab api --hostname <host>`, authenticated by the
CLI's own login for that host (`gh auth login`, `glab auth login`), or by a
token in the environment, which both CLIs prefer. No token is read here. This
module reads; nothing here retries, plays, cancels or approves a job.

Jobs come out of both hosts in one shape (see GitHub.check and GitLab.job),
so stages() and progress() read them the same way: a stage is a GitLab
stage, or on GitHub the part of a job's name before " / " (a reusable
workflow call)."""

import json
import re
import shutil
import subprocess
import time
import urllib.parse
from datetime import UTC, datetime

from agent_hub.log import logger

LOG = logger("forge")


class AuthError(Exception):
    """The host refused the token, or there was none."""


class ApiError(Exception):
    """Any other failed call; worth retrying."""


# A token that was refused, or none at all: gh and glab then ask you to log in.
REFUSED = re.compile(r"\b401\b|Bad credentials|Unauthorized|(gh|glab) auth login"
                     r"|(GH|GITHUB|GITLAB)_TOKEN environment variable", re.IGNORECASE)


def run(cmd, cwd=None, log=None):
    """stdout of cmd, or AuthError / ApiError carrying stderr's last line.
    The failure is logged whole to `log` (the calling script's logger)."""
    log = log or LOG
    started = time.monotonic()
    p = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=90)
    ms = round((time.monotonic() - started) * 1000)
    if p.returncode != 0:
        err = (p.stderr or p.stdout).strip()
        last = err.splitlines()[-1] if err else f"exit {p.returncode}"
        # The whole stderr, which an event line cuts to its last line.
        log.warning("command failed", cmd=cmd, exit=p.returncode, ms=ms, err=err[-4000:])
        if REFUSED.search(err):
            raise AuthError(last)
        raise ApiError(last)
    if log.enabled("debug"):
        log.debug("command ran", cmd=cmd, ms=ms)
    return p.stdout


DEFAULT_PORTS = {"https": 443, "http": 80}


def split_url(url):
    """(host, path) of a web URL, or None. The host keeps a port the URL
    names, as gh and glab need it in --hostname; the scheme's own is dropped."""
    u = urllib.parse.urlparse(url.strip())
    if not u.hostname:
        return None
    try:
        port = u.port
    except ValueError:
        return None
    host = u.hostname if port in (None, DEFAULT_PORTS.get(u.scheme)) else f"{u.hostname}:{port}"
    return host, u.path.strip("/")


def parse_remote(url):
    """(host, project) of a git remote, without its port."""
    url = url.strip()
    # Only a URL with a scheme has a port: in scp form (git@host:42/proj.git)
    # what follows the colon is the path.
    m = (re.match(r"^\w+://(?:[^@/]+@)?([^/:]+)(?::\d+)?/(.+?)(?:\.git)?/?$", url)
         or re.match(r"^(?:[^@/]+@)?([^/:]+):(?!//)(.+?)(?:\.git)?/?$", url))
    return (m.group(1), m.group(2)) if m else ("", "")


def when(iso):
    return datetime.fromisoformat(iso.replace("Z", "+00:00"))


def age_minutes(iso):
    if not iso:
        return 0
    return (datetime.now(UTC) - when(iso)).total_seconds() / 60


class Forge:
    cli = ""
    # Whose log a failed call goes to: the calling script's, when it says.
    log = LOG

    def __init__(self, host, project, log=None):
        self.host = host
        self.project = project
        if log is not None:
            self.log = log

    def api(self, path):
        out = run([self.cli, "api", "--hostname", self.host, path], log=self.log)
        return json.loads(out) if out.strip() else None

    def pages(self, path, key=None):
        items, page = [], 1
        sep = "&" if "?" in path else "?"
        while True:
            data = self.api(f"{path}{sep}per_page=100&page={page}")
            batch = data[key] if key else data
            items += batch
            if len(batch) < 100:
                return items
            page += 1

    def problem(self):
        """Why calls can't be made from here (the CLI missing), as a line to
        show the user, or None. A missing login shows on the first call, as an
        AuthError: see login_hint()."""
        if not shutil.which(self.cli):
            return f"{self.cli} is not installed. Install it, then start the watcher again."
        return None

    def login_hint(self):
        """What to tell the user when the host refused the CLI's login, or it
        has none there."""
        where = f" to {self.host}" if self.host else ""
        login = f"{self.cli} auth login" + (f" --hostname {self.host}" if self.host else "")
        return (f"{self.cli} isn't logged in{where}, or its token lacks a permission this needs. "
                f"Run `{login}` in a terminal (the README's Tokens section lists the permissions), "
                "then try again")


class GitHub(Forge):
    cli = "gh"

    def repo(self):
        return f"repos/{self.project}"

    def me(self):
        return self.api("user")["login"]

    @staticmethod
    def check_status(c):
        """A check run's or an Actions job's status and conclusion, as one of
        the shared job states."""
        if c["status"] == "in_progress":
            return "running"
        if c["status"] == "waiting":
            return "manual"
        if c["status"] != "completed":
            return "pending"
        return {
            "success": "success",
            "neutral": "success",
            "skipped": "skipped",
            "cancelled": "canceled",
            "stale": "canceled",
            "action_required": "manual",
        }.get(c.get("conclusion"), "failed")

    def check(self, c):
        """A check run (commits/<sha>/check-runs) or an Actions job
        (actions/runs/<id>/jobs) in the shared job shape."""
        group, _, job = c["name"].partition(" / ")
        return {
            "id": c["id"],
            "name": c["name"],
            "group": group,
            "job": job or group,
            "status": self.check_status(c),
            "url": c.get("html_url") or c.get("details_url") or "",
            "waited": age_minutes(c.get("started_at")) if c["status"] == "queued" else 0,
            "started": c.get("started_at"),
            "finished": c.get("completed_at"),
            "allow_failure": False,
        }

    def workflow_run(self, run_id):
        return self.api(f"{self.repo()}/actions/runs/{run_id}")

    def latest_run(self, ref):
        filt = f"head_sha={ref}" if re.fullmatch(r"[0-9a-f]{40}", ref) else f"branch={urllib.parse.quote(ref, safe='')}"
        runs = self.api(f"{self.repo()}/actions/runs?{filt}&per_page=1").get("workflow_runs") or []
        return runs[0] if runs else None

    def run_jobs(self, run_id):
        return [self.check(j) for j in self.pages(f"{self.repo()}/actions/runs/{run_id}/jobs?filter=latest", key="jobs")]


class GitLab(Forge):
    cli = "glab"

    JOB_STATUS = {
        "running": "running",
        "success": "success",
        "failed": "failed",
        "canceled": "canceled",
        "canceling": "canceled",
        "skipped": "skipped",
        "manual": "manual",
        "pending": "pending",
    }

    def proj(self):
        return f"projects/{urllib.parse.quote(self.project, safe='')}"

    def me(self):
        return self.api("user")["username"]

    def job(self, j, url):
        # created, scheduled, waiting_for_resource, etc. wait on other jobs,
        # not on a runner, so they never count as stuck.
        status = self.JOB_STATUS.get(j["status"], "waiting")
        queued = j.get("queued_duration") if status == "pending" else None
        return {
            "id": j["id"],
            "name": f"{j['name']} (stage {j['stage']})",
            "group": j["stage"],
            "job": j["name"],
            "status": status,
            "url": url,
            "waited": (queued or 0) / 60,
            "started": j.get("started_at"),
            "finished": j.get("finished_at"),
            "allow_failure": j.get("allow_failure", False),
        }

    def pipeline(self, pipeline_id):
        return self.api(f"{self.proj()}/pipelines/{pipeline_id}")

    def latest_pipeline(self, ref):
        found = self.api(f"{self.proj()}/pipelines?ref={urllib.parse.quote(ref, safe='')}"
                         "&order_by=id&sort=desc&per_page=1") or []
        return found[0] if found else None

    def pipeline_jobs(self, pipeline_id):
        base = f"{self.proj()}/pipelines/{pipeline_id}"
        jobs = [self.job(j, j["web_url"]) for j in self.pages(f"{base}/jobs")]
        # Child pipelines appear as bridge jobs; their own jobs are not listed.
        for b in self.pages(f"{base}/bridges"):
            down = b.get("downstream_pipeline") or {}
            jobs.append(self.job(b, down.get("web_url") or b["web_url"]))
        return jobs


def for_host(host):
    """GitHub or GitLab from a host name alone, or None when the name doesn't
    say (a self-managed host with its own name)."""
    name = host.partition(":")[0].lower()
    if name == "github.com" or "github" in name.split(".")[0]:
        return GitHub
    if name == "gitlab.com" or "gitlab" in name.split(".")[0]:
        return GitLab
    return None


# ------------------------------------------------------------------ stages

UNFINISHED = ("waiting", "pending", "running", "manual")
MARK = {"passed": "✓", "failed": "✗", "canceled": "⊘", "running": "⏳", "manual": "⏸", "waiting": ""}


def stages(checks):
    """Group jobs into stages, in pipeline order (by first job id)."""
    groups = {}
    for c in checks:
        if c.get("group"):
            groups.setdefault(c["group"], []).append(c)

    def first_id(jobs):
        ids = [j["id"] for j in jobs if isinstance(j["id"], int)]
        return min(ids) if ids else float("inf")

    out = []
    for name, jobs in sorted(groups.items(), key=lambda g: first_id(g[1])):
        counted = [j for j in jobs if not j["allow_failure"]] or jobs
        seen = {j["status"] for j in counted}
        if seen <= {"skipped"}:
            continue
        if "failed" in seen:
            status = "failed"
        elif seen & {"running", "pending"}:
            status = "running"
        elif "manual" in seen:
            status = "manual"
        elif "waiting" in seen:
            status = "waiting"
        elif "canceled" in seen:
            status = "canceled"
        else:
            status = "passed"
        out.append({
            "name": name,
            "status": status,
            "done": not seen & set(UNFINISHED),
            "started": any(j["status"] in ("running", "success", "failed", "canceled") or j.get("started")
                           for j in counted),
            "jobs": [j["job"] for j in jobs if j["status"] != "skipped"],
        })
    return out


def progress(groups, detail=None):
    """Every stage in order with its mark, e.g. "CI ✓ · QA ⏳ · EU"; the
    stage named `detail` also lists its jobs."""
    parts = []
    for g in groups:
        text = f"{g['name']} {MARK[g['status']]}".strip()
        if g["name"] == detail and g["jobs"] != [g["name"]]:
            text += f" ({', '.join(g['jobs'])})"
        parts.append(text)
    return " · ".join(parts)


def duration(checks):
    """" in 12m" or " in 1h 4m" from the first start to the last finish."""
    starts = [when(c["started"]) for c in checks if c.get("started")]
    ends = [when(c["finished"]) for c in checks if c.get("finished")]
    if not starts or not ends:
        return ""
    mins = int((max(ends) - min(starts)).total_seconds() // 60)
    return f" in {mins // 60}h {mins % 60}m" if mins >= 60 else f" in {max(mins, 1)}m"
