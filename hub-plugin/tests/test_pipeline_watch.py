"""pipeline-watch's watch_pipeline.py against a fake gh/glab on PATH
(tests/fixtures/pr_babysit/fake_forge.py): reading the target, the lines one
poll prints for a GitHub Actions run and a GitLab pipeline, a manual job or
deployment waiting (and its tray note), a failure, the finish, --until
fails, re-arming without repeats, and bad input. Nothing reaches the network,
the real CLIs, or the user's notes and cache."""

import copy
import importlib.util
import json
import os
import subprocess
import sys
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from babysit_harness import NOWHERE, Sandbox

SCRIPT = HERE.parent / "skills/pipeline-watch/scripts/watch_pipeline.py"

with mock.patch.dict(os.environ, NOWHERE):
    spec = importlib.util.spec_from_file_location("watch_pipeline", SCRIPT)
    wp = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(wp)

SHA = "c0ffee0011223344556677889900aabbccddeeff"

# ------------------------------------------------------------------ GitHub

GH_URL = "https://github.com/o/app/actions/runs/7001"
GH_RUN = "repos/o/app/actions/runs/7001"
GH_JOB = "https://github.com/o/app/actions/runs/7001/job"


def gh_job(id, name, status, conclusion=None, started=None, completed=None):
    return {"id": id, "name": name, "status": status, "conclusion": conclusion, "html_url": f"{GH_JOB}/{id}",
            "started_at": started, "completed_at": completed}


def gh_routes(status="in_progress", conclusion=None, jobs=None):
    return {
        GH_RUN: {"id": 7001, "name": "CI", "html_url": GH_URL, "head_branch": "main", "head_sha": SHA,
                 "status": status, "conclusion": conclusion},
        f"{GH_RUN}/jobs?filter=latest": {"jobs": jobs if jobs is not None else [
            gh_job(1, "lint", "completed", "success", "2026-11-09T10:00:00Z", "2026-11-09T10:02:00Z"),
            gh_job(2, "unit", "completed", "failure", "2026-11-09T10:00:00Z", "2026-11-09T10:06:00Z"),
            gh_job(3, "e2e", "in_progress", None, "2026-11-09T10:00:30Z"),
            gh_job(4, "deploy-staging", "waiting"),
        ]},
        "repos/o/app/actions/runs?branch=main&per_page=1": {"workflow_runs": [{"id": 7001}]},
    }


# ------------------------------------------------------------------ GitLab

GL_URL = "https://gitlab.com/grp/app/-/pipelines/900"
GL = "projects/grp%2Fapp"
GL_JOB = "https://gitlab.com/grp/app/-/jobs"


def gl_job(id, name, stage, status, started=None, finished=None, allow_failure=False):
    return {"id": id, "name": name, "stage": stage, "status": status, "allow_failure": allow_failure,
            "web_url": f"{GL_JOB}/{id}", "started_at": started, "finished_at": finished}


def gl_routes(status="running", jobs=None, latest=900):
    return {
        f"{GL}/pipelines/900": {"id": 900, "status": status, "ref": "main", "sha": SHA, "web_url": GL_URL},
        f"{GL}/pipelines/900/jobs": jobs if jobs is not None else [
            gl_job(11, "compile", "build", "success", "2026-11-09T10:00:00Z", "2026-11-09T10:04:00Z"),
            gl_job(12, "unit", "test", "running", "2026-11-09T10:04:10Z"),
            gl_job(13, "deploy:prod", "deploy", "created"),
        ],
        f"{GL}/pipelines/900/bridges": [],
        f"{GL}/pipelines?ref=main&order_by=id&sort=desc&per_page=1": [{"id": latest}],
    }


