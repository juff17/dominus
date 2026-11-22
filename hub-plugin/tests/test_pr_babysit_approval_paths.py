"""pr-babysit's approval.py, the paths test_pr_babysit_approval.py leaves
out: GitLab replies, retries and plays, GitHub workflow approvals and reruns,
environment checks, the token hint, the lock's "Already running", dismiss,
outcomes and history, and policy() for every Settings value. The forge is
the fake gh/glab from tests/fixtures/pr_babysit/fake_forge.py."""

import contextlib
import io
import json
import os
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
from babysit_harness import (
    GH_SHA,
    GH_URL,
    GL_PROJ,
    GL_SHA,
    GL_URL,
    SCRIPTS,
    Sandbox,
    load,
)

ap = load("approval", SCRIPTS / "approval.py")
w = ap.w

GH_KEY = "github.com/u/gad#91"
GL_KEY = "gitlab.com/grp/sub/gad#91"
MRS = f"{GL_PROJ}/merge_requests/91"


class Case(unittest.TestCase):
    def setUp(self):
        self.box = Sandbox(self)
        self.box.patch_env(self, CLAUDE_CODE_SESSION_ID="claude-1", TMUX_PANE="%7")
        root = self.box.run_dir / "agent-hub" / "approvals"
        for target, name, value in ((ap, "ROOT", root), (ap, "LOG", root / "log.jsonl"), (w, "SETTINGS", self.box.settings)):
            p = mock.patch.object(target, name, value)
            p.start()
            self.addCleanup(p.stop)
        self.routes = {}

    def serve(self, **routes):
        self.routes.update(routes)
        self.box.routes(self.routes)

    def set(self, **values):
        self.box.settings.write_text(json.dumps(values))

    def cli(self, *argv):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = ap.main(list(argv))
        return code, out.getvalue().strip()

    def propose(self, kind, url, *argv):
        code, out = self.cli("propose", kind, url, "--session", "s1", *argv)
        return code, out, out.split()[1] if out.startswith("[") else ""

    def approve(self, pid):
        code, out = self.cli("approve", pid)
        return code, json.loads(out)

    def posts(self):
        return [(c["path"], c["argv"]) for c in self.box.calls() if c["method"] == "POST"]


class GitLabReply(Case):
    def setUp(self):
        super().setUp()
        self.serve(**{
            f"{MRS}/notes/301": {"id": 301, "author": {"username": "alice"}, "body": "This loads every row.",
                                 "position": {"new_path": "src/api/list.py", "old_path": "src/api/list.py",
                                              "new_line": 42, "old_line": None}},
            f"{MRS}/discussions": [{"id": "d0", "notes": [{"id": 300}]}, {"id": "d1abc", "notes": [{"id": 299}, {"id": 301}]}],
        })

    def test_a_reply_finds_its_discussion_and_posts_there(self):
        code, out, pid = self.propose("reply", GL_URL, "--comment", "note:301", "--body", "Done in 3f9a1c2.")
        self.assertEqual(code, 0, out)
        p = ap.load(pid)
        self.assertEqual(p["title"], "Reply to @alice on src/api/list.py:42")
        # A GitLab note has no URL of its own: the MR's stands in.
        self.assertEqual(p["thread"], {"id": "note:301", "author": "alice", "where": "src/api/list.py:42",
                                       "body": "This loads every row.", "url": GL_URL})
        self.assertEqual((p["pr"]["ref"], p["pr"]["forge"], p["pr"]["repo"], p["where"]), ("!91", "gitlab", "gad", "gad !91"))
        self.box.reset_calls()
        code, result = self.approve(pid)
        self.assertEqual((code, result), (0, {"ok": True, "message": "Posted the reply to @alice", "id": pid, "status": "done"}))
        self.assertEqual(self.box.paths(), [("glab", "GET", f"{MRS}/discussions?per_page=100&page=1"),
                                            ("glab", "POST", f"{MRS}/discussions/d1abc/notes")])
        self.assertEqual(self.posts()[0][1][-2:], ["-f", "body=Done in 3f9a1c2."])

    def test_a_gone_thread_fails_and_stays_for_the_tray(self):
        _, _, pid = self.propose("reply", GL_URL, "--comment", "note:301", "--body", "x")
        self.serve(**{f"{MRS}/discussions": [{"id": "d0", "notes": [{"id": 300}]}]})
        code, result = self.approve(pid)
        self.assertEqual((code, result["ok"], result["message"]), (1, False, "The thread for note 301 is gone"))
        self.assertEqual(self.posts(), [])
        self.assertEqual(ap.outcomes(GL_KEY, "s1"), [
            f"reply {pid} (Reply to @alice on src/api/list.py:42) failed: The thread for note 301 is gone. "
            "Work out why, fix what you can, and propose it again"])
        self.assertEqual(ap.load(pid)["status"], "failed")

    def test_only_note_ids_are_gitlab_comments(self):
        for cid in ("rc:301", "note:abc", "301"):
            with self.assertRaisesRegex(SystemExit, f"Not a comment id from a \\[comment\\] event: {cid}"):
                self.propose("reply", GL_URL, "--comment", cid, "--body", "x")

    def test_a_gitlab_reply_to_a_general_note_has_no_where(self):
        self.serve(**{f"{MRS}/notes/5": {"author": {"username": "carol"}, "body": "When?", "position": None}})
        _, _, pid = self.propose("reply", GL_URL, "--comment", "note:5", "--body", "Friday.")
        self.assertEqual(ap.load(pid)["title"], "Reply to @carol")


