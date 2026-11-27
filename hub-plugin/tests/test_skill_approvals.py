"""review's and test's own approval.py, on agent_hub.approvals: a reviewer's
PR comment posts on its line only once approved, and a tester's Jira comment
is handed back, as approved, for the tester to post. GitHub is a fake `gh` on
PATH that logs its calls."""

import contextlib
import importlib.util
import io
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
SKILLS = HERE.parent / "skills"
FAKE_GH = (HERE / "fixtures/pr_babysit/fake_gh_argv.py").read_text()
URL = "https://github.com/u/gad/pull/91"
TICKET = "https://acme.atlassian.net/browse/ENG-412"


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


review = load("review_approval", SKILLS / "review/scripts/approval.py")
tester = load("test_approval", SKILLS / "test/scripts/approval.py")
A = review.A


class Store(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.tmp = Path(tmp.name)
        bin_ = self.tmp / "bin"
        bin_.mkdir()
        for cli in ("gh", "glab"):
            (bin_ / cli).write_text(FAKE_GH)
            (bin_ / cli).chmod(0o755)
        self.log = self.tmp / "gh.log"
        self.replies = self.tmp / "replies.json"
        env = mock.patch.dict(os.environ, {"PATH": f"{bin_}:{os.environ['PATH']}", "FAKE_LOG": str(self.log),
                                           "FAKE_REPLIES": str(self.replies), "CLAUDE_CODE_SESSION_ID": "claude-1"})
        env.start()
        self.addCleanup(env.stop)
        for name, value in (("ROOT", self.tmp / "approvals"), ("LOG", self.tmp / "approvals" / "log.jsonl")):
            p = mock.patch.object(A, name, value)
            p.start()
            self.addCleanup(p.stop)

    def reply(self, replies):
        self.replies.write_text(json.dumps(replies))

    def posts(self):
        if not self.log.exists():
            return []
        return [c for c in (json.loads(line) for line in self.log.read_text().splitlines()) if "POST" in c]

    def cli(self, script, *argv):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = script.main(list(argv))
        return code, out.getvalue().strip()


class ReviewComments(Store):
    def test_a_comment_waits_then_posts_on_its_line_at_the_head_it_was_read_on(self):
        self.reply({"repos/u/gad/pulls/91": {"head": {"sha": "abc1234def"}}})
        code, out = self.cli(review, "propose", "comment", URL, "--session", "review-91", "--path", "src/auth.py",
                             "--line", "42", "--body", "[nit] Use `Car.Ferrari`.")
        self.assertEqual(code, 0, out)
        self.assertTrue(out.startswith("[proposed] "), out)
        pid = out.split()[1]
        p = A.load(pid)
        self.assertEqual((p["title"], p["comment"]), ("Comment on src/auth.py:42", {"path": "src/auth.py", "line": 42, "side": "RIGHT", "sha": "abc1234def"}))
        self.assertEqual(p["script"], str((SKILLS / "review/scripts/approval.py").resolve()), "the tray runs review's own script")
        self.assertFalse(self.posts(), "nothing posted before approval")
        edit = self.tmp / "edit.txt"
        edit.write_text("[nit] `Car.Ferrari`, not `'ferrari'`.\n")
        self.assertEqual(self.cli(review, "approve", pid, "--body-file", str(edit))[0], 0)
        post = self.posts()[0]
        self.assertIn("repos/u/gad/pulls/91/comments", post)
        for field in ("commit_id=abc1234def", "path=src/auth.py", "side=RIGHT", "line=42", "body=[nit] `Car.Ferrari`, not `'ferrari'`."):
            self.assertIn(field, post)
        self.assertEqual(A.load(pid)["status"], "done")

    def test_a_rejected_comment_posts_nothing(self):
        self.reply({"repos/u/gad/pulls/91": {"head": {"sha": "abc"}}})
        _, out = self.cli(review, "propose", "comment", URL, "--session", "r", "--path", "a.py", "--line", "1", "--body", "x")
        self.assertEqual(self.cli(review, "reject", out.split()[1])[0], 0)
        self.assertFalse(self.posts())

    def test_a_comment_needs_its_place(self):
        with self.assertRaises(SystemExit):
            self.cli(review, "propose", "comment", URL, "--session", "r", "--path", "src/auth.py", "--body", "x")
        with self.assertRaises(SystemExit):
            self.cli(review, "propose", "comment", URL, "--session", "r", "--path", "a.py", "--line", "3", "--side", "UP", "--body", "x")
        with self.assertRaises(SystemExit):
            self.cli(review, "propose", "push", URL, "--session", "r")


class JiraComment(Store):
    def test_it_waits_then_is_handed_back_with_the_approved_text(self):
        shot = self.tmp / "01-upload.png"
        shot.write_bytes(b"png")
        code, out = self.cli(tester, "propose", "jira", TICKET, "--session", "test-ENG-412",
                             "--body", "Tested on 3f9a1c2: 12/12 pass.", "--image", str(shot))
        self.assertEqual(code, 0, out)
        pid = out.split()[1]
        p = A.load(pid)
        self.assertEqual((p["title"], p["images"], p["pr"]["key"]), ("Comment on ENG-412 with 1 screenshot", [str(shot)], "jira:ENG-412"))
        edit = self.tmp / "edit.txt"
        edit.write_text("Tested on 3f9a1c2: all 12 cases pass.\n")
        code, out = self.cli(tester, "approve", pid, "--body-file", str(edit))
        self.assertEqual(code, 0, out)
        self.assertFalse(self.log.exists(), "the hub posts nothing to Jira itself")
        p = A.load(pid)
        self.assertEqual((p["status"], p["body"]), ("handed", "Tested on 3f9a1c2: all 12 cases pass."))
        self.assertEqual(self.cli(tester, "dismiss", pid)[0], 0, "the tester clears it once posted")
        self.assertIsNone(A.load(pid))

    def test_it_needs_a_ticket_and_its_screenshots(self):
        with self.assertRaises(SystemExit):
            self.cli(tester, "propose", "jira", URL, "--session", "t", "--body", "x")
        with self.assertRaises(SystemExit):
            self.cli(tester, "propose", "jira", TICKET, "--session", "t", "--body", "x", "--image", str(self.tmp / "gone.png"))


if __name__ == "__main__":
    unittest.main()
