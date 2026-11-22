"""pr-babysit's watch_pr.py, the forge side: what GitHub.snapshot and
GitLab.snapshot make of the API's JSON, paging, job and check states. The
JSON is hand-built from the API shapes the code reads
(tests/fixtures/pr_babysit/*.json) and served by a fake gh/glab on PATH."""

import copy
import sys
import unittest
from datetime import UTC, datetime
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
from babysit_harness import GH_SHA, GL_PROJ, GL_SHA, Sandbox, fixture, load_watch_pr

w = load_watch_pr()

NOW = datetime(2026, 11, 9, 11, 0, 0, tzinfo=UTC)


class Frozen(datetime):
    @classmethod
    def now(cls, tz=None):
        return NOW


class ForgeCase(unittest.TestCase):
    def setUp(self):
        self.box = Sandbox(self)
        self.box.patch_env(self, GITHUB_TOKEN="dummy", GITLAB_TOKEN="dummy")
        p = mock.patch.object(w, "SETTINGS", self.box.settings)
        p.start()
        self.addCleanup(p.stop)
        p = mock.patch.object(w.hub_forge, "datetime", Frozen)
        p.start()
        self.addCleanup(p.stop)

    def serve(self, routes):
        self.box.routes(routes)


# ------------------------------------------------------------------ GitHub

GH = "repos/u/gad"
CHECKS = f"{GH}/commits/{GH_SHA}/check-runs"
STATUS = f"{GH}/commits/{GH_SHA}/status"
RUNS = f"{GH}/actions/runs?head_sha={GH_SHA}&per_page=100"


def gh_check(id, name, status, url, started, finished, group=None, job=None):
    g, _, j = name.partition(" / ")
    return {"id": id, "name": name, "group": group or g, "job": job or j or g, "status": status, "url": url,
            "waited": 0, "started": started, "finished": finished, "allow_failure": False}