class GitLabJobs(Case):
    def setUp(self):
        super().setUp()
        self.serve(**{f"{GL_PROJ}/jobs/12": {"id": 12, "name": "lint", "stage": "test", "commit": {"id": GL_SHA}},
                      MRS: {"iid": 91, "sha": GL_SHA}})

    def test_a_retry_takes_the_jobs_facts_and_retries_on_approval(self):
        _, out, pid = self.propose("retry", GL_URL, "--job", "12", "--name", "whatever", "--reason", "runner lost")
        self.assertTrue(out.startswith("[proposed] "), out)
        p = ap.load(pid)
        self.assertEqual(p["job"], {"id": "12", "name": "lint", "reason": "runner lost", "stage": "test", "sha": GL_SHA})
        self.assertEqual((p["title"], p["key"]), ("Retry lint", "retry:12"))
        self.box.reset_calls()
        code, result = self.approve(pid)
        self.assertEqual((code, result["message"]), (0, "Retried lint"))
        self.assertEqual(self.box.paths(), [("glab", "GET", MRS), ("glab", "POST", f"{GL_PROJ}/jobs/12/retry")])

    def test_a_retry_of_a_job_from_an_older_head_runs_nothing(self):
        _, _, pid = self.propose("retry", GL_URL, "--job", "12", "--name", "lint")
        self.serve(**{MRS: {"sha": "9" * 40}})
        code, result = self.approve(pid)
        self.assertEqual((code, result["message"]), (1, "lint is from 0f1e2d3, but the PR is at 9999999 now; nothing was run"))
        self.assertEqual(self.posts(), [])

    def test_the_sha_can_come_from_the_pipeline_and_a_job_gitlab_doesnt_know_has_none(self):
        self.serve(**{f"{GL_PROJ}/jobs/13": {"name": "unit", "pipeline": {"sha": GL_SHA}}, f"{GL_PROJ}/jobs/14": {}})
        _, _, pid = self.propose("retry", GL_URL, "--job", "13", "--name", "unit")
        self.assertEqual(ap.load(pid)["job"]["sha"], GL_SHA)
        _, _, pid = self.propose("retry", GL_URL, "--job", "14", "--name", "e2e")
        self.assertEqual(ap.load(pid)["job"], {"id": "14", "name": "e2e", "reason": "", "stage": ""})
        self.box.reset_calls()
        # No sha: no head check before the retry.
        self.assertEqual(self.approve(pid)[1]["message"], "Retried e2e")
        self.assertEqual(self.box.paths(), [("glab", "POST", f"{GL_PROJ}/jobs/14/retry")])

    def test_a_manual_job_plays_once_approved(self):
        self.set(**{"approvals.manual": "auto"})
        self.serve(**{f"{GL_PROJ}/jobs/15": {"name": "deploy:staging", "stage": "deploy", "commit": {"id": GL_SHA}}})
        _, out, pid = self.propose("manual", GL_URL, "--job", "15", "--name", "deploy:staging", "--stage", "deploy")
        # It deploys, so it asks whatever Settings say.
        self.assertTrue(out.startswith(f"[proposed] {pid} Run deploy:staging: waiting for approval"), out)
        code, result = self.approve(pid)
        self.assertEqual((code, result["message"]), (0, "Started deploy:staging"))
        self.assertEqual(self.posts()[0][0], f"{GL_PROJ}/jobs/15/play")

    def test_the_jobs_real_name_and_stage_decide_whether_it_deploys(self):
        self.set(**{"approvals.manual": "auto"})
        self.serve(**{f"{GL_PROJ}/jobs/16": {"name": "smoke", "stage": "production-checks"}})
        _, out, _ = self.propose("manual", GL_URL, "--job", "16", "--name", "lint", "--stage", "test")
        self.assertTrue(out.startswith("[proposed] "), out)

    def test_a_gitlab_deploy_is_a_play(self):
        self.serve(**{f"{GL_PROJ}/jobs/17": {"name": "ship", "stage": "release"}})
        _, out, pid = self.propose("deploy", GL_URL, "--job", "17", "--name", "ship")
        self.assertEqual(ap.load(pid)["title"], "Approve ship")
        self.assertEqual(self.approve(pid)[1]["message"], "Started ship")
        self.assertEqual(self.posts()[0][0], f"{GL_PROJ}/jobs/17/play")