class Target(unittest.TestCase):
    def parsed(self, text, kind=None):
        forge, pid, ref = wp.parse_target(text, kind)
        return type(forge).__name__, forge.host, forge.project, pid, ref

    def test_pipeline_urls(self):
        self.assertEqual(self.parsed(GH_URL), ("GitHub", "github.com", "o/app", 7001, None))
        self.assertEqual(self.parsed(f"{GH_URL}/job/55"), ("GitHub", "github.com", "o/app", 7001, None))
        self.assertEqual(self.parsed(f"{GH_URL}/attempts/2"), ("GitHub", "github.com", "o/app", 7001, None))
        self.assertEqual(self.parsed("https://gitlab.internal:8443/a/b/c/-/pipelines/12/builds"),
                         ("GitLab", "gitlab.internal:8443", "a/b/c", 12, None))

    def test_host_project_at_ref(self):
        self.assertEqual(self.parsed("gitlab.com/grp/sub/app@main"), ("GitLab", "gitlab.com", "grp/sub/app", None, "main"))
        self.assertEqual(self.parsed("github.com/o/app@feature/x"), ("GitHub", "github.com", "o/app", None, "feature/x"))
        self.assertEqual(self.parsed("https://gitlab.com/grp/app@v1.2.0"), ("GitLab", "gitlab.com", "grp/app", None, "v1.2.0"))

    def test_a_self_managed_name_needs_forge(self):
        with self.assertRaisesRegex(wp.SetupError, r"can't tell whether git\.acme\.io is GitHub or GitLab"):
            wp.parse_target("git.acme.io/team/app@main")
        self.assertEqual(self.parsed("git.acme.io/team/app@main", "gitlab")[0], "GitLab")

    def test_bad_input_is_a_setup_error(self):
        for text in ("", "main", "https://github.com/o/app", "github.com/app@main", "gitlab.com/grp/app@",
                     "https://gitlab.com/grp/app/-/jobs/5", "github.com/o/app@main extra words"):
            with self.subTest(text), self.assertRaises(wp.SetupError):
                wp.parse_target(text)

    def test_a_pr_or_mr_url_points_at_pr_babysit(self):
        for url in ("https://github.com/o/app/pull/4", "https://gitlab.com/grp/app/-/merge_requests/9"):
            with self.assertRaisesRegex(wp.SetupError, "is a PR or MR, not a pipeline: watch it with /pr-babysit"):
                wp.parse_target(url)


class Cli(unittest.TestCase):
    """The script run as Monitor runs it, --once: no state, no notes."""

    def setUp(self):
        self.box = Sandbox(self)

    def watch(self, *argv, **env):
        env.setdefault("GITHUB_TOKEN", "dummy")
        env.setdefault("GITLAB_TOKEN", "dummy")
        r = subprocess.run([sys.executable, str(SCRIPT), *argv], capture_output=True, text=True,
                           env=self.box.env(**env), timeout=60)
        return r.returncode, r.stdout.splitlines(), r.stderr

    def test_a_github_run_with_a_failure_and_a_deployment_waiting(self):
        self.box.routes(gh_routes())
        code, lines, err = self.watch(GH_URL, "--once")
        self.assertEqual((code, err), (0, ""))
        tail = "| lint ✓ · unit ✗ · e2e ⏳ · deploy-staging ⏸"
        self.assertEqual(lines, [
            f'[watch] attached {GH_URL} "CI" on main at c0ffee00, in progress, until it finishes, polling every 30s {tail}',
            f"[failed] unit id=2 {GH_JOB}/2 {tail}",
            f"[manual] deploy-staging is waiting for a deployment approval id=4 {GH_JOB}/4 {tail}",
        ])
        # One poll is the run and its jobs, read-only.
        self.assertEqual(self.box.paths(), [("gh", "GET", GH_RUN), ("gh", "GET", f"{GH_RUN}/jobs?filter=latest&per_page=100&page=1")])
        self.assertFalse((self.box.run_dir / "agent-hub" / "notes").exists())

    def test_a_gitlab_pipeline_by_ref_with_a_manual_job(self):
        routes = gl_routes(status="manual", jobs=[
            gl_job(11, "compile", "build", "success", "2026-11-09T10:00:00Z", "2026-11-09T10:04:00Z"),
            gl_job(13, "deploy:prod", "deploy", "manual"),
            gl_job(14, "stop:review", "cleanup", "manual", allow_failure=True),
        ])
        self.box.routes(routes)
        code, lines, _ = self.watch("gitlab.com/grp/app@main", "--once")
        tail = "| build ✓ · deploy ⏸ · cleanup ⏸"
        self.assertEqual((code, lines), (0, [
            f'[watch] attached {GL_URL} "pipeline 900" on main at c0ffee00, manual, until it finishes, polling every 30s {tail}',
            f"[manual] deploy:prod (stage deploy) is waiting for someone to run it id=13 {GL_JOB}/13 {tail}",
            f"[manual] stop:review (stage cleanup) (optional) is waiting for someone to run it id=14 {GL_JOB}/14 {tail}",
        ]))

    def test_a_finished_pipeline_says_its_result_and_exits(self):
        self.box.routes(gl_routes(status="failed", jobs=[
            gl_job(11, "compile", "build", "success", "2026-11-09T10:00:00Z", "2026-11-09T10:04:00Z"),
            gl_job(12, "unit", "test", "failed", "2026-11-09T10:04:10Z", "2026-11-09T10:21:00Z"),
            gl_job(15, "lint", "test", "failed", "2026-11-09T10:04:10Z", "2026-11-09T10:05:00Z", allow_failure=True),
        ]))
        code, lines, _ = self.watch(GL_URL, "--once")
        tail = "| build ✓ · test ✗"
        self.assertEqual(code, 0)
        self.assertEqual(lines[1:], [
            f"[failed] unit (stage test) id=12 {GL_JOB}/12 {tail}",
            f"[failed] lint (stage test) (allowed to fail) id=15 {GL_JOB}/15 {tail}",
            f'[pipeline] failed "pipeline 900" on main at c0ffee00 in 21m, 1 of 2 jobs failed: unit (stage test) {GL_URL} {tail}',
        ])

    def test_setup_problems_exit_2_with_one_line(self):
        self.box.routes(gl_routes(latest=None) | {f"{GL}/pipelines?ref=gone&order_by=id&sort=desc&per_page=1": []})
        for argv, env, want in (
                (["https://github.com/o/app/pull/4"], {}, "[setup] https://github.com/o/app/pull/4 is a PR or MR"),
                (["gitlab.com/grp/app@gone"], {}, "[setup] no pipeline on gone in gitlab.com/grp/app"),
                (["https://gitlab.com/grp/app/-/pipelines/404"], {}, "[setup] cannot read the pipeline on gitlab.com through glab: HTTP 404"),
        ):
            with self.subTest(argv):
                code, lines, _ = self.watch(*argv, "--once", **env)
                self.assertEqual(code, 2)
                self.assertEqual(len(lines), 1, lines)
                self.assertTrue(lines[0].startswith(want), lines[0])

    def test_a_refused_token_is_auth(self):
        self.box.routes({GH_RUN: {"_exit": 1, "_stderr": "HTTP 401: Bad credentials (https://api.github.com/...)"}})
        code, lines, _ = self.watch(GH_URL, "--once")
        self.assertEqual((code, lines), (2, ["[auth] gh isn't logged in to github.com, or its token lacks a permission this needs. Run `gh auth login --hostname github.com` in a terminal (the README's Tokens section lists the permissions), then try again (HTTP 401: Bad credentials (https://api.github.com/...))"]))

    def test_session_is_required_unless_once(self):
        code, _, err = self.watch(GH_URL)
        self.assertEqual(code, 2)
        self.assertIn("--session is required unless --once", err)