class GitHubSnapshot(ForgeCase):
    def setUp(self):
        super().setUp()
        self.routes = fixture("github_pr.json")
        self.serve(self.routes)
        self.gh = w.GitHub("github.com", "u/gad")

    def test_an_open_pr_becomes_the_full_snapshot(self):
        snap = self.gh.snapshot(91)
        run = "https://github.com/u/gad/actions/runs"
        self.assertEqual({k: v for k, v in snap.items() if k not in ("checks", "comments", "reviews")}, {
            "state": "open", "url": "https://github.com/u/gad/pull/91", "title": "Add pagination to the list endpoint",
            "branch": "feat/pagination", "base": "main", "sha": GH_SHA, "fork": False,
            "conflict": False, "needs_rebase": True, "behind": 3,
        })
        self.assertEqual(snap["checks"], [
            gh_check(101, "CI / lint", "success", f"{run}/1/job/101", "2026-11-09T10:00:00Z", "2026-11-09T10:03:00Z"),
            gh_check(102, "CI / unit", "failed", f"{run}/1/job/102", "2026-11-09T10:00:00Z", "2026-11-09T10:12:00Z"),
            gh_check(103, "QA / e2e", "running", f"{run}/2/job/103", "2026-11-09T10:12:30Z", None),
            # No html_url: the details_url stands in.
            gh_check(104, "QA / smoke", "pending", "https://ci.example.com/smoke/104", None, None),
            gh_check(105, "Deploy / staging", "manual", f"{run}/3/job/105", None, None),
            # A name without " / " is its own group and job.
            gh_check(106, "docs", "skipped", f"{run}/4/job/106", "2026-11-09T10:00:00Z", "2026-11-09T10:00:00Z"),
            gh_check(107, "CI / build", "canceled", f"{run}/1/job/107", "2026-11-09T10:00:00Z", "2026-11-09T10:01:00Z"),
            # Commit statuses: "error" is failed; a pending one has no finish time.
            {"id": "status:ci/jenkins", "name": "ci/jenkins", "group": "ci/jenkins", "job": "ci/jenkins",
             "status": "failed", "url": "https://jenkins.example.com/job/9", "waited": 0,
             "started": "2026-11-09T10:01:00Z", "finished": "2026-11-09T10:05:00Z", "allow_failure": False},
            {"id": "status:coverage", "name": "coverage", "group": "coverage", "job": "coverage",
             "status": "pending", "url": "", "waited": 0, "started": None, "finished": None, "allow_failure": False},
            {"id": "status:license/cla", "name": "license/cla", "group": "license/cla", "job": "license/cla",
             "status": "success", "url": "https://cla.example.com/u/gad/91", "waited": 0,
             "started": "2026-11-09T09:59:00Z", "finished": "2026-11-09T09:59:30Z", "allow_failure": False},
            # A workflow run waiting for approval: no group, job, started or
            # finished keys, so it never shows in the stage progress.
            {"id": "run:900", "name": "workflow Fork CI (action required)", "status": "manual",
             "url": f"{run}/900", "waited": 0, "allow_failure": False},
        ])
        pr = "https://github.com/u/gad/pull/91"
        self.assertEqual(snap["comments"], [
            {"id": "rc:2001", "author": "alice", "where": "src/api/list.py:42",
             "body": "This loads every row before slicing.\n\nUse LIMIT/OFFSET.", "url": f"{pr}#discussion_r2001", "resolved": False},
            {"id": "rc:2002", "author": "me", "where": "src/api/list.py:42", "body": "Will do.",
             "url": f"{pr}#discussion_r2002", "resolved": False},
            # line is null on an outdated thread: originalLine stands in.
            {"id": "rc:2003", "author": "bob", "where": "src/api/list.py:7", "body": "typo",
             "url": f"{pr}#discussion_r2003", "resolved": True},
            # GraphQL's Bot gets REST's "[bot]" suffix back; no line at all is the path alone.
            {"id": "rc:2004", "author": "coderabbitai[bot]", "where": "README.md", "body": "Consider documenting the page size.",
             "url": f"{pr}#discussion_r2004", "resolved": False},
            # A deleted account has a null author.
            {"id": "rc:2005", "author": "ghost", "where": "README.md", "body": "deleted user",
             "url": f"{pr}#discussion_r2005", "resolved": False},
            # REST logins keep their own "[bot]".
            {"id": "ic:5001", "author": "github-actions[bot]", "where": "", "body": "Coverage: 81%",
             "url": f"{pr}#issuecomment-5001", "resolved": False},
            {"id": "ic:5002", "author": "carol", "where": "", "body": "Can this land before Friday?",
             "url": f"{pr}#issuecomment-5002", "resolved": False},
            # A review with a body is also a comment; any state, even dismissed.
            {"id": "rv:7002", "author": "carol", "where": "review summary", "body": "Please add tests for page 2.",
             "url": f"{pr}#pullrequestreview-7002", "resolved": False},
            {"id": "rv:7004", "author": "erin", "where": "review summary", "body": "Superseded.",
             "url": f"{pr}#pullrequestreview-7004", "resolved": False},
        ])
        # Only approvals and change requests are reviews; COMMENTED and DISMISSED aren't.
        self.assertEqual(snap["reviews"], [
            {"id": "rv:7001", "author": "bob", "state": "approved", "url": f"{pr}#pullrequestreview-7001"},
            {"id": "rv:7002", "author": "carol", "state": "changes requested", "url": f"{pr}#pullrequestreview-7002"},
        ])

    def test_one_snapshot_makes_eight_calls_in_this_order(self):
        self.gh.snapshot(91)
        self.assertEqual(self.box.paths(), [
            ("gh", "GET", f"{GH}/pulls/91"),
            ("gh", "GET", f"{GH}/compare/main...{GH_SHA}"),
            ("gh", "GET", f"{CHECKS}?per_page=100&page=1"),
            ("gh", "GET", STATUS),
            ("gh", "GET", RUNS),
            ("gh", "GET", "graphql"),
            ("gh", "GET", f"{GH}/issues/91/comments?per_page=100&page=1"),
            ("gh", "GET", f"{GH}/pulls/91/reviews?per_page=100&page=1"),
        ])
        self.assertTrue(all(c["argv"][:3] == ["api", "--hostname", "github.com"]
                            for c in self.box.calls() if c["path"] != "graphql"))

    def test_the_graphql_call_carries_owner_name_and_number(self):
        self.gh.snapshot(91)
        argv = next(c["argv"] for c in self.box.calls() if c["path"] == "graphql")
        self.assertEqual(argv[:4], ["api", "graphql", "--hostname", "github.com"])
        # A name stays a string (-f) even when it's all digits; the number is typed (-F).
        self.assertEqual(argv[-6:], ["-f", "owner=u", "-f", "name=gad", "-F", "number=91"])

    def pr(self, **fields):
        self.routes[f"{GH}/pulls/91"].update(fields)
        self.serve(self.routes)

    def test_mergeable_state_sets_conflict_and_needs_rebase(self):
        for mergeable, state, want in ((True, "dirty", (True, False)), (False, "dirty", (True, False)),
                                       (True, "behind", (False, True)), (True, "clean", (False, False)),
                                       (True, "blocked", (False, False)), (True, "unstable", (False, False)),
                                       # Still being worked out: neither is known.
                                       (None, "behind", (None, None)), (True, "unknown", (None, None))):
            self.pr(mergeable=mergeable, mergeable_state=state)
            snap = self.gh.snapshot(91)
            self.assertEqual((snap["conflict"], snap["needs_rebase"]), want, (mergeable, state))

    def test_behind_comes_from_compare_and_the_base_is_quoted(self):
        self.pr(base={"ref": "release 1.x", "repo": {"full_name": "u/gad"}})
        self.routes[f"{GH}/compare/release%201.x...{GH_SHA}"] = {}
        self.serve(self.routes)
        # No behind_by in the answer: 0.
        self.assertEqual(self.gh.snapshot(91)["behind"], 0)

    def test_a_fork_is_a_different_or_deleted_head_repo(self):
        self.pr(head={"ref": "feat", "sha": GH_SHA, "repo": {"full_name": "alice/gad"}})
        self.assertTrue(self.gh.snapshot(91)["fork"])
        self.pr(head={"ref": "feat", "sha": GH_SHA, "repo": None})
        self.assertTrue(self.gh.snapshot(91)["fork"])

    def test_merged_and_closed_stop_after_the_pr_itself(self):
        for fields, state in (({"merged": True, "state": "closed"}, "merged"), ({"merged": False, "state": "closed"}, "closed")):
            self.box.reset_calls()
            self.pr(**fields)
            snap = self.gh.snapshot(91)
            self.assertEqual(snap["state"], state)
            self.assertEqual((snap["checks"], snap["comments"], snap["reviews"]), ([], [], []))
            self.assertNotIn("behind", snap)
            self.assertNotIn("conflict", snap)
            self.assertEqual(self.box.paths(), [("gh", "GET", f"{GH}/pulls/91")])

    def test_a_queued_check_counts_its_wait_from_started_at(self):
        runs = self.routes[CHECKS]["check_runs"]
        runs[3]["started_at"] = "2026-11-09T10:15:00Z"
        # A running check that started long ago is not waiting.
        runs[2]["started_at"] = "2026-11-09T09:00:00Z"
        self.serve(self.routes)
        checks = {c["id"]: c for c in self.gh.snapshot(91)["checks"]}
        self.assertEqual(checks[104]["waited"], 45.0)
        self.assertEqual(checks[103]["waited"], 0)

    def test_a_pending_status_counts_its_wait_from_created_at(self):
        self.routes[STATUS]["statuses"][1]["created_at"] = "2026-11-09T10:30:00Z"
        self.serve(self.routes)
        checks = {c["id"]: c for c in self.gh.snapshot(91)["checks"]}
        self.assertEqual(checks["status:coverage"]["waited"], 30.0)
        self.assertEqual(checks["status:coverage"]["started"], "2026-11-09T10:30:00Z")

    def test_review_threads_follow_the_cursor(self):
        page1 = copy.deepcopy(self.routes["graphql"])
        threads = page1["data"]["repository"]["pullRequest"]["reviewThreads"]
        threads["pageInfo"] = {"hasNextPage": True, "endCursor": "CUR1"}
        page2 = copy.deepcopy(page1)
        p2 = page2["data"]["repository"]["pullRequest"]["reviewThreads"]
        p2["pageInfo"] = {"hasNextPage": False, "endCursor": "CUR2"}
        p2["nodes"] = [{"isResolved": False, "path": "b.py", "line": 1, "originalLine": 1, "comments": {"nodes": [
            {"databaseId": 2101, "author": {"login": "zed", "__typename": "User"}, "body": "x", "url": "u"}]}}]
        self.routes["graphql"], self.routes["graphql?after=CUR1"] = page1, page2
        self.serve(self.routes)
        ids = [c["id"] for c in self.gh.snapshot(91)["comments"]]
        self.assertIn("rc:2101", ids)
        graphql = [c["argv"] for c in self.box.calls() if c["path"].startswith("graphql")]
        self.assertEqual(len(graphql), 2)
        self.assertNotIn("after=CUR1", graphql[0])
        self.assertEqual(graphql[1][-2:], ["-f", "after=CUR1"])

    def test_a_thread_past_100_comments_reads_the_rest_by_its_cursor(self):
        def nodes(start, n):
            return [{"databaseId": start + i, "author": {"login": "alice", "__typename": "User"}, "body": f"n{i}", "url": "u"}
                    for i in range(n)]
        self.routes["graphql"]["data"]["repository"]["pullRequest"]["reviewThreads"]["nodes"] = [
            {"id": "T1", "isResolved": False, "path": "a.py", "line": 1, "originalLine": 1,
             "comments": {"pageInfo": {"hasNextPage": True, "endCursor": "C1"}, "nodes": nodes(3000, 100)}}]
        self.routes["graphql?id=T1&after=C1"] = {"data": {"node": {"comments": {
            "pageInfo": {"hasNextPage": True, "endCursor": "C2"}, "nodes": nodes(3100, 100)}}}}
        self.routes["graphql?id=T1&after=C2"] = {"data": {"node": {"comments": {
            "pageInfo": {"hasNextPage": False, "endCursor": "C3"}, "nodes": nodes(3200, 5)}}}}
        self.serve(self.routes)
        comments = [c for c in self.gh.snapshot(91)["comments"] if c["id"].startswith("rc:")]
        self.assertEqual([c["id"] for c in comments], [f"rc:{3000 + i}" for i in range(205)])
        self.assertTrue(all(c["where"] == "a.py:1" for c in comments))
        self.assertEqual([c["path"] for c in self.box.calls() if c["path"].startswith("graphql")],
                         ["graphql", "graphql?id=T1&after=C1", "graphql?id=T1&after=C2"])

    def test_a_failing_call_raises_api_or_auth_errors(self):
        self.routes[STATUS] = {"_exit": 1, "_stderr": "HTTP 502: Bad Gateway"}
        self.serve(self.routes)
        with self.assertRaisesRegex(w.ApiError, "HTTP 502"):
            self.gh.snapshot(91)
        self.routes[STATUS] = {"_exit": 1, "_stderr": "HTTP 401: Bad credentials (https://api.github.com/...)"}
        self.serve(self.routes)
        with self.assertRaises(w.AuthError):
            self.gh.snapshot(91)

    def test_me_is_the_users_login(self):
        self.assertEqual(self.gh.me(), "me")
        self.assertEqual(self.box.paths(), [("gh", "GET", "user")])


