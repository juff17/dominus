"""pr-babysit's watch_pr.py, the event side: the exact lines report() prints
over a sequence of snapshots, what the watch loop adds around them ([watch],
[settings], [approval], [merged]), and that nothing repeats across polls or a
re-arm. Snapshots are built by hand here; test_pr_babysit_forge.py covers how
the API's JSON becomes one."""

import contextlib
import importlib
import io
import json
import os
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
from babysit_harness import NOWHERE, SCRIPTS, Sandbox, load_watch_pr

w = load_watch_pr()

# approval_outcomes() imports approval by name; it's imported here first so
# every test can point its ROOT at the sandbox.
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))
with mock.patch.dict(os.environ, NOWHERE):
    approval = importlib.import_module("approval")

URL = "https://github.com/u/gad/pull/91"
A, B = "a" * 40, "b" * 40


def chk(id, stage, job, status, allow_failure=False, waited=0, started=None, finished=None, url=None):
    return {"id": id, "name": f"{job} (stage {stage})", "group": stage, "job": job, "status": status,
            "url": f"https://ci/{id}" if url is None else url, "waited": waited, "started": started,
            "finished": finished, "allow_failure": allow_failure}


def snap(sha=A, checks=(), comments=(), reviews=(), state="open", **extra):
    return {"state": state, "url": URL, "title": "Add pagination", "branch": "feat", "base": "main", "sha": sha,
            "fork": False, "checks": list(checks), "comments": list(comments), "reviews": list(reviews), **extra}


def comment(id, author="alice", where="", body="nit", resolved=False):
    return {"id": id, "author": author, "where": where, "body": body, "url": f"https://x/{id}", "resolved": resolved}


class Case(unittest.TestCase):
    def setUp(self):
        self.box = Sandbox(self)
        self.box.patch_env(self)
        for target, name, value in ((w, "SETTINGS", self.box.settings),
                                    (approval, "ROOT", self.box.run_dir / "agent-hub" / "approvals"),
                                    (approval, "LOG", self.box.run_dir / "agent-hub" / "approvals" / "log.jsonl")):
            p = mock.patch.object(target, name, value)
            p.start()
            self.addCleanup(p.stop)
        w.TOLD.clear()
        self.state = {"comments": set(), "events": set()}

    def poll(self, s, stuck_after=30, me="me"):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            w.report(s, self.state, me, stuck_after)
        return out.getvalue().splitlines()