class Stop(Exception):
    """Ends a watch the way Monitor's timeout does."""


class Polls(unittest.TestCase):
    """main() in process over several polls: each sleep serves the next
    state of the pipeline, and running out of states ends the watch as a
    Monitor timeout would, so it can be re-armed."""

    def setUp(self):
        self.box = Sandbox(self)
        self.box.patch_env(self, GITHUB_TOKEN="dummy", GITLAB_TOKEN="dummy",
                           CLAUDE_CODE_SESSION_ID="claude-1", TMUX_PANE="%3")

    def watch(self, target, *polls, argv=()):
        """Serves polls[0], then each later one after a sleep. Returns
        (exit code or "killed", lines)."""
        polls = list(polls)
        self.box.routes(polls.pop(0))

        def sleep(_):
            if not polls:
                raise Stop
            self.box.routes(polls.pop(0))

        out = []
        with mock.patch.object(wp.time, "sleep", side_effect=sleep), \
                mock.patch.object(wp, "emit", side_effect=lambda tag, msg: out.append(f"[{tag}] {msg}")):
            try:
                code = wp.main([target, "--session", "s1", *argv])
            except Stop:
                code = "killed"
        return code, out

    def notes(self):
        folder = self.box.run_dir / "agent-hub" / "notes"
        found = sorted(folder.glob("*.json")) if folder.exists() else []
        return [json.loads(p.read_text()) for p in found]

    def gl(self, status, *jobs):
        return gl_routes(status=status, jobs=list(jobs))

    def test_a_gitlab_pipeline_from_start_to_finish_and_a_rearm_repeats_nothing(self):
        build_run = gl_job(11, "compile", "build", "running", "2026-11-09T10:00:00Z")
        build_ok = gl_job(11, "compile", "build", "success", "2026-11-09T10:00:00Z", "2026-11-09T10:04:00Z")
        test_wait = gl_job(12, "unit", "test", "created")
        test_run = gl_job(12, "unit", "test", "running", "2026-11-09T10:04:10Z")
        test_ok = gl_job(12, "unit", "test", "success", "2026-11-09T10:04:10Z", "2026-11-09T10:10:00Z")
        deploy_wait = gl_job(13, "deploy:prod", "deploy", "created")
        deploy_manual = gl_job(13, "deploy:prod", "deploy", "manual")
        deploy_ok = gl_job(13, "deploy:prod", "deploy", "success", "2026-11-09T10:30:00Z", "2026-11-09T10:33:00Z")

        code, lines = self.watch(GL_URL,
                                 self.gl("running", build_run, test_wait, deploy_wait),
                                 self.gl("running", build_ok, test_run, deploy_wait),
                                 self.gl("manual", build_ok, test_ok, deploy_manual))
        self.assertEqual(code, "killed")
        self.assertEqual([line.split(" | ")[0] for line in lines], [
            f'[watch] attached {GL_URL} "pipeline 900" on main at c0ffee00, running, until it finishes, polling every 30s',
            "[stage] build passed",
            "[stage] test started",
            "[stage] test passed",
            f"[manual] deploy:prod (stage deploy) is waiting for someone to run it id=13 {GL_JOB}/13",
        ])
        self.assertEqual(lines[1], "[stage] build passed | build ✓ (compile) · test ⏳ · deploy")
        self.assertEqual([(n["title"], n["message"], n["session"], n["pane"]) for n in self.notes()],
                         [("app main", "deploy:prod is waiting for someone to run it", "claude-1", "%3")])

        # Re-armed: the same state again tells nothing new; the deploy then runs.
        code, lines = self.watch(GL_URL,
                                 self.gl("manual", build_ok, test_ok, deploy_manual),
                                 self.gl("success", build_ok, test_ok, deploy_ok))
        self.assertEqual(code, 0)
        self.assertEqual([line.split(" | ")[0] for line in lines], [
            f'[watch] resumed {GL_URL} "pipeline 900" on main at c0ffee00, manual, until it finishes, polling every 30s',
            f'[pipeline] passed "pipeline 900" on main at c0ffee00 in 33m {GL_URL}',
        ])
        self.assertEqual([n["message"] for n in self.notes()], ["deploy:prod is waiting for someone to run it", "Pipeline passed"])

        # Once more after the end: nothing but the [watch] line, and it exits.
        code, lines = self.watch(GL_URL, self.gl("success", build_ok, test_ok, deploy_ok))
        self.assertEqual((code, [line.split(" ")[:2] for line in lines]), (0, [["[watch]", "resumed"]]))

    def test_a_github_run_with_a_job_failing_mid_watch(self):
        start = gh_routes(jobs=[gh_job(1, "Build / compile", "in_progress", None, "2026-11-09T10:00:00Z"),
                                gh_job(2, "Test / unit", "queued")])
        failing = gh_routes(jobs=[gh_job(1, "Build / compile", "completed", "success", "2026-11-09T10:00:00Z", "2026-11-09T10:03:00Z"),
                                  gh_job(2, "Test / unit", "completed", "failure", "2026-11-09T10:03:00Z", "2026-11-09T10:08:00Z")])
        done = copy.deepcopy(failing)
        done[GH_RUN].update(status="completed", conclusion="failure")
        code, lines = self.watch(GH_URL, start, failing, done)
        self.assertEqual(code, 0)
        self.assertEqual(lines[1:], [
            "[stage] Build passed | Build ✓ (compile) · Test ✗",
            "[stage] Test started | Build ✓ · Test ✗ (unit)",
            "[stage] Test failed | Build ✓ · Test ✗ (unit)",
            f"[failed] Test / unit id=2 {GH_JOB}/2 | Build ✓ · Test ✗",
            f'[pipeline] failed "CI" on main at c0ffee00 in 8m, 1 of 2 jobs failed: Test / unit {GH_URL} | Build ✓ · Test ✗',
        ])
        self.assertEqual([n["message"] for n in self.notes()], ["Pipeline failed"])

    def test_until_fails_stops_at_the_first_blocking_failure_and_stays_stopped(self):
        flaky = gl_job(15, "lint", "test", "failed", "2026-11-09T10:00:00Z", "2026-11-09T10:01:00Z", allow_failure=True)
        unit_run = gl_job(12, "unit", "test", "running", "2026-11-09T10:00:00Z")
        unit_bad = gl_job(12, "unit", "test", "failed", "2026-11-09T10:00:00Z", "2026-11-09T10:05:00Z")
        e2e = gl_job(16, "e2e", "test", "running", "2026-11-09T10:00:00Z")
        code, lines = self.watch(GL_URL, self.gl("running", flaky, unit_run, e2e), self.gl("running", flaky, unit_bad, e2e),
                                 self.gl("running", flaky, unit_bad, e2e), argv=("--until", "fails"))
        self.assertEqual(code, 0)
        self.assertIn("until it fails", lines[0])
        self.assertEqual([line.split(" | ")[0] for line in lines[1:]], [
            f"[failed] lint (stage test) (allowed to fail) id=15 {GL_JOB}/15",
            f"[failed] unit (stage test) id=12 {GL_JOB}/12",
            f"[stopped] unit (stage test) failed, so the watch ends as asked (until it fails) id=12 {GL_JOB}/12",
        ])
        self.assertEqual([n["message"] for n in self.notes()], ["Pipeline failing: unit failed"])
        code, lines = self.watch(GL_URL, self.gl("running", flaky, unit_bad, e2e), argv=("--until", "fails"))
        self.assertEqual((code, len(lines)), (0, 1))

    def test_a_ref_watch_keeps_its_pipeline_when_a_newer_one_starts(self):
        first = gl_routes()
        self.assertEqual(self.watch("gitlab.com/grp/app@main", first)[0], "killed")
        newer = gl_routes(latest=901)
        code, lines = self.watch("gitlab.com/grp/app@main", newer)
        self.assertEqual(code, "killed")
        self.assertIn(f"resumed {GL_URL}", lines[0])
        self.assertNotIn(("glab", "GET", f"{GL}/pipelines/901"), self.box.paths())

    def test_a_first_time_contributor_run_waits_for_approval(self):
        routes = gh_routes(status="action_required", jobs=[])
        code, lines = self.watch(GH_URL, routes)
        self.assertEqual(code, "killed")
        self.assertEqual(lines[1], f'[manual] workflow run "CI" needs a maintainer\'s approval to run id=run:7001 {GH_URL}')
        self.assertEqual([n["message"] for n in self.notes()], ["Workflow run needs approval to run"])

    def test_failed_polls_are_retried_and_told_once(self):
        down = {GH_RUN: {"_exit": 1, "_stderr": "HTTP 502: Bad Gateway"}}
        code, lines = self.watch(GH_URL, gh_routes(), *[down] * 7)
        self.assertEqual(code, "killed")
        errors = [line for line in lines if line.startswith("[error]")]
        self.assertEqual(errors, ["[error] API calls failed 5 polls in a row, still retrying: HTTP 502: Bad Gateway"])

    def test_failed_polls_are_told_after_the_settings_count(self):
        self.box.settings.write_text(json.dumps({"prBabysit.errorAfter": 2}))
        down = {GH_RUN: {"_exit": 1, "_stderr": "HTTP 502: Bad Gateway"}}
        with mock.patch.object(wp, "SETTINGS", self.box.settings):
            _, lines = self.watch(GH_URL, gh_routes(), *[down] * 3)
        errors = [line for line in lines if line.startswith("[error]")]
        self.assertEqual(errors, ["[error] API calls failed 2 polls in a row, still retrying: HTTP 502: Bad Gateway"])

    def test_a_watch_that_cannot_start_leaves_a_tray_note(self):
        # Started from the Monitors popup, nobody may be reading the chat.
        code, lines = self.watch("gitlab.com/grp/app@gone", gl_routes()
                                 | {f"{GL}/pipelines?ref=gone&order_by=id&sort=desc&per_page=1": []})
        self.assertEqual((code, lines), (2, ["[setup] no pipeline on gone in gitlab.com/grp/app"]))
        self.assertEqual([(n["title"], n["message"]) for n in self.notes()],
                         [("pipeline-watch gitlab.com/grp/app@gone", "Watch stopped: no pipeline on gone in gitlab.com/grp/app")])

    def test_a_second_watcher_on_the_same_session_is_busy(self):
        base = wp.base_path(wp.GitHub("github.com", "o/app"), 7001, None)
        base.parent.mkdir(parents=True)
        held = wp.files.try_lock(f"{base}.s1.lock")
        self.addCleanup(held.close)
        code, lines = self.watch(GH_URL, gh_routes())
        self.assertEqual((code, lines), (2, [f"[busy] {GH_URL} is already being watched by session s1"]))


if __name__ == "__main__":
    unittest.main()