class GitHubJobs(Case):
    def setUp(self):
        super().setUp()
        self.serve(**{"repos/u/gad/pulls/91": {"head": {"sha": GH_SHA}},
                      "repos/u/gad/actions/runs/900": {"id": 900, "head_sha": GH_SHA},
                      "repos/u/gad/actions/jobs/77": {"name": "unit", "head_sha": GH_SHA, "run_id": 5}})

    def test_a_manual_workflow_run_is_a_deployment_approved_as_a_run(self):
        self.set(**{"approvals.manual": "auto"})
        _, out, pid = self.propose("manual", GH_URL, "--job", "run:900", "--name", "Fork CI")
        self.assertTrue(out.startswith("[proposed] "), out)
        p = ap.load(pid)
        self.assertEqual((p["kind"], p["title"], p["key"]), ("deploy", "Approve Fork CI", "deploy:run:900"))
        self.assertEqual(p["job"], {"id": "run:900", "name": "Fork CI", "reason": "", "stage": "", "sha": GH_SHA, "run_id": "900"})
        self.box.reset_calls()
        code, result = self.approve(pid)
        self.assertEqual((code, result["message"]), (0, "Approved workflow run Fork CI"))
        self.assertEqual(self.box.paths(), [("gh", "GET", "repos/u/gad/pulls/91"),
                                            ("gh", "POST", "repos/u/gad/actions/runs/900/approve")])

    def test_a_retry_reruns_the_job(self):
        _, _, pid = self.propose("retry", GH_URL, "--job", "77", "--name", "x")
        self.assertEqual(ap.load(pid)["job"]["run_id"], 5)
        self.box.reset_calls()
        self.assertEqual(self.approve(pid)[1]["message"], "Retried unit")
        self.assertEqual(self.box.paths(), [("gh", "GET", "repos/u/gad/pulls/91"),
                                            ("gh", "POST", "repos/u/gad/actions/jobs/77/rerun")])
        self.assertEqual(self.posts()[0][1], ["api", "--hostname", "github.com", "-X", "POST",
                                              "repos/u/gad/actions/jobs/77/rerun"])

    def test_a_status_or_run_id_reaching_run_job_is_refused(self):
        p = {"id": "x", "kind": "retry", "pr": {"number": 91}, "job": {"id": "status:ci/jenkins", "name": "jenkins"}}
        with self.assertRaisesRegex(RuntimeError, "outside CI status"):
            ap.run_job(p, w.GitHub("github.com", "u/gad"))
        p["job"] = {"id": "run:900", "name": "Fork CI"}
        with self.assertRaisesRegex(RuntimeError, "only run as a deployment"):
            ap.run_job(p, w.GitHub("github.com", "u/gad"))