class Pipeline(Case):
    def test_a_pipeline_stage_by_stage(self):
        self.assertEqual(self.poll(snap(checks=[chk(1, "build", "compile", "running"), chk(2, "test", "unit", "waiting")])), [])
        build = chk(1, "build", "compile", "success", started="2026-11-09T10:00:00Z", finished="2026-11-09T10:04:00Z")
        self.assertEqual(self.poll(snap(checks=[build, chk(2, "test", "unit", "running", started="2026-11-09T10:04:00Z")])),
                         ["[stage] build passed for aaaaaaaa | build ✓ (compile) · test ⏳"])
        done = snap(checks=[build, chk(2, "test", "unit", "success", started="2026-11-09T10:04:00Z",
                                       finished="2026-11-09T10:12:00Z")])
        # The last stage comes with the pipeline line, not as a [stage] of its own.
        self.assertEqual(self.poll(done), ["[pipeline] passed for aaaaaaaa in 12m, 0 of 2 checks failed | build ✓ · test ✓"])
        self.assertEqual(self.poll(done), [])

    def test_stages_already_done_when_a_head_is_first_seen_are_not_news(self):
        build = chk(1, "build", "compile", "success")
        self.assertEqual(self.poll(snap(checks=[build, chk(2, "test", "unit", "running")])), [])
        # Nor later: the stage was marked as told.
        self.assertEqual(self.poll(snap(checks=[build, chk(2, "test", "unit", "running")])), [])
        self.assertIn(f"{A}:stage:build", self.state["events"])

    def test_a_failed_pipeline_lists_what_failed_and_allowed_failures_apart(self):
        checks = [chk(1, "build", "compile", "success"), chk(2, "test", "lint", "failed", allow_failure=True),
                  chk(3, "test", "unit", "failed")]
        self.assertEqual(self.poll(snap(checks=checks)), [
            "[failed] lint (stage test) (allowed to fail) id=2 https://ci/2 | build ✓ · test ✗",
            "[failed] unit (stage test) id=3 https://ci/3 | build ✓ · test ✗",
            "[pipeline] failed for aaaaaaaa, 1 of 2 checks failed: unit (stage test) | build ✓ · test ✗",
        ])
        self.assertEqual(self.poll(snap(checks=checks)), [])

    def test_an_allowed_failure_alone_does_not_fail_the_stage(self):
        checks = [chk(2, "test", "lint", "failed", allow_failure=True), chk(3, "test", "unit", "success")]
        self.assertEqual(self.poll(snap(checks=checks))[-1],
                         "[pipeline] passed for aaaaaaaa, 0 of 1 checks failed | test ✓")

    def test_a_stage_of_only_allowed_failures_counts_them(self):
        lines = self.poll(snap(checks=[chk(1, "build", "compile", "success"), chk(2, "lint", "lint", "failed", allow_failure=True)]))
        # The job shares the stage's name, so no "(lint)" detail; the stage shows failed.
        self.assertEqual(lines[0], "[failed] lint (stage lint) (allowed to fail) id=2 https://ci/2 | build ✓ · lint ✗")
        self.assertEqual(lines[1], "[pipeline] passed for aaaaaaaa, 0 of 1 checks failed | build ✓ · lint ✗")

    def test_canceled_and_failed_and_canceled(self):
        self.assertEqual(self.poll(snap(checks=[chk(1, "build", "compile", "success"), chk(2, "test", "unit", "canceled")])),
                         ["[pipeline] canceled for aaaaaaaa, 1 of 2 checks canceled: unit (stage test) | build ✓ · test ⊘"])
        self.state = {"comments": set(), "events": set()}
        lines = self.poll(snap(checks=[chk(1, "build", "compile", "canceled"), chk(2, "test", "unit", "failed")]))
        self.assertEqual(lines[-1], "[pipeline] failed for aaaaaaaa, 1 of 2 checks failed: unit (stage test) | build ⊘ · test ✗")

    def test_only_allowed_failures_never_finish_a_pipeline(self):
        lines = self.poll(snap(checks=[chk(1, "lint", "lint", "success", allow_failure=True)]))
        self.assertEqual(lines, [])

    def test_durations(self):
        def run(start, end):
            self.state = {"comments": set(), "events": set()}
            return self.poll(snap(checks=[chk(1, "b", "c", "success", started=start, finished=end)]))[0]
        self.assertIn("passed for aaaaaaaa in 1h 5m,", run("2026-11-09T10:00:00Z", "2026-11-09T11:05:59Z"))
        self.assertIn("passed for aaaaaaaa in 1m,", run("2026-11-09T10:00:00Z", "2026-11-09T10:00:20Z"))
        self.assertIn("passed for aaaaaaaa, 0 of", run("2026-11-09T10:00:00Z", None))

    def test_a_skipped_stage_is_left_out_of_the_progress(self):
        lines = self.poll(snap(checks=[chk(1, "build", "compile", "failed"), chk(2, "docs", "docs", "skipped")]))
        self.assertTrue(lines[0].endswith("| build ✗"), lines[0])

    def test_stage_order_is_by_first_job_id(self):
        checks = [chk(9, "deploy", "d", "waiting"), chk(3, "test", "t", "running"), chk(5, "qa", "q", "manual"),
                  chk(1, "build", "b", "canceled")]
        lines = self.poll(snap(checks=checks))
        self.assertEqual(lines, ["[manual] q (stage qa) id=5 https://ci/5 | build ⊘ · test ⏳ · qa ⏸ · deploy"])


class Manual(Case):
    def test_a_blocking_manual_job_is_told_once(self):
        s = snap(checks=[chk(5, "deploy", "deploy:prod", "manual")])
        self.assertEqual(self.poll(s), ["[manual] deploy:prod (stage deploy) id=5 https://ci/5 | deploy ⏸"])
        self.assertEqual(self.poll(s), [])

    def test_an_optional_manual_job_is_not(self):
        self.assertEqual(self.poll(snap(checks=[chk(5, "deploy", "docs", "manual", allow_failure=True)])), [])

    def test_a_check_with_no_group_has_no_progress_suffix(self):
        run = {"id": "run:9", "name": "workflow Fork CI (action required)", "status": "manual",
               "url": "https://github.com/u/gad/actions/runs/9", "waited": 0, "allow_failure": False}
        self.assertEqual(self.poll(snap(checks=[run])),
                         ["[manual] workflow Fork CI (action required) id=run:9 https://github.com/u/gad/actions/runs/9"])

    def test_an_empty_url_leaves_two_spaces(self):
        self.assertEqual(self.poll(snap(checks=[chk(3, "test", "unit", "failed", url="")]))[0],
                         "[failed] unit (stage test) id=3  | test ✗")