class CheckStatus(unittest.TestCase):
    def test_each_github_status_and_conclusion(self):
        for status, conclusion, want in (
                ("in_progress", None, "running"), ("waiting", None, "manual"), ("queued", None, "pending"),
                ("requested", None, "pending"), ("pending", None, "pending"),
                ("completed", "success", "success"), ("completed", "neutral", "success"),
                ("completed", "skipped", "skipped"), ("completed", "cancelled", "canceled"),
                ("completed", "stale", "canceled"), ("completed", "action_required", "manual"),
                ("completed", "failure", "failed"), ("completed", "timed_out", "failed"),
                ("completed", "startup_failure", "failed"), ("completed", None, "failed")):
            self.assertEqual(w.GitHub.check_status({"status": status, "conclusion": conclusion}), want, (status, conclusion))

    def test_token_vars_differ_for_enterprise_hosts(self):
        self.assertEqual(w.GitHub("github.com", "u/gad").token_vars(), ["GH_TOKEN", "GITHUB_TOKEN"])
        self.assertEqual(w.GitHub("github.example.com", "u/gad").token_vars(),
                         ["GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"])
        self.assertEqual(w.GitLab("gitlab.com", "a/b").token_vars(), ["GITLAB_TOKEN"])


# ------------------------------------------------------------------ GitLab