class Environments(Case):
    def setUp(self):
        super().setUp()
        self.serve(**{"repos/u/gad/actions/jobs/5": {"name": "deploy", "run_id": 9}})

    def pending(self, *envs):
        self.serve(**{"repos/u/gad/actions/runs/9/pending_deployments": [
            {"environment": {"id": i, "name": n}, "current_user_can_approve": ok} for i, n, ok in envs]})

    def test_only_environments_the_user_can_approve_are_proposed_and_approved(self):
        self.pending((3, "qa", True), (1, "staging", True), (2, "production", False))
        _, _, pid = self.propose("deploy", GH_URL, "--job", "5", "--name", "deploy")
        self.assertEqual(ap.load(pid)["title"], "Approve deploy (qa, staging)")
        self.assertEqual(ap.load(pid)["job"]["environments"], [{"id": 3, "name": "qa"}, {"id": 1, "name": "staging"}])
        code, result = self.approve(pid)
        self.assertEqual((code, result["message"]), (0, "Approved the deployment for deploy"))
        path, argv = self.posts()[0]
        self.assertEqual(path, "repos/u/gad/actions/runs/9/pending_deployments")
        self.assertEqual(argv, ["api", "--hostname", "github.com", "-X", "POST", path, "-f", "state=approved",
                                "-f", "comment=Approved from pr-babysit", "-F", "environment_ids[]=1", "-F", "environment_ids[]=3"])

    def test_none_the_user_can_approve(self):
        self.pending((2, "production", False))
        with self.assertRaisesRegex(SystemExit, "^Nothing you can approve is waiting on 5$"):
            self.propose("deploy", GH_URL, "--job", "5", "--name", "deploy")

    def test_no_workflow_run(self):
        self.serve(**{"repos/u/gad/actions/jobs/6": {"name": "deploy"}})
        with self.assertRaisesRegex(SystemExit, "Nothing you can approve is waiting on 6: GitHub names no workflow run for it"):
            self.propose("deploy", GH_URL, "--job", "6", "--name", "deploy")

    def test_an_environment_the_user_can_no_longer_approve_refuses_all(self):
        self.pending((1, "staging", True), (3, "qa", True))
        _, _, pid = self.propose("deploy", GH_URL, "--job", "5", "--name", "deploy")
        self.pending((1, "staging", True), (3, "qa", False))
        code, result = self.approve(pid)
        self.assertEqual((code, result["message"]),
                         (1, "What deploy waited on changed since it was proposed; nothing was approved"))
        self.assertEqual(self.posts(), [])


class TokenHint(Case):
    def test_a_refused_login_says_how_to_log_in_to_that_host(self):
        url = "https://github.example.com/u/gad/pull/91"
        self.serve(**{"repos/u/gad/actions/jobs/77": {"name": "unit"},
                      "POST repos/u/gad/actions/jobs/77/rerun": {"_exit": 1, "_stderr": "HTTP 401: Bad credentials"}})
        _, _, pid = self.propose("retry", url, "--job", "77", "--name", "unit")
        code, result = self.approve(pid)
        self.assertEqual(code, 1)
        self.assertTrue(result["message"].startswith("gh isn't logged in to github.example.com, "), result["message"])
        self.assertTrue(result["message"].endswith(" (HTTP 401: Bad credentials)"), result["message"])
        self.assertTrue(all(c["argv"][2] == "github.example.com" for c in self.box.calls()))

    def test_the_hint_for_each_forge(self):
        self.assertIn("Run `gh auth login --hostname github.com`",
                      ap.token_hint({"pr": {"forge": "github", "host": "github.com"}}))
        self.assertIn("Run `glab auth login --hostname gitlab.example.com`",
                      ap.token_hint({"pr": {"forge": "gitlab", "host": "gitlab.example.com"}}))
        self.assertIn("Run `glab auth login` in a terminal", ap.token_hint({"pr": {"forge": "gitlab"}}))

    def test_an_unexpected_error_still_settles_the_proposal(self):
        self.serve(**{"repos/u/gad/actions/jobs/77": {"name": "unit"}})
        _, _, pid = self.propose("retry", GH_URL, "--job", "77", "--name", "unit")
        with mock.patch.object(ap, "run_job", side_effect=ZeroDivisionError("boom")):
            code, result = self.approve(pid)
        self.assertEqual((code, result["message"], ap.load(pid)["status"]), (1, "ZeroDivisionError: boom", "failed"))


