"""ticket-guard.py, the PreToolUse hook on the tracker's write tools: in a
session the hub started for a ticket it allows one move and edits that set
only the assignee, and it never blocks a call on its own error."""

import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

HOOK = Path(__file__).resolve().parents[1] / "hooks/ticket-guard.py"
HANDOFF = """From the hub: Ask through AskUserQuestion.
Ticket: ENG-412 (jira)
Link: https://acme.atlassian.net/browse/ENG-412
Site: https://acme.atlassian.net
Assign to: account 5b10ac8d82e05b22cc7d4ef5 (Jane Doe)
Unassigned: yes
Started column: In Progress (status ids 3, 10001)
Board: Payments, Sprint 42
Folder: ~/projects
My prompt:
/dominus:ticket-work https://acme.atlassian.net/browse/ENG-412"""
MOVE = {"cloudId": "https://acme.atlassian.net", "issueIdOrKey": "ENG-412", "transition": {"id": "21"}}
ASSIGN = {"accountId": "5b10ac8d82e05b22cc7d4ef5"}


class Guard(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.tmp = Path(tmp.name)
        self.logs = self.tmp / "logs"
        self.env = {k: v for k, v in os.environ.items() if k != "CLAUDE_CODE_SESSION_ID"}
        self.env.update(XDG_RUNTIME_DIR=str(self.tmp / "run"), AGENT_HUB_LOG_DIR=str(self.logs))
        self.transcript = self.tmp / "session.jsonl"
        self.start(HANDOFF)

    def start(self, prompt):
        """A transcript as Claude writes it: a meta caveat, then the first prompt."""
        self.transcript.write_text("".join(json.dumps(e) + "\n" for e in [
            {"type": "user", "isMeta": True, "message": {"role": "user", "content": "Caveat: local commands"}},
            {"type": "user", "message": {"role": "user", "content": prompt}},
        ]))

    def result(self, tool_use_id, error):
        entry = {"type": "user", "message": {"role": "user", "content": [
            {"type": "tool_result", "tool_use_id": tool_use_id, "is_error": error, "content": "done"}]}}
        with open(self.transcript, "a") as f:
            f.write(json.dumps(entry) + "\n")

    def run_hook(self, stdin):
        r = subprocess.run([str(HOOK)], input=stdin, env=self.env, capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)
        return json.loads(r.stdout) if r.stdout.strip() else None

    def hook(self, tool, tool_input, session="s1", tool_use_id="toolu_1"):
        return self.run_hook(json.dumps({
            "hook_event_name": "PreToolUse", "session_id": session, "transcript_path": str(self.transcript),
            "tool_name": tool, "tool_input": tool_input, "tool_use_id": tool_use_id}))

    def assertDenied(self, out, says):
        self.assertIsNotNone(out)
        decision = out["hookSpecificOutput"]
        self.assertEqual(decision["hookEventName"], "PreToolUse")
        self.assertEqual(decision["permissionDecision"], "deny")
        self.assertIn(says, decision["permissionDecisionReason"])

    def test_other_sessions_are_left_alone(self):
        self.start("fix the flaky tray test")
        self.assertIsNone(self.hook("mcp__atlassian__transitionJiraIssue", MOVE))
        self.assertIsNone(self.hook("mcp__atlassian__transitionJiraIssue", MOVE, tool_use_id="toolu_2"))
        self.assertIsNone(self.hook("mcp__atlassian__editJiraIssue", {"fields": {"summary": "x"}}))

    def test_first_move_allowed_second_denied(self):
        self.assertIsNone(self.hook("mcp__atlassian__transitionJiraIssue", MOVE))
        self.result("toolu_1", error=False)
        out = self.hook("mcp__jira__transitionJiraIssue", {**MOVE, "transition": {"id": "31"}}, tool_use_id="toolu_2")
        self.assertDenied(out, "allows one move")

    def test_moves_are_counted_per_session(self):
        self.assertIsNone(self.hook("mcp__atlassian__transitionJiraIssue", MOVE))
        self.assertIsNone(self.hook("mcp__atlassian__transitionJiraIssue", MOVE, session="s2", tool_use_id="toolu_2"))

    def test_a_failed_move_does_not_use_up_the_move(self):
        self.assertIsNone(self.hook("mcp__atlassian__transitionJiraIssue", MOVE))
        self.result("toolu_1", error=True)
        self.assertIsNone(self.hook("mcp__atlassian__transitionJiraIssue", MOVE, tool_use_id="toolu_2"))
        self.result("toolu_2", error=False)
        self.assertDenied(self.hook("mcp__atlassian__transitionJiraIssue", MOVE, tool_use_id="toolu_3"), "one move")

    def test_a_move_through_execute_write_counts(self):
        self.assertIsNone(self.hook("mcp__atlassian__transitionJiraIssue", MOVE))
        out = self.hook("mcp__atlassian__executeWrite", {"toolName": "transitionJiraIssue", "arguments": MOVE},
                        tool_use_id="toolu_2")
        self.assertDenied(out, "one move")

    def test_assignee_only_edit_allowed(self):
        for args in ({"cloudId": "acme", "issueIdOrKey": "ENG-412", "fields": {"assignee": ASSIGN}},
                     {"issueIdOrKey": "ENG-412", "assignee": ASSIGN},
                     {"issueIdOrKey": "ENG-412", "fields": json.dumps({"assignee": ASSIGN})}):
            with self.subTest(args=args):
                self.assertIsNone(self.hook("mcp__atlassian__editJiraIssue", args))

    def test_edit_with_other_fields_denied(self):
        for args in ({"issueIdOrKey": "ENG-412", "fields": {"assignee": ASSIGN, "summary": "Retry payouts"}},
                     {"issueIdOrKey": "ENG-412", "summary": "Retry payouts"},
                     {"issueIdOrKey": "ENG-412", "update": {"summary": [{"set": "Retry payouts"}]}}):
            with self.subTest(args=args):
                self.assertDenied(self.hook("mcp__atlassian__editJiraIssue", args), "summary")

    def test_other_tools_pass(self):
        self.assertIsNone(self.hook("mcp__atlassian__executeWrite", {"toolName": "lookupJiraAccountId"}))

    def test_malformed_input_allowed_and_logged(self):
        self.assertIsNone(self.run_hook("{not json"))
        self.assertIn("WARN ticket_guard: check failed", (self.logs / "ticket_guard.log").read_text())

    def test_missing_transcript_allowed(self):
        self.transcript.unlink()
        self.assertIsNone(self.hook("mcp__atlassian__transitionJiraIssue", MOVE))


if __name__ == "__main__":
    unittest.main()