MR = f"{GL_PROJ}/merge_requests/91?include_diverged_commits_count=true"
JOBS = f"{GL_PROJ}/pipelines/555/jobs"
BRIDGES = f"{GL_PROJ}/pipelines/555/bridges"


def gl_job(id, name, stage, status, url, started=None, finished=None, waited=0, allow_failure=False):
    return {"id": id, "name": f"{name} (stage {stage})", "group": stage, "job": name, "status": status, "url": url,
            "waited": waited, "started": started, "finished": finished, "allow_failure": allow_failure}


class GitLabSnapshot(ForgeCase):
    def setUp(self):
        super().setUp()
        self.routes = fixture("gitlab_mr.json")
        self.serve(self.routes)
        self.gl = w.GitLab("gitlab.com", "grp/sub/gad")

    def mr(self, **fields):
        self.routes[MR].update(fields)
        self.serve(self.routes)

    def test_an_open_mr_becomes_the_full_snapshot(self):
        snap = self.gl.snapshot(91)
        web = "https://gitlab.com/grp/sub/gad/-"
        mr = f"{web}/merge_requests/91"
        self.assertEqual({k: v for k, v in snap.items() if k not in ("checks", "comments", "reviews")}, {
            "state": "open", "url": mr, "title": "Add pagination to the list endpoint",
            "branch": "feat/pagination", "base": "main", "sha": GL_SHA, "fork": False,
            "conflict": False, "needs_rebase": True, "behind": 4,
        })
        self.assertEqual(snap["checks"], [
            gl_job(11, "compile", "build", "success", f"{web}/jobs/11", "2026-11-09T10:00:00.000Z", "2026-11-09T10:04:00.000Z"),
            gl_job(12, "lint", "test", "failed", f"{web}/jobs/12", "2026-11-09T10:04:10.000Z", "2026-11-09T10:05:00.000Z",
                   allow_failure=True),
            # queued_duration only counts while pending.
            gl_job(13, "unit", "test", "running", f"{web}/jobs/13", "2026-11-09T10:04:10.000Z"),
            gl_job(14, "e2e", "test", "pending", f"{web}/jobs/14", waited=2400.5 / 60),
            gl_job(15, "deploy:staging", "deploy", "manual", f"{web}/jobs/15"),
            # created (and any status not in the table) waits on other jobs.
            gl_job(16, "notify", "post", "waiting", f"{web}/jobs/16"),
            # No allow_failure key: False.
            gl_job(17, "cleanup", "post", "skipped", f"{web}/jobs/17"),
            # A bridge links to its downstream pipeline, else to itself.
            gl_job(18, "qa-suite", "qa", "running", "https://gitlab.com/grp/sub/qa/-/pipelines/777", "2026-11-09T10:04:30.000Z"),
            gl_job(19, "docs-trigger", "qa", "manual", f"{web}/jobs/19", allow_failure=True),
        ])
        self.assertEqual(snap["comments"], [
            {"id": "note:301", "author": "alice", "where": "src/api/list.py:42", "body": "This loads every row before slicing.",
             "url": f"{mr}#note_301", "resolved": False},
            {"id": "note:302", "author": "me", "where": "src/api/list.py:42", "body": "Will do.",
             "url": f"{mr}#note_302", "resolved": False},
            # System notes are skipped; old_path/old_line stand in for a removed line.
            {"id": "note:304", "author": "bob", "where": "src/old.py:5", "body": "typo",
             "url": f"{mr}#note_304", "resolved": True},
            # resolved counts only on a resolvable note.
            {"id": "note:305", "author": "carol", "where": "", "body": "Can this land before Friday?",
             "url": f"{mr}#note_305", "resolved": False},
            {"id": "note:306", "author": "dave", "where": "README.md", "body": "Document the page size.",
             "url": f"{mr}#note_306", "resolved": False},
        ])
        # Every approver is a review, the user too; report() leaves "me" out.
        self.assertEqual(snap["reviews"], [
            {"id": "approval:bob", "author": "bob", "state": "approved", "url": mr},
            {"id": "approval:me", "author": "me", "state": "approved", "url": mr},
        ])

    def test_one_snapshot_makes_five_calls_in_this_order(self):
        self.gl.snapshot(91)
        self.assertEqual(self.box.paths(), [
            ("glab", "GET", MR),
            ("glab", "GET", f"{JOBS}?per_page=100&page=1"),
            ("glab", "GET", f"{BRIDGES}?per_page=100&page=1"),
            ("glab", "GET", f"{GL_PROJ}/merge_requests/91/discussions?per_page=100&page=1"),
            ("glab", "GET", f"{GL_PROJ}/merge_requests/91/approvals"),
        ])

    def test_a_head_pipeline_for_an_older_sha_or_none_lists_no_jobs(self):
        for pipeline in ({"id": 555, "sha": "f" * 40}, None):
            self.box.reset_calls()
            self.mr(head_pipeline=pipeline)
            snap = self.gl.snapshot(91)
            self.assertEqual(snap["checks"], [])
            self.assertEqual(len(self.box.calls()), 3, pipeline)

    def test_detailed_merge_status_sets_conflict_and_needs_rebase(self):
        for dms, conflicts, want in (("mergeable", False, (False, False)), ("conflict", False, (True, False)),
                                     ("mergeable", True, (True, False)), ("need_rebase", False, (False, True)),
                                     ("not_approved", False, (False, False)), ("ci_still_running", False, (False, False)),
                                     ("checking", False, (None, None)), ("unchecked", True, (None, None)),
                                     ("preparing", False, (None, None)), ("approvals_syncing", False, (None, None)),
                                     (None, True, (None, None))):
            self.mr(detailed_merge_status=dms, has_conflicts=conflicts)
            snap = self.gl.snapshot(91)
            self.assertEqual((snap["conflict"], snap["needs_rebase"]), want, (dms, conflicts))

    def test_behind_is_the_diverged_count_or_zero(self):
        self.mr(diverged_commits_count=None)
        self.assertEqual(self.gl.snapshot(91)["behind"], 0)

    def test_state_and_fork(self):
        for state, want in (("opened", "open"), ("locked", "open"), ("merged", "merged"), ("closed", "closed")):
            self.mr(state=state)
            self.assertEqual(self.gl.snapshot(91)["state"], want, state)
        self.mr(state="opened", source_project_id=12)
        self.assertTrue(self.gl.snapshot(91)["fork"])

    def test_merged_stops_after_the_mr_itself(self):
        self.mr(state="merged")
        snap = self.gl.snapshot(91)
        self.assertEqual(self.box.paths(), [("glab", "GET", MR)])
        self.assertNotIn("conflict", snap)

    def test_me_is_the_username(self):
        self.assertEqual(self.gl.me(), "me")

    def test_the_project_path_is_quoted_whole(self):
        self.assertEqual(self.gl.proj(), "projects/grp%2Fsub%2Fgad")