class Lock(Case):
    def test_already_running_is_an_answer_on_stdout_like_any_other(self):
        # The tray reads the last stdout line as {ok, message}; stderr stays
        # empty so nothing raw reaches the user.
        with ap.locked("123-reply-abc"):
            for cmd in ("approve", "reject"):
                r = self.box.run_script("approval.py", cmd, "123-reply-abc")
                self.assertEqual((r.returncode, r.stdout, r.stderr),
                                 (1, '{"ok": false, "message": "Already running", "id": "123-reply-abc"}\n', ""), cmd)
            self.assertEqual(ap.approve("123-reply-abc"), {"ok": False, "message": "Already running", "id": "123-reply-abc"})

    def test_lock_files_leave_with_their_proposal(self):
        self.assertEqual(self.cli("approve", "1-x-y")[0], 1)
        p = {"id": "2-reply-abc", "kind": "reply", "session": "s1", "pr": {"key": GH_KEY}, "status": "failed", "title": "Reply"}
        ap.save(p)
        self.cli("reject", "2-reply-abc")
        self.assertEqual(sorted(f.name for f in ap.ROOT.iterdir()), ["2-reply-abc.json", "2-reply-abc.lock"])
        self.assertEqual(self.cli("dismiss", "2-reply-abc")[0], 0)
        self.assertEqual([f.name for f in ap.ROOT.iterdir()], [])

    def test_a_lock_unlinked_while_waited_on_is_not_shared(self):
        # A second process that opened the lock file before its holder
        # removed it must not think it holds the lock the next one takes.
        ap.ROOT.mkdir(parents=True)
        path = ap.ROOT / "3-a-b.lock"
        real, calls = ap.files.fcntl.flock, []

        def flock(f, op):
            if not calls:
                path.unlink()  # its holder finished and cleaned up meanwhile
            calls.append(op)
            return real(f, op)

        with mock.patch.object(ap.files.fcntl, "flock", flock):
            held = ap.files.try_lock(path)
        self.addCleanup(held.close)
        self.assertEqual(len(calls), 2, "the lock on the unlinked file was let go and taken again")
        self.assertEqual(os.fstat(held.fileno()).st_ino, os.stat(path).st_ino)
        self.assertIsNone(ap.files.try_lock(path), "the file at the path is the one held")

    def test_approve_and_reject_of_a_missing_proposal(self):
        self.assertEqual(self.cli("approve", "1-x-y"), (1, '{"ok": false, "message": "That approval is gone"}'))
        self.assertEqual(self.cli("reject", "1-x-y"), (1, '{"ok": false, "message": "That approval is gone"}'))

    def test_a_failed_proposal_can_be_approved_again_but_not_rejected(self):
        self.serve(**{"repos/u/gad/actions/jobs/77": {"name": "unit"},
                      "POST repos/u/gad/actions/jobs/77/rerun": {"_exit": 1, "_stderr": "HTTP 500"}})
        _, _, pid = self.propose("retry", GH_URL, "--job", "77", "--name", "unit")
        self.approve(pid)
        self.assertEqual(self.cli("reject", pid), (1, '{"ok": false, "message": "Already failed"}'))


