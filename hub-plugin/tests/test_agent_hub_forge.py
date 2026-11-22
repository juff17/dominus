"""agent_hub/forge.py, the GitHub and GitLab access pr-babysit and
pipeline-watch share: URL and remote parsing, telling the host apart, the
preflight checks, gh/glab failures, the shared job shape, and the pipeline
calls, against a fake gh/glab on PATH (tests/fixtures/pr_babysit/fake_forge.py)."""

import os
import sys
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "lib" / "py"))
from agent_hub import forge
from agent_hub.log import logger
from babysit_harness import Sandbox


class Urls(unittest.TestCase):
    def test_split_url_keeps_a_port_the_url_names(self):
        self.assertEqual(forge.split_url("https://gitlab.internal:8443/x/y/-/pipelines/3"),
                         ("gitlab.internal:8443", "x/y/-/pipelines/3"))
        self.assertEqual(forge.split_url("https://gitlab.internal:443/x/y/"), ("gitlab.internal", "x/y"))
        self.assertEqual(forge.split_url("http://ci.local:80/a/b"), ("ci.local", "a/b"))

    def test_split_url_refuses_what_has_no_host_or_a_bad_port(self):
        self.assertIsNone(forge.split_url("not a url"))
        self.assertIsNone(forge.split_url("https://gitlab.internal:99999/x/y"))

    def test_parse_remote_reads_ssh_https_and_scp_forms(self):
        for url, want in (("git@gitlab.com:grp/sub/app.git", ("gitlab.com", "grp/sub/app")),
                          ("ssh://git@gitlab.internal:2222/x/y.git", ("gitlab.internal", "x/y")),
                          ("https://github.com/o/app", ("github.com", "o/app")),
                          ("git@host:42/proj.git", ("host", "42/proj")),
                          ("nonsense", ("", ""))):
            self.assertEqual(forge.parse_remote(url), want, url)

    def test_for_host_goes_by_the_name_and_says_none_when_it_cannot_tell(self):
        self.assertIs(forge.for_host("github.com"), forge.GitHub)
        self.assertIs(forge.for_host("github.acme.com"), forge.GitHub)
        self.assertIs(forge.for_host("gitlab.com"), forge.GitLab)
        self.assertIs(forge.for_host("gitlab.internal:8443"), forge.GitLab)
        self.assertIsNone(forge.for_host("ci.example.com"))
        # Only the first label counts: a company called gitlabbers isn't a host kind.
        self.assertIsNone(forge.for_host("code.github-mirror.example.com"))


class Preflight(unittest.TestCase):
    def setUp(self):
        self.box = Sandbox(self)

    def test_a_missing_cli_or_token_is_one_line_for_the_user(self):
        gh = forge.GitHub("github.com", "o/app")
        with mock.patch.dict(os.environ, self.box.env(PATH=str(self.box.tools)), clear=True):
            self.assertEqual(gh.problem(), "gh is not installed. Install it, then start the watcher again.")
        with mock.patch.dict(os.environ, self.box.env(), clear=True):
            self.assertRegex(gh.problem(), r"^GH_TOKEN or GITHUB_TOKEN is not set\. Export it")
            self.assertRegex(forge.GitLab("gitlab.com", "g/app").problem(), r"^GITLAB_TOKEN is not set")
        with mock.patch.dict(os.environ, self.box.env(GITHUB_TOKEN="dummy"), clear=True):
            self.assertIsNone(gh.problem())

    def test_enterprise_github_also_takes_its_own_token(self):
        self.assertEqual(forge.GitHub("github.acme.com", "o/app").token_vars()[:2],
                         ["GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"])


class Run(unittest.TestCase):
    def test_refused_and_missing_tokens_are_auth_errors_and_the_rest_api_errors(self):
        for err in ("HTTP 401: Bad credentials", "glab auth login first",
                    "populate the GH_TOKEN environment variable with a token"):
            with self.assertRaises(forge.AuthError, msg=err):
                forge.run(["sh", "-c", 'printf "%s\n" "$1" >&2; exit 4', "sh", err])
        with self.assertRaisesRegex(forge.ApiError, "^HTTP 502$"):
            forge.run(["sh", "-c", "echo 'some detail' >&2; echo 'HTTP 502' >&2; exit 1"])
        self.assertEqual(forge.run(["sh", "-c", "echo ok"]), "ok\n")

    def test_a_failure_is_logged_to_the_callers_component(self):
        with mock.patch.dict(os.environ, {"AGENT_HUB_LOG_DIR": str(Sandbox(self).root / "logs")}):
            with self.assertRaises(forge.ApiError):
                forge.run(["sh", "-c", "echo nope >&2; exit 3"], log=logger("watch_test"))
            line = (Path(os.environ["AGENT_HUB_LOG_DIR"]) / "watch_test.log").read_text()
        self.assertIn(' WARN watch_test: command failed {"cmd":["sh","-c",', line)
        self.assertIn('"exit":3', line)


GH_RUN = "repos/o/app/actions/runs/7001"
GL = "projects/grp%2Fsub%2Fapp"