class Stuck(Case):
    def test_a_pending_job_past_stuck_after_is_told_once(self):
        s = snap(checks=[chk(4, "test", "e2e", "pending", waited=31.9)])
        self.assertEqual(self.poll(s), ["[stuck] e2e (stage test) has waited 31 min for a runner id=4 https://ci/4 | test ⏳"])
        self.assertEqual(self.poll(s), [])

    def test_the_threshold_is_inclusive_and_only_pending_counts(self):
        self.assertEqual(len(self.poll(snap(checks=[chk(4, "test", "e2e", "pending", waited=30)]))), 1)
        self.state = {"comments": set(), "events": set()}
        self.assertEqual(self.poll(snap(checks=[chk(4, "test", "e2e", "pending", waited=29.99)])), [])
        for status in ("running", "waiting", "manual"):
            self.state = {"comments": set(), "events": set()}
            lines = self.poll(snap(checks=[chk(4, "test", "e2e", status, waited=99, allow_failure=True)]))
            self.assertEqual(lines, [], status)

    def test_stuck_after_is_the_callers(self):
        s = snap(checks=[chk(4, "test", "e2e", "pending", waited=10)])
        self.assertEqual(self.poll(s, stuck_after=30), [])
        self.assertEqual(len(self.poll(s, stuck_after=5)), 1)


class Push(Case):
    def test_a_new_head_is_a_push_and_its_checks_are_told_again(self):
        self.poll(snap(sha=A, checks=[chk(3, "test", "unit", "failed")]))
        self.assertEqual(self.poll(snap(sha=B, checks=[chk(3, "test", "unit", "failed")])), [
            "[push] head moved to bbbbbbbb",
            "[failed] unit (stage test) id=3 https://ci/3 | test ✗",
            "[pipeline] failed for bbbbbbbb, 1 of 1 checks failed: unit (stage test) | test ✗",
        ])

    def test_a_stage_that_finishes_on_the_new_head_is_told(self):
        self.poll(snap(sha=A))
        self.poll(snap(sha=B, checks=[chk(1, "build", "c", "running"), chk(2, "test", "t", "waiting")]))
        self.assertEqual(self.poll(snap(sha=B, checks=[chk(1, "build", "c", "success"), chk(2, "test", "t", "running")])),
                         ["[stage] build passed for bbbbbbbb | build ✓ (c) · test ⏳"])

    def test_the_first_snapshot_is_not_a_push(self):
        self.assertEqual(self.poll(snap(sha=A)), [])


class BehindAndConflict(Case):
    def test_behind_is_told_when_it_starts_or_the_host_starts_requiring_a_rebase(self):
        seq = [((0, False), []),
               ((2, False), ["[behind] feat is 2 commit(s) behind main"]),
               # A bigger count alone is not news.
               ((3, False), []),
               ((3, True), ["[behind] feat is 3 commit(s) behind main, and the host requires a rebase before merge"]),
               # Unknown: nothing, and nothing changes.
               ((3, None), []),
               ((3, True), []),
               ((0, False), []),
               ((1, False), ["[behind] feat is 1 commit(s) behind main"]),
               # GitLab can require a rebase with nothing diverged.
               ((0, True), ["[behind] feat is 0 commit(s) behind main, and the host requires a rebase before merge"])]
        for (behind, rebase), want in seq:
            self.assertEqual(self.poll(snap(behind=behind, needs_rebase=rebase, conflict=False)), want, (behind, rebase))

    def test_a_conflict_is_told_each_time_it_starts(self):
        for conflict, want in ((None, []), (True, ["[conflict] feat has merge conflicts with main"]), (True, []),
                               (None, []), (False, []), (True, ["[conflict] feat has merge conflicts with main"])):
            self.assertEqual(self.poll(snap(conflict=conflict)), want, conflict)

    def test_conflict_comes_before_behind_and_push_before_both(self):
        self.poll(snap(sha=A))
        self.assertEqual(self.poll(snap(sha=B, conflict=True, behind=1, needs_rebase=False)), [
            "[push] head moved to bbbbbbbb",
            "[conflict] feat has merge conflicts with main",
            "[behind] feat is 1 commit(s) behind main"])

    def test_a_snapshot_without_the_keys_says_nothing(self):
        self.assertEqual(self.poll(snap(behind=5)), [])
        self.assertNotIn("lagging", self.state)