class Dismiss(Case):
    def proposal(self, pid="1-reply-abc", **fields):
        p = {"id": pid, "kind": "reply", "session": "s1", "pr": {"key": GH_KEY}, "status": "failed", "title": "Reply"}
        p.update(fields)
        ap.save(p)
        return pid

    def test_dismiss_removes_the_file_and_its_lock(self):
        pid = self.proposal()
        self.assertEqual(self.cli("dismiss", pid), (0, '{"ok": true, "message": "Dismissed"}'))
        self.assertIsNone(ap.load(pid))
        self.assertFalse((ap.ROOT / f"{pid}.lock").exists())

    def test_dismissing_one_being_approved_is_refused(self):
        pid = self.proposal()
        with ap.locked(pid):
            self.assertEqual(self.cli("dismiss", pid), (1, '{"ok": false, "message": "It\'s being approved right now"}'))
        self.assertIsNotNone(ap.load(pid))

    def test_dismissing_what_isnt_there_says_it_is_gone(self):
        self.assertEqual(self.cli("dismiss", "9-none-here"), (1, '{"ok": false, "message": "That approval is gone"}'))

    def test_a_bad_id_is_refused(self):
        for bad in ("../x", "a.b", ""):
            with self.assertRaisesRegex(SystemExit, "Not an approval id"):
                self.cli("dismiss", bad)

    def test_list_prints_every_proposal(self):
        self.proposal("1-a-b")
        self.proposal("2-c-d", status="pending")
        (ap.ROOT / "3-broken.json").write_text("{")
        code, out = self.cli("list")
        self.assertEqual((code, [p["id"] for p in json.loads(out)]), (0, ["1-a-b", "2-c-d"]))

    def test_list_with_no_folder_is_empty(self):
        self.assertEqual(self.cli("list"), (0, "[]"))


class Outcomes(Dismiss):
    def test_pending_is_kept_reported_ones_leave_and_reported_failures_stay(self):
        self.proposal("1-a-pending", status="pending")
        self.proposal("2-a-done", status="done", reported=True)
        self.proposal("3-a-failed", status="failed", reported=True)
        self.proposal("4-a-other", status="done", session="s2", result={"message": "m"})
        self.proposal("5-a-otherpr", status="done", pr={"key": "github.com/u/gad#92"}, result={"message": "m"})
        self.assertEqual(ap.outcomes(GH_KEY, "s1"), [])
        self.assertEqual(sorted(p["id"] for p in ap.every()), ["1-a-pending", "3-a-failed", "4-a-other", "5-a-otherpr"])

    def test_each_outcome_line(self):
        self.proposal("1-reply-x", status="done", result={"message": "Posted"}, edited=True)
        self.proposal("2-reply-y", status="rejected", result={"message": "Rejected"})
        self.proposal("3-push-z", kind="push", status="handed", local="babysit/91", title="Push 2 commits to feat",
                      result={"message": "m", "drop": ["abcdef1234", "1234567890"]})
        self.proposal("4-move-w", kind="move", status="handed", local="babysit/91", onto="f" * 40, lease="e" * 40,
                      title="Move 1 local commit onto fffffff")
        self.proposal("5-retry-v", kind="retry", status="failed", title="Retry unit", result={})
        self.assertEqual(ap.outcomes(GH_KEY, "s1"), [
            "reply 1-reply-x (Reply) approved with the reply as the user edited it: Posted",
            "reply 2-reply-y (Reply) rejected by the user; keep it for the briefing",
            "push 3-push-z (Push 2 commits to feat) approved without abcdef1 1234567: drop those commits from babysit/91, "
            "run lint and tests, then propose the push again",
            f"move 4-move-w (Move 1 local commit onto fffffff) approved: rebase babysit/91 onto {'f' * 40} "
            f"(git rebase --onto {'f' * 40} {'e' * 40}), run lint and tests, save the new lease_sha, then propose the push",
            "retry 5-retry-v (Retry unit) failed: . Work out why, fix what you can, and propose it again",
        ])
        self.assertEqual([p["id"] for p in ap.every()], ["5-retry-v"])
        self.assertTrue(ap.load("5-retry-v")["reported"])