class GitLabJob(unittest.TestCase):
    gl = w.GitLab("gitlab.com", "a/b")

    def job(self, **j):
        return self.gl.job(dict({"id": 1, "name": "unit", "stage": "test"}, **j), "URL")

    def test_each_job_status(self):
        for status, want in (("running", "running"), ("success", "success"), ("failed", "failed"),
                             ("canceled", "canceled"), ("canceling", "canceled"), ("skipped", "skipped"),
                             ("manual", "manual"), ("pending", "pending"), ("created", "waiting"),
                             ("scheduled", "waiting"), ("waiting_for_resource", "waiting"), ("preparing", "waiting"),
                             ("waiting_for_callback", "waiting")):
            self.assertEqual(self.job(status=status)["status"], want, status)

    def test_only_a_pending_job_has_waited(self):
        self.assertEqual(self.job(status="pending", queued_duration=90)["waited"], 1.5)
        self.assertEqual(self.job(status="pending", queued_duration=None)["waited"], 0)
        self.assertEqual(self.job(status="pending")["waited"], 0)
        self.assertEqual(self.job(status="created", queued_duration=9000)["waited"], 0)

    def test_the_url_is_the_one_passed_and_allow_failure_defaults_off(self):
        j = self.job(status="manual", allow_failure=True, web_url="ignored")
        self.assertEqual((j["url"], j["allow_failure"], j["name"], j["group"], j["job"]),
                         ("URL", True, "unit (stage test)", "test", "unit"))
        self.assertFalse(self.job(status="manual")["allow_failure"])