class Comments(Case):
    def test_the_comment_line(self):
        self.assertEqual(self.poll(snap(comments=[comment("rc:1", where="src/a.py:3", body="Fix  this\n\nplease")])),
                         ['[comment] @alice on src/a.py:3: "Fix this please" id=rc:1 https://x/rc:1'])
        self.assertEqual(self.poll(snap(comments=[comment("ic:2")])), ['[comment] @alice: "nit" id=ic:2 https://x/ic:2'])

    def test_a_long_body_is_cut_to_240_characters(self):
        line = self.poll(snap(comments=[comment("ic:2", body="x" * 300)]))[0]
        self.assertIn('"' + "x" * 239 + '…"', line)

    def test_a_none_body_is_empty(self):
        self.assertEqual(self.poll(snap(comments=[comment("ic:2", body=None)])), ['[comment] @alice: "" id=ic:2 https://x/ic:2'])

    def test_own_resolved_and_seen_comments(self):
        self.assertEqual(self.poll(snap(comments=[comment("rc:1", author="me"), comment("rc:2", resolved=True)])), [])
        self.assertEqual(self.state["comments"], {"rc:1"})
        # Unresolved later: told then.
        self.assertEqual(len(self.poll(snap(comments=[comment("rc:2")]))), 1)
        # Resolved and unresolved again: not again.
        self.poll(snap(comments=[comment("rc:2", resolved=True)]))
        self.assertEqual(self.poll(snap(comments=[comment("rc:2")])), [])


class Reviews(Case):
    def test_reviews_are_told_once_by_id_and_never_the_users_own(self):
        r = [{"id": "rv:1", "author": "bob", "state": "approved", "url": "https://x/rv1"},
             {"id": "rv:2", "author": "carol", "state": "changes requested", "url": "https://x/rv2"},
             {"id": "approval:me", "author": "me", "state": "approved", "url": "https://x/mr"}]
        self.assertEqual(self.poll(snap(reviews=r)), ["[review] @bob approved https://x/rv1",
                                                      "[review] @carol changes requested https://x/rv2"])
        self.assertEqual(self.poll(snap(reviews=r)), [])

    def test_a_gitlab_reapproval_keeps_its_id_so_is_not_told_again(self):
        r = [{"id": "approval:bob", "author": "bob", "state": "approved", "url": "u"}]
        self.poll(snap(reviews=r))
        self.poll(snap(reviews=[]))
        self.assertEqual(self.poll(snap(reviews=r)), [])


class State(Case):
    def test_the_saved_state_and_a_reload_repeat_nothing(self):
        s = snap(checks=[chk(3, "test", "unit", "failed"), chk(4, "test", "e2e", "pending", waited=40)],
                 comments=[comment("rc:1")], reviews=[{"id": "rv:1", "author": "bob", "state": "approved", "url": "u"}],
                 behind=2, needs_rebase=False, conflict=True)
        self.assertEqual(len(self.poll(s)), 6)
        path = self.box.cache / "state.json"
        w.save_state(path, self.state)
        saved = json.loads(path.read_text())
        self.assertEqual(saved, {"comments": ["rc:1"], "conflict": True, "events": sorted([
            f"{A}:3:failed", f"{A}:4:stuck", "review:rv:1"]), "lagging": [True, False], "sha": A})
        self.state = w.load_state(path)
        self.assertEqual(self.poll(s), [])

    def test_a_missing_or_broken_state_file_is_none(self):
        self.assertIsNone(w.load_state(self.box.cache / "nope.json"))
        (self.box.cache / "bad.json").write_text("{")
        self.assertIsNone(w.load_state(self.box.cache / "bad.json"))


class Forge:
    """Hands out snapshots in turn; an exception in the list is raised."""

    host, project, cli = "github.com", "u/gad", "gh"

    def __init__(self, *snaps, before=None):
        self.snaps, self.before = list(snaps), before

    def me(self):
        return "me"

    def login_hint(self):
        return "log in"

    def snapshot(self, number):
        if self.before:
            self.before(len(self.snaps))
        s = self.snaps.pop(0)
        if isinstance(s, BaseException):
            raise s
        return s