class History(Case):
    def test_done_and_failed_are_logged_rejected_and_handed_are_not(self):
        self.serve(**{"repos/u/gad/actions/jobs/77": {"name": "unit"},
                      "repos/u/gad/actions/jobs/78": {"name": "e2e"},
                      "POST repos/u/gad/actions/jobs/78/rerun": {"_exit": 1, "_stderr": "HTTP 500"}})
        _, _, ok = self.propose("retry", GH_URL, "--job", "77", "--name", "unit")
        _, _, bad = self.propose("retry", GH_URL, "--job", "78", "--name", "e2e")
        self.approve(ok)
        self.approve(bad)
        _, _, no = self.propose("retry", GH_URL, "--job", "77", "--name", "unit")
        self.cli("reject", no)
        entries = [{k: v for k, v in e.items() if k != "at"} for e in ap.history()]
        self.assertEqual(entries, [
            {"pr": GH_KEY, "kind": "retry", "job": "77", "name": "unit", "ok": True, "auto": False, "claude_session": "claude-1"},
            {"pr": GH_KEY, "kind": "retry", "job": "78", "name": "e2e", "ok": False, "auto": False, "claude_session": "claude-1"}])

    def test_a_broken_log_line_is_skipped_alone(self):
        self.set(**{"approvals.retry": "auto"})
        self.serve(**{"repos/u/gad/actions/jobs/77": {"name": "unit"}})
        self.assertTrue(self.propose("retry", GH_URL, "--job", "77", "--name", "unit")[1].startswith("[auto] "))
        self.assertTrue(self.propose("retry", GH_URL, "--job", "77", "--name", "unit")[1].startswith("[proposed] "))
        with open(ap.LOG, "a") as f:
            f.write("{half a line\n[1, 2]\n")
        self.assertEqual([e["name"] for e in ap.history()], ["unit"])
        self.assertTrue(self.propose("retry", GH_URL, "--job", "77", "--name", "unit")[1].startswith("[proposed] "),
                        "still once per job")

    def test_an_auto_retry_from_another_pr_does_not_count(self):
        self.set(**{"approvals.retry": "auto"})
        ap.ROOT.mkdir(parents=True)
        ap.LOG.write_text(json.dumps({"pr": "github.com/u/gad#92", "kind": "retry", "job": "77", "name": "unit", "ok": True,
                                      "auto": True}) + "\n")
        self.serve(**{"repos/u/gad/actions/jobs/77": {"name": "unit"}})
        self.assertTrue(self.propose("retry", GH_URL, "--job", "77", "--name", "unit")[1].startswith("[auto] "))


class Policy(Case):
    def policy(self, kind, value=None, key=None):
        self.set(**({key or f"approvals.{kind}": value} if value is not None else {}))
        return ap.policy(kind)

    def test_reply(self):
        for value, want in (("post", "auto"), ("draft", "ask"), ("off", "off"), (None, "ask"), ("auto", "ask"), (True, "ask")):
            self.assertEqual(self.policy("reply", value), want, value)

    def test_deploy_always_asks(self):
        for value in ("auto", "ask", None):
            self.assertEqual(self.policy("deploy", value), "ask", value)

    def test_the_other_kinds(self):
        for kind in ("push", "retry", "manual", "move"):
            for value, want in (("auto", "auto"), ("ask", "ask"), ("off", "ask"), ("post", "ask"), (None, "ask")):
                self.assertEqual(self.policy(kind, value), want, (kind, value))

    def test_no_settings_file_asks(self):
        self.assertEqual(ap.policy("push"), "ask")
        self.box.settings.write_text("[not, an, object")
        self.assertEqual(ap.policy("reply"), "ask")

    def test_replies_off_refuses_the_proposal(self):
        self.set(**{"approvals.reply": "off"})
        self.assertEqual(self.cli("propose", "reply", GL_URL, "--session", "s1", "--comment", "note:1", "--body", "x"),
                         (1, "[refused] Settings > Approvals > Post a reply is off: keep the reply for the briefing"))
        self.assertEqual(self.box.calls(), [])


if __name__ == "__main__":
    unittest.main()