class Calls(unittest.TestCase):
    def setUp(self):
        self.box = Sandbox(self)
        self.box.patch_env(self, GITHUB_TOKEN="dummy", GITLAB_TOKEN="dummy")
        self.gh = forge.GitHub("github.com", "o/app")
        self.gl = forge.GitLab("gitlab.internal:8443", "grp/sub/app")

    def test_run_jobs_reads_every_page_of_the_latest_attempt_in_the_shared_shape(self):
        jobs = [{"id": 100 + i, "name": f"Build / step {i}", "status": "completed", "conclusion": "success",
                 "html_url": f"https://github.com/o/app/actions/runs/7001/job/{100 + i}",
                 "started_at": "2026-11-09T10:00:00Z", "completed_at": "2026-11-09T10:01:00Z"} for i in range(100)]
        last = {"id": 900, "name": "deploy", "status": "waiting", "conclusion": None,
                "html_url": "https://github.com/o/app/actions/runs/7001/job/900", "started_at": None, "completed_at": None}
        self.box.routes({
            f"{GH_RUN}/jobs?filter=latest&per_page=100&page=1": {"jobs": jobs},
            f"{GH_RUN}/jobs?filter=latest&per_page=100&page=2": {"jobs": [last]},
        })
        got = self.gh.run_jobs(7001)
        self.assertEqual(len(got), 101)
        self.assertEqual(got[0], {"id": 100, "name": "Build / step 0", "group": "Build", "job": "step 0",
                                  "status": "success", "url": "https://github.com/o/app/actions/runs/7001/job/100",
                                  "waited": 0, "started": "2026-11-09T10:00:00Z", "finished": "2026-11-09T10:01:00Z",
                                  "allow_failure": False})
        self.assertEqual((got[-1]["group"], got[-1]["job"], got[-1]["status"]), ("deploy", "deploy", "manual"))

    def test_latest_run_filters_by_branch_or_by_a_full_sha(self):
        sha = "a" * 40
        self.box.routes({
            "repos/o/app/actions/runs?branch=feat%2Fx&per_page=1": {"workflow_runs": [{"id": 7002}]},
            f"repos/o/app/actions/runs?head_sha={sha}&per_page=1": {"workflow_runs": []},
        })
        self.assertEqual(self.gh.latest_run("feat/x"), {"id": 7002})
        self.assertIsNone(self.gh.latest_run(sha))

    def test_gitlab_calls_carry_the_port_and_list_bridges_after_jobs(self):
        self.box.routes({
            f"{GL}/pipelines?ref=release%2F2.0&order_by=id&sort=desc&per_page=1": [{"id": 900}],
            f"{GL}/pipelines/900/jobs": [{"id": 5, "name": "unit", "stage": "test", "status": "created",
                                          "web_url": "https://gitlab.internal:8443/grp/sub/app/-/jobs/5"}],
            f"{GL}/pipelines/900/bridges": [{"id": 6, "name": "qa", "stage": "qa", "status": "running",
                                             "web_url": "https://gitlab.internal:8443/grp/sub/app/-/jobs/6",
                                             "downstream_pipeline": {"web_url": "https://gitlab.internal:8443/grp/qa/-/pipelines/1"}}],
        })
        self.assertEqual(self.gl.latest_pipeline("release/2.0"), {"id": 900})
        jobs = self.gl.pipeline_jobs(900)
        self.assertEqual([(j["id"], j["status"], j["url"]) for j in jobs], [
            (5, "waiting", "https://gitlab.internal:8443/grp/sub/app/-/jobs/5"),
            (6, "running", "https://gitlab.internal:8443/grp/qa/-/pipelines/1"),
        ])
        self.assertTrue(all(c["argv"][:3] == ["api", "--hostname", "gitlab.internal:8443"] for c in self.box.calls()))

    def test_no_pipeline_on_a_ref_is_none(self):
        self.box.routes({f"{GL}/pipelines?ref=main&order_by=id&sort=desc&per_page=1": []})
        self.assertIsNone(self.gl.latest_pipeline("main"))


def job(id, stage, status, allow_failure=False, started=None):
    return {"id": id, "name": f"j{id}", "group": stage, "job": f"j{id}", "status": status,
            "allow_failure": allow_failure, "started": started}


class Stages(unittest.TestCase):
    def test_a_stage_has_started_once_any_counted_job_has_run(self):
        groups = forge.stages([job(1, "build", "success"), job(2, "test", "running"), job(3, "test", "pending"),
                               job(4, "deploy", "manual"), job(5, "post", "waiting")])
        self.assertEqual([(g["name"], g["status"], g["started"], g["done"]) for g in groups], [
            ("build", "passed", True, True), ("test", "running", True, False),
            ("deploy", "manual", False, False), ("post", "waiting", False, False)])
        self.assertEqual(forge.progress(groups, "test"), "build ✓ · test ⏳ (j2, j3) · deploy ⏸ · post")

    def test_a_job_allowed_to_fail_does_not_decide_its_stage(self):
        groups = forge.stages([job(1, "test", "failed", allow_failure=True), job(2, "test", "success")])
        self.assertEqual((groups[0]["status"], groups[0]["done"]), ("passed", True))

    def test_duration_runs_from_the_first_start_to_the_last_finish(self):
        jobs = [{"started": "2026-11-09T10:00:00Z", "finished": "2026-11-09T10:30:00Z"},
                {"started": "2026-11-09T10:10:00Z", "finished": "2026-11-09T11:05:00Z"}]
        self.assertEqual(forge.duration(jobs), " in 1h 5m")
        self.assertEqual(forge.duration([{"started": "2026-11-09T10:00:00Z", "finished": None}]), "")


if __name__ == "__main__":
    unittest.main()