class Pages(ForgeCase):
    def test_pages_until_a_short_page(self):
        self.serve({"items?per_page=100&page=1": list(range(100)), "items?per_page=100&page=2": list(range(3))})
        gh = w.GitHub("github.com", "u/gad")
        self.assertEqual(len(gh.pages("items")), 103)
        self.assertEqual([p for _, _, p in self.box.paths()], ["items?per_page=100&page=1", "items?per_page=100&page=2"])

    def test_a_full_last_page_costs_one_more_empty_call(self):
        self.serve({"items?per_page=100&page=1": list(range(100))})
        self.assertEqual(len(w.GitHub("github.com", "u/gad").pages("items")), 100)
        self.assertEqual(len(self.box.calls()), 2)

    def test_a_path_with_a_query_and_a_key(self):
        self.serve({"runs?x=1&per_page=100&page=1": {"check_runs": [1, 2]}})
        self.assertEqual(w.GitHub("github.com", "u/gad").pages("runs?x=1", key="check_runs"), [1, 2])

    def test_an_empty_body_is_none(self):
        self.serve({"empty": {"_raw": ""}, "blank": {"_raw": "  \n"}})
        gl = w.GitLab("gitlab.com", "a/b")
        self.assertIsNone(gl.api("empty"))
        self.assertIsNone(gl.api("blank"))
        self.assertEqual(self.box.calls()[0]["argv"], ["api", "--hostname", "gitlab.com", "empty"])


if __name__ == "__main__":
    unittest.main()