class Loop(Case):
    def watch(self, forge, *argv):
        out = io.StringIO()
        with mock.patch.object(w, "parse_url", return_value=(forge, 91)), \
                mock.patch.object(w, "find_remote", return_value="origin"), \
                mock.patch.object(w, "preflight"), \
                mock.patch.object(w, "take_lock", return_value=object()), \
                mock.patch.object(w.time, "sleep"), \
                mock.patch.object(sys, "argv", ["watch_pr.py", URL, *argv]), \
                contextlib.redirect_stdout(out):
            code = w.main()
        return code, out.getvalue().splitlines()

    SETTINGS_LINE = ("[settings] auto-fix on, auto rebase off: rebase only for a conflict or when the host "
                     "requires it, replies drafted: propose each reply for approval")

    def test_a_whole_watch(self):
        code, lines = self.watch(Forge(snap(checks=[chk(3, "test", "unit", "failed")], comments=[comment("rc:1")]),
                                       snap(state="merged")), "--session", "s1", "--interval", "15")
        self.assertEqual(code, 0)
        self.assertEqual(lines, [
            f'[watch] attached {URL} "Add pagination", branch feat -> main, head {A}, remote origin, '
            "1 open comment(s), polling every 15s",
            self.SETTINGS_LINE,
            "[failed] unit (stage test) id=3 https://ci/3 | test ✗",
            "[pipeline] failed for aaaaaaaa, 1 of 1 checks failed: unit (stage test) | test ✗",
            '[comment] @alice: "nit" id=rc:1 https://x/rc:1',
            f"[merged] {URL}",
        ])

    def test_a_rearm_repeats_nothing(self):
        def forge():
            return Forge(snap(checks=[chk(3, "test", "unit", "failed"), chk(5, "deploy", "go", "manual")],
                              comments=[comment("rc:1")], reviews=[{"id": "rv:1", "author": "bob", "state": "approved", "url": "u"}],
                              behind=1, needs_rebase=True, conflict=True),
                         snap(state="closed"))
        _, first = self.watch(forge(), "--session", "s1")
        self.assertEqual([l.split()[0] for l in first], ["[watch]", "[settings]", "[conflict]", "[behind]", "[failed]",
                                                         "[manual]", "[review]", "[comment]", "[closed]"])
        _, again = self.watch(forge(), "--session", "s1")
        self.assertEqual([l.split()[0] for l in again], ["[watch]", "[settings]", "[closed]"])
        self.assertTrue(again[0].startswith(f"[watch] resumed {URL}"))

    def test_once_has_no_settings_line_and_ends_after_one_poll(self):
        code, lines = self.watch(Forge(snap(), snap()), "--once")
        self.assertEqual(code, 0)
        self.assertEqual(len(lines), 1)
        self.assertTrue(lines[0].startswith("[watch] attached "))

    def test_settings_are_told_again_when_they_change(self):
        def change(left):
            if left == 1:
                self.box.settings.write_text(json.dumps({"prBabysit.autoFix": False, "prBabysit.autoRebase": "always",
                                                         "approvals.reply": "post"}))
        _, lines = self.watch(Forge(snap(), snap(state="merged"), before=change), "--session", "s1")
        self.assertEqual(lines[1:], [
            self.SETTINGS_LINE,
            "[settings] auto-fix off: ask before fixing any comment, auto rebase always: rebase whenever behind, "
            "resolving conflicts, replies posted: propose each reply, it posts without asking",
            f"[merged] {URL}"])

    def test_a_fork_and_the_open_comment_count(self):
        s = snap(state="merged", fork=True, comments=[comment("a"), comment("b", author="me"), comment("c", resolved=True)])
        _, lines = self.watch(Forge(s), "--once")
        self.assertIn(", branch feat (from a fork) -> main,", lines[0])
        self.assertIn(", 1 open comment(s),", lines[0])

    def test_stuck_after_on_the_command_line(self):
        _, lines = self.watch(Forge(snap(checks=[chk(4, "t", "e2e", "pending", waited=10)])), "--once", "--stuck-after", "5")
        self.assertEqual(lines[1], "[stuck] e2e (stage t) has waited 10 min for a runner id=4 https://ci/4 | t ⏳")

    def propose_file(self, pid, **fields):
        root = approval.ROOT
        root.mkdir(parents=True, exist_ok=True)
        p = {"id": pid, "kind": "reply", "session": "s1", "pr": {"key": "github.com/u/gad#91"}, "status": "done",
             "title": "Reply to @alice", "result": {"message": "Posted the reply to @alice"}, "reported": False}
        p.update(fields)
        p = {k: v for k, v in p.items() if v is not None}
        (root / f"{pid}.json").write_text(json.dumps(p))
        return root / f"{pid}.json"

    def test_approval_outcomes_are_told_between_polls_and_leave(self):
        f = self.propose_file("1-reply-abc")
        _, lines = self.watch(Forge(snap(), snap(state="merged")), "--session", "s1", "--interval", "15")
        self.assertEqual([l for l in lines if l.startswith("[approval]")],
                         ["[approval] reply 1-reply-abc (Reply to @alice) approved: Posted the reply to @alice"])
        self.assertFalse(f.exists())

    def test_one_malformed_proposal_costs_the_others_nothing(self):
        good = self.propose_file("1-reply-good")
        bad = self.propose_file("2-reply-bad", title=None)
        later = self.propose_file("3-reply-later", title="Reply to @bob", result={"message": "Posted the reply to @bob"})
        with mock.patch.object(approval, "WARNED", set()):
            _, lines = self.watch(Forge(snap(), snap(state="merged")), "--session", "s1", "--interval", "15")
        self.assertEqual([l for l in lines if l.startswith("[approval]")], [
            "[approval] reply 1-reply-good (Reply to @alice) approved: Posted the reply to @alice",
            "[approval] proposal 2-reply-bad can't be read (KeyError: 'title'); dismiss it with approval.py dismiss 2-reply-bad",
            "[approval] reply 3-reply-later (Reply to @bob) approved: Posted the reply to @bob",
        ])
        self.assertEqual((good.exists(), bad.exists(), later.exists()), (False, True, False))

    def test_sys_path_gets_the_scripts_folder_once(self):
        with mock.patch.object(sys, "path", [p for p in sys.path if p != str(SCRIPTS)]):
            for _ in range(3):
                w.approval_outcomes(Forge(), 91, "s1")
            self.watch(Forge(snap(), snap(state="merged")), "--session", "s1", "--interval", "60")
            self.assertEqual(sys.path.count(str(SCRIPTS)), 1)

    def test_an_unreadable_approvals_folder_is_told_once(self):
        with mock.patch.object(approval, "outcomes", side_effect=OSError("Permission denied")):
            self.assertEqual(w.approval_outcomes(Forge(), 91, "s1"), ["couldn't read the approvals folder: Permission denied"])
            self.assertEqual(w.approval_outcomes(Forge(), 91, "s1"), [])

    def test_api_errors_and_bad_shapes_are_retried(self):
        for error in (w.ApiError("down"), KeyError("head"), ValueError("bad json")):
            code, lines = self.watch(Forge(error, snap(state="merged")), "--session", "s1")
            self.assertEqual((code, lines[-1]), (0, f"[merged] {URL}"), error)

    def test_odd_shapes_and_disk_errors_are_retried_too(self):
        for error in (TypeError("'NoneType' object is not subscriptable"), AttributeError("'NoneType' object has no attribute 'get'"),
                      IndexError("list index out of range"), OSError("No space left on device")):
            code, lines = self.watch(Forge(error, snap(state="merged")), "--session", "s1")
            self.assertEqual((code, lines[-1]), (0, f"[merged] {URL}"), error)

    def test_a_state_file_that_cant_be_written_is_retried(self):
        with mock.patch.object(w, "save_state", side_effect=[OSError("Read-only file system"), None]):
            code, lines = self.watch(Forge(snap(), snap(state="merged")), "--session", "s1", "--interval", "15")
        self.assertEqual((code, lines[-1]), (0, f"[merged] {URL}"))

    def test_an_auth_error_mid_watch_ends_it(self):
        code, lines = self.watch(Forge(snap(), w.AuthError("HTTP 401: Bad credentials")), "--session", "s1", "--interval", "15")
        self.assertEqual((code, lines[-1]), (2, "[auth] log in (HTTP 401: Bad credentials)"))


if __name__ == "__main__":
    unittest.main()
